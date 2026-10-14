import { BABOT_PROTOCOL } from './protocol.mjs';

/** Owns playback intent; the serial controller still owns every wire command. */
export class PlaybackSession {
  /**
   * @param {{start: (getPose: () => {roll:number,pitch:number,sampledAt:number}|null) => Promise<void>, stop: (reason?: string) => Promise<{acknowledged:boolean,offConfirmed:boolean}>}} controller
   * @param {() => {roll:number,pitch:number,sampledAt:number}|null} getPose
   * @param {(error: Error) => void} [onError]
   */
  constructor(controller, getPose, onError = () => {}) {
    this.controller = controller;
    this.getPose = getPose;
    this.onError = onError;
    this.intent = false;
    this.phase = 'disconnected';
    this.connected = false;
    this.offRequired = false;
    this.runToken = null;
    this.runPromise = null;
    this.stopPromise = null;
    this.disposed = false;
  }

  get wantsMotion() { return this.intent && !this.disposed; }

  play() { if (!this.disposed) this.intent = true; }

  pause(reason = 'Playback paused') {
    this.intent = false;
    return this.stopOnce(reason);
  }

  suspend(reason = 'Waiting for fresh video frames') {
    return this.stopOnce(reason);
  }

  updateStatus(phase, connected, offConfirmed = false) {
    if (this.disposed) return;
    const lostConnection = this.connected && !connected;
    this.phase = phase;
    this.connected = connected;
    if (phase === 'arming' || phase === 'following') this.offRequired = true;
    else if (offConfirmed || (phase === 'ready' && connected)) this.offRequired = false;
    // Fault intent stays revoked even if a later USB reconnect verifies firmware.
    if (phase === 'fault' || lostConnection) this.intent = false;
  }

  fail(error) {
    if (this.disposed) return;
    this.intent = false;
    this.onError(error instanceof Error ? error : new Error(String(error)));
  }

  freshPose() {
    try {
      const pose = this.getPose();
      if (!pose || !Number.isFinite(pose.roll) || !Number.isFinite(pose.pitch) || !Number.isFinite(pose.sampledAt)) return null;
      const age = performance.now() - pose.sampledAt;
      return age >= 0 && age < BABOT_PROTOCOL.staleSampleMs ? pose : null;
    } catch (error) { this.fail(error); return null; }
  }

  tick() {
    if (!this.wantsMotion || !this.connected || this.stopPromise) return;
    if (this.runPromise) {
      if (['arming', 'following'].includes(this.phase) && !this.freshPose()) void this.suspend();
      return;
    }
    if (!['ready', 'stopped'].includes(this.phase) || this.offRequired || !this.freshPose()) return;
    const token = { cancelled: false, started: false };
    this.runToken = token;
    // Install the lock before start() can synchronously publish status updates.
    const task = Promise.resolve().then(async () => {
      if (!this.wantsMotion || token.cancelled) return;
      token.started = true;
      await this.controller.start(() => this.freshPose());
      // A resolved start is not an ARM acknowledgement. It means the whole
      // session ended, possibly after a fault swallowed by the transport.
      if (!token.cancelled && this.wantsMotion && !['stopped', 'stopping'].includes(this.phase)) this.intent = false;
    }).catch((error) => this.fail(error)).finally(() => {
      if (this.runToken === token) { this.runToken = null; this.runPromise = null; }
    });
    this.runPromise = task;
  }

  stopOnce(reason) {
    if (this.stopPromise) return this.stopPromise;
    if (this.runToken?.stopTask) return this.runToken.stopTask;
    if (this.runToken) this.runToken.cancelled = true;
    const mustConfirmOff = this.offRequired;
    if (!this.offRequired && !this.runToken?.started && !['arming', 'following', 'stopping'].includes(this.phase)) {
      return Promise.resolve({ acknowledged: false, offConfirmed: false });
    }
    const task = Promise.resolve().then(() => this.controller.stop(reason)).then((result) => {
      if (result.offConfirmed) this.offRequired = false;
      else if (mustConfirmOff) this.fail(new Error('Firmware OFF was not confirmed; press Play after reconnecting.'));
      return result;
    }).catch((error) => {
      this.fail(error);
      return { acknowledged: false, offConfirmed: false };
    }).finally(() => { if (this.stopPromise === task) this.stopPromise = null; });
    this.stopPromise = task;
    if (this.runToken) this.runToken.stopTask = task;
    return task;
  }

  dispose() {
    const stopped = this.pause('Player closed');
    this.disposed = true;
    return stopped;
  }
}
