import { BABOT_CONNECTION_LOCK } from './connection-manager.mjs';

/** Holds the player's exclusive USB lease across both bootloader and runtime ports. */
export class SetupUsbLease {
  constructor(locks = globalThis.navigator?.locks) {
    this.locks = locks;
    this.disposed = false;
    this.release = null;
    this.pending = null;
  }

  acquire() {
    if (this.disposed) return Promise.resolve(false);
    if (this.release) return Promise.resolve(true);
    if (this.pending) return this.pending;
    if (!this.locks?.request) return Promise.reject(new Error('USB ownership coordination is unavailable in this browser.'));
    let resolveClaim, rejectClaim;
    const claim = new Promise((resolve, reject) => { resolveClaim = resolve; rejectClaim = reject; });
    // Skip an abandoned StrictMode effect before requesting the lock.
    Promise.resolve().then(() => {
      if (this.disposed) { resolveClaim(false); return; }
      return this.locks.request(BABOT_CONNECTION_LOCK, { mode: 'exclusive', ifAvailable: true }, async lock => {
        if (!lock || this.disposed) { resolveClaim(false); return; }
        const held = new Promise(resolve => { this.release = resolve; });
        resolveClaim(true);
        await held;
      });
    }).catch(rejectClaim);
    const operation = claim.finally(() => { if (this.pending === operation) this.pending = null; });
    this.pending = operation;
    return operation;
  }

  /** Retain the lease if closing fails; another tab must not open a live port. */
  async close(closePort) {
    const result = await closePort();
    if (result === false || result?.closed === false) throw new Error('BaBot USB port closure was not confirmed.');
    const release = this.release;
    this.release = null;
    release?.();
    return true;
  }

  dispose(closePort) {
    this.disposed = true;
    return this.close(closePort);
  }
}
