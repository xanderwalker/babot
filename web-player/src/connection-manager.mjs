export const BABOT_CONNECTION_LOCK = 'babot-usb-controller-v1';
const CANCELLED = Symbol('cancelled');
const DEFAULT_RETRY_DELAYS = Object.freeze([400, 1200, 3000]);

/** @typedef {'idle'|'claiming'|'connecting'|'retrying'|'ready'|'owned-elsewhere'|'unsupported'|'permission-required'|'port-busy'|'fault'|'close-failed'|'disconnected'|'suspended'|'disposed'} ConnectionPhase */
/** @typedef {{phase:ConnectionPhase,message:string,attempt:number,retryInMs:number,owner:boolean}} ConnectionManagerState */

/** Coordinates connection only. This class never calls ARM/start or sends poses. */
export class ConnectionManager {
  /**
   * @param {{connect:()=>Promise<boolean>,reconnect:()=>Promise<boolean>,disconnect:()=>Promise<unknown>}} controller
   * @param {{locks?:Pick<LockManager,'request'>,onState?:(state:ConnectionManagerState)=>void,onInvalidatePlayback?:(reason:string)=>void,isVisible?:()=>boolean,setTimeout?:(callback:()=>void,delay:number)=>any,clearTimeout?:(id:any)=>void,retryDelaysMs?:number[]}} [options]
   */
  constructor(controller, options = {}) {
    this.controller = controller;
    this.locks = options.locks ?? globalThis.navigator?.locks;
    this.onState = options.onState ?? (() => {});
    this.onInvalidatePlayback = options.onInvalidatePlayback ?? (() => {});
    this.isVisible = options.isVisible ?? (() => !globalThis.document?.hidden);
    this.setTimer = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimeout ?? ((id) => clearTimeout(id));
    this.retryDelays = [...(options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS)];
    this.enabled = false;
    this.disposed = false;
    this.lease = null;
    this.operation = null;
    this.token = null;
    this.closing = null;
    this.closeFailed = false;
    this.closeBeforeRecovery = false;
    this.transportPhase = 'disconnected';
    this.manualRequested = false;
    /** @type {ConnectionManagerState} */
    this.state = { phase: 'idle', message: 'USB disconnected', attempt: 0, retryInMs: 0, owner: false };
  }

  /** @param {ConnectionPhase} phase */
  publish(phase, message, extra = {}) {
    this.state = { phase, message, attempt: 0, retryInMs: 0, owner: Boolean(this.lease), ...extra };
    this.onState(this.state);
  }

  invalidate(reason) { this.onInvalidatePlayback(reason); }

  start() {
    if (this.disposed) return Promise.resolve(false);
    this.enabled = true;
    return this.recover('Checking remembered USB connection');
  }

  recover(reason = 'Checking USB connection') {
    if (this.disposed || !this.enabled) return Promise.resolve(false);
    if (this.lease && ['arming', 'following', 'stopping', 'fault', 'disconnected'].includes(this.transportPhase)) {
      this.closeBeforeRecovery = true;
    }
    this.invalidate(reason);
    if (!this.isVisible()) return Promise.resolve(false);
    return this.begin(false);
  }

  connect() {
    if (this.disposed) return Promise.resolve(false);
    this.enabled = true;
    return this.begin(true);
  }

  begin(manual) {
    if (this.operation) {
      // A wake or a new explicit Connect can race an earlier pagehide/Stop.
      // Wait for that cancelled operation before starting a new generation.
      if (this.token?.cancelled) return this.operation.then(() =>
        this.disposed || !this.enabled ? false : this.begin(manual));
      if (manual) this.manualRequested = true;
      return this.operation;
    }
    this.manualRequested = manual;
    let cancel;
    const token = { cancelled: false, cancellation: new Promise(resolve => { cancel = resolve; }), cancel: () => cancel(CANCELLED) };
    this.token = token;
    const task = this.run(token).finally(() => {
      if (this.operation === task) { this.operation = null; this.manualRequested = false; }
      if (this.token === token) this.token = null;
    });
    this.operation = task;
    return task;
  }

  isCurrent(token) { return this.token === token && !token.cancelled && !this.disposed && this.enabled; }

  async acquire(token) {
    if (this.lease) return true;
    if (!this.locks?.request) {
      this.invalidate('USB ownership coordination unavailable');
      this.publish('unsupported', 'USB ownership coordination is unavailable. Use a browser supporting Web Serial and Web Locks.');
      return false;
    }
    this.publish('claiming', 'Checking which tab owns BaBot USB');
    let resolveClaim;
    const claim = new Promise(resolve => { resolveClaim = resolve; });
    Promise.resolve().then(() => {
      // React StrictMode can mount, dispose, and remount in one task. Do not
      // submit the disposed instance's queued request: even an immediately
      // abandoned grant can temporarily exclude the replacement instance.
      if (!this.isCurrent(token)) { resolveClaim(false); return; }
      return this.locks.request(BABOT_CONNECTION_LOCK, { mode: 'exclusive', ifAvailable: true }, async lock => {
        if (!lock || !this.isCurrent(token)) { resolveClaim(false); return; }
        let release;
        const held = new Promise(resolve => { release = resolve; });
        this.lease = { release };
        resolveClaim(true);
        await held;
      });
    }).catch(error => resolveClaim({ error }));
    const acquired = await Promise.race([claim, token.cancellation]);
    if (!this.isCurrent(token)) return false;
    if (acquired?.error) {
      this.invalidate('USB ownership check failed');
      this.publish('fault', acquired.error instanceof Error ? acquired.error.message : 'USB ownership check failed');
      return false;
    }
    if (!acquired) {
      this.invalidate('Another tab owns BaBot USB');
      this.publish('owned-elsewhere', 'Another tab on this site owns BaBot USB. This tab is read-only. Disconnect it there, then select Connect here.');
    }
    return acquired === true;
  }

  async wait(ms, token) {
    let timer;
    const delay = new Promise(resolve => { timer = this.setTimer(() => resolve(true), ms); });
    const outcome = await Promise.race([delay, token.cancellation]);
    this.clearTimer(timer);
    return outcome === true && this.isCurrent(token);
  }

  async run(token) {
    if ((this.closing || this.closeFailed) && !await (this.closing ?? this.closeAndRelease())) return false;
    let attempt = 0, retry = 0;
    while (this.isCurrent(token)) {
      if (this.closeBeforeRecovery) {
        this.closeBeforeRecovery = false;
        // Runtime faults and wake events can leave firmware returning to level.
        // Reconnect deliberately will not probe that session. Finish its close
        // barrier first, then reuse permission for a fresh connection.
        if (!await this.closeAndRelease()) return false;
      }
      if (!this.isCurrent(token) || !await this.acquire(token)) return false;
      const manual = this.manualRequested;
      this.manualRequested = false;
      this.publish('connecting', manual ? 'Connecting BaBot USB' : 'Checking remembered BaBot USB', { attempt: ++attempt });
      try {
        const connected = await Promise.race([
          Promise.resolve().then(() => manual ? this.controller.connect() : this.controller.reconnect()),
          token.cancellation,
        ]);
        if (!this.isCurrent(token) || connected === CANCELLED) return false;
        // A fault can arrive while getPorts/PING is already pending. Its
        // result must not be mistaken for Ready or missing browser permission.
        if (this.closeBeforeRecovery) throw Object.assign(new Error('BaBot connection changed during verification'), { retryable: true, code: 'transport-error' });
        if (connected) {
          this.manualRequested = false;
          this.transportPhase = 'ready';
          this.publish('ready', 'BaBot USB verified · ready', { attempt });
          return true;
        }
        // A deliberate Connect arriving during an automatic permission lookup
        // may open the chooser once that lookup returns no remembered port.
        if (this.manualRequested) continue;
        this.invalidate('BaBot needs USB permission');
        const closed = await this.closeAndRelease();
        if (closed && this.isCurrent(token)) this.publish('permission-required', 'Select Connect to choose BaBot and grant this site USB access.');
        return false;
      } catch (error) {
        if (!this.isCurrent(token)) return false;
        this.invalidate(error instanceof Error ? error.message : 'BaBot connection failed');
        const code = error?.code;
        const retryable = error?.retryable === true;
        if (retryable && retry < this.retryDelays.length && this.isVisible()) {
          const retryInMs = this.retryDelays[retry++];
          this.publish('retrying', 'BaBot is not ready yet · retrying the USB connection', { attempt, retryInMs });
          if (await this.wait(retryInMs, token)) continue;
          return false;
        }
        const closed = await this.closeAndRelease();
        if (!this.isCurrent(token) || !closed) return false;
        if (code === 'port-busy') this.publish('port-busy', 'BaBot USB is in use by another tab, browser, or application. Close that USB connection, then select Connect here.');
        else if (code === 'unsupported') this.publish('unsupported', error instanceof Error ? error.message : 'This browser cannot connect BaBot USB.');
        else if (code === 'cancelled') this.publish('disconnected', 'USB connection cancelled · select Connect to try again.');
        else if (code === 'permission-denied') this.publish('permission-required', 'USB permission was not granted. Select Connect to try again.');
        else this.publish('fault', error instanceof Error ? error.message : 'BaBot connection failed', { attempt });
        return false;
      }
    }
    return false;
  }

  /** A resolved disconnect is the transport's port-close barrier. */
  closeAndRelease() {
    if (this.closing) return this.closing;
    const task = Promise.resolve().then(() => this.controller.disconnect()).then(result => {
      if (result?.closed === false) throw new Error('BaBot USB port closure was not confirmed');
      const lease = this.lease;
      this.lease = null;
      this.closeFailed = false;
      this.closeBeforeRecovery = false;
      lease?.release();
      return true;
    }).catch(error => {
      // Retain ownership if the transport cannot confirm closure. A second tab
      // must not race a controller that may still be open in this one.
      this.closeFailed = true;
      this.publish('close-failed', error instanceof Error ? error.message : 'BaBot USB port closure failed');
      return false;
    }).finally(() => { if (this.closing === task) this.closing = null; });
    this.closing = task;
    return task;
  }

  async teardown(reason, phase) {
    this.invalidate(reason);
    this.manualRequested = false;
    if (this.token) { this.token.cancelled = true; this.token.cancel(); }
    const closed = await this.closeAndRelease();
    if (closed) this.publish(phase, reason);
    return closed;
  }

  disconnect() {
    this.enabled = false;
    return this.teardown('USB disconnected · automatic recovery disabled', 'disconnected');
  }

  suspend(reason = 'Page hidden · USB connection released') {
    return this.teardown(reason, 'suspended');
  }

  dispose() {
    this.disposed = true;
    this.enabled = false;
    return this.teardown('USB connection closed', 'disposed');
  }

  handleStatus(phase, connected) {
    this.transportPhase = phase;
    if (this.disposed || this.closing || !this.enabled) return;
    if (phase === 'fault' || (phase === 'disconnected' && !connected)) {
      this.invalidate('BaBot connection changed · replay stopped');
      this.closeBeforeRecovery = true;
      if (!this.operation) {
        if (this.isVisible()) void this.recover('Recovering BaBot USB connection');
      }
    }
  }
}
