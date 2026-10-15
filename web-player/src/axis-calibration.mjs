import { BABOT_PROTOCOL, DEFAULT_MOUNTING_CALIBRATION, carPoseToFirmwarePose, validateMountingCalibration } from './protocol.mjs';
/** @typedef {import('./protocol.mjs').MountingCalibration} MountingCalibration */

export const AXIS_CALIBRATION_PROFILE = Object.freeze({
  amplitudeDegrees: 1,
  levelSeconds: 0.3,
  rampSeconds: 0.7,
  holdSeconds: 1,
  durationSeconds: 3,
});

const smoothstep = (x) => x * x * (3 - 2 * x);

/** One positive car-axis pulse, with zero slope at each ramp boundary. */
export function sampleAxisCalibration(axis, elapsedSeconds) {
  if (axis !== 'roll' && axis !== 'pitch') throw new Error('Select roll or pitch calibration');
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) throw new Error('Invalid calibration clock');
  const t = elapsedSeconds;
  let amount = 0;
  let phase = 'level';
  if (t >= 3) phase = 'complete';
  else if (t >= 2.7) phase = 'level';
  else if (t >= 2) { amount = 1 - smoothstep((t - 2) / 0.7); phase = 'ramp-down'; }
  else if (t >= 1) { amount = 1; phase = 'hold'; }
  else if (t >= 0.3) { amount = smoothstep((t - 0.3) / 0.7); phase = 'ramp-up'; }
  return { roll: axis === 'roll' ? amount : 0, pitch: axis === 'pitch' ? amount : 0, complete: t >= 3, phase };
}

// Components are physical [right side down, nose down], viewed from behind.
const DIRECTIONS = Object.freeze({
  'right-down': [1, 0],
  'left-down': [-1, 0],
  'nose-down': [0, 1],
  'nose-up': [0, -1],
});

/**
 * Correct a signed quarter-turn/axis inversion observed during two positive
 * pulses under the SAME base mounting. Non-cardinal motion needs another check.
 * The candidate remains unverified until the user confirms its physical result.
 * @param {{rollDirection?:string,pitchDirection?:string}} [observations]
 * @param {MountingCalibration} [base]
 */
export function deriveMountingCalibration({ rollDirection, pitchDirection } = {}, base = DEFAULT_MOUNTING_CALIBRATION) {
  const config = validateMountingCalibration(base);
  const rollObserved = DIRECTIONS[rollDirection];
  const pitchObserved = DIRECTIONS[pitchDirection];
  if (!rollObserved || !pitchObserved || rollObserved[0] * pitchObserved[0] + rollObserved[1] * pitchObserved[1] !== 0) {
    throw new Error('Observe one distinct physical axis for each test; mixed or repeated axes cannot determine calibration');
  }
  // The observation matrix has those two unit-vector columns. Its inverse is
  // its transpose, so compose baseTransform * observationTranspose.
  const first = carPoseToFirmwarePose({ roll: rollObserved[0], pitch: pitchObserved[0] }, 1, config);
  const second = carPoseToFirmwarePose({ roll: rollObserved[1], pitch: pitchObserved[1] }, 1, config);
  let angleDegrees = Math.atan2(first.pitch, first.roll) * 180 / Math.PI;
  angleDegrees = Math.round(angleDegrees * 1e10) / 1e10;
  if (Object.is(angleDegrees, -0)) angleDegrees = 0;
  return validateMountingCalibration({
    angleDegrees,
    invertRoll: false,
    invertPitch: first.roll * second.pitch - first.pitch * second.roll < 0,
    verified: false,
  });
}

/**
 * An explicit, bounded session over the existing serial transport. The caller
 * pauses playback first, forwards serial phases to updateStatus(), and cancels
 * on page hiding, disconnect, source changes, or any user stop. No auto-retry.
 */
export class AxisCalibrationSession {
  constructor(controller, options = {}) {
    this.controller = controller;
    this.now = options.now ?? (() => performance.now());
    this.setTimer = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimeout ?? ((id) => clearTimeout(id));
    this.current = null;
    this.disposed = false;
  }

  get isRunning() { return this.current !== null; }

  /** @param {'roll'|'pitch'} axis @param {MountingCalibration} [mounting] */
  run(axis, mounting = DEFAULT_MOUNTING_CALIBRATION) {
    if (this.disposed) throw new Error('Calibration session disposed');
    if (this.current) throw new Error('Wait for the current axis check and level return');
    sampleAxisCalibration(axis, 0);
    const config = validateMountingCalibration(mounting);
    const startedAt = this.now();
    if (!Number.isFinite(startedAt)) throw new Error('Invalid calibration clock');
    let resolve;
    const result = new Promise((done) => { resolve = done; });
    const run = { axis, mounting: config, startedAt, epoch: null, lastSampleAt: null, timer: null, finishing: false, cancelled: false, cancelReason: null, resolve, result };
    this.current = run;
    run.timer = this.setTimer(() => { void this.finish(run, false, 'Axis check could not start'); }, 2000);
    // Install the run before a transport can synchronously emit its status.
    Promise.resolve().then(() => {
      if (this.current !== run || run.finishing) return;
      return this.controller.start(() => this.poseFor(run));
    }).then(() => {
      if (this.current === run && !run.finishing) void this.finish(run, false, 'Axis check ended before completion');
    }, (error) => { void this.finish(run, false, error instanceof Error ? error.message : 'Axis check failed'); });
    return result;
  }

  updateStatus(phase) {
    const run = this.current;
    if (!run) return;
    // A fault during the level return also invalidates the observation, even if
    // a later OFF confirms that the mechanism eventually stopped.
    if (['fault', 'disconnected'].includes(phase)) {
      void this.finish(run, false, 'Controller stopped the axis check');
      return;
    }
    if (run.finishing) return;
    if (phase === 'following' && run.epoch === null) {
      const now = this.now();
      if (!Number.isFinite(now) || now < run.startedAt) { void this.finish(run, false, 'Invalid calibration clock'); return; }
      run.epoch = now;
      run.lastSampleAt = now;
      this.clearTimer(run.timer);
      run.timer = this.setTimer(() => { void this.finish(run, true, 'Axis check complete · return to level'); }, AXIS_CALIBRATION_PROFILE.durationSeconds * 1000);
    } else if (phase === 'stopped') {
      void this.finish(run, false, 'Controller stopped the axis check');
    }
  }

  poseFor(run) {
    if (this.current !== run || run.finishing) return null;
    const now = this.now();
    if (!Number.isFinite(now) || now < run.startedAt
      || (run.lastSampleAt !== null && (now < run.lastSampleAt || now - run.lastSampleAt >= BABOT_PROTOCOL.staleSampleMs))) {
      void this.finish(run, false, 'Axis check clock stalled · motion stopped');
      return null;
    }
    // Until ARM succeeds, preflight checks may obtain only a fresh level pose.
    const sample = sampleAxisCalibration(run.axis, run.epoch === null ? 0 : (now - run.epoch) / 1000);
    if (sample.complete) { void this.finish(run, true, 'Axis check complete · return to level'); return null; }
    if (run.epoch !== null) run.lastSampleAt = now;
    return { ...carPoseToFirmwarePose(sample, 1, run.mounting), sampledAt: now };
  }

  finish(run, completed, reason) {
    if (this.current !== run) return run.result;
    // STOP/OFF may still be pending after the pulse deadline. An external
    // cancellation must revoke success during that wait, not just stop motion.
    if (!completed) { run.cancelled = true; run.cancelReason = reason; }
    if (run.finishing) return run.result;
    if (completed) {
      const now = this.now();
      completed = Number.isFinite(now) && run.epoch !== null && run.lastSampleAt !== null
        && now >= run.epoch + AXIS_CALIBRATION_PROFILE.durationSeconds * 1000
        && now >= run.lastSampleAt && now - run.lastSampleAt < BABOT_PROTOCOL.staleSampleMs;
      if (!completed) reason = 'Axis check clock stalled · motion stopped';
    }
    run.finishing = true;
    this.clearTimer(run.timer);
    Promise.resolve().then(() => this.controller.stop(reason)).then((stop) => {
      if (this.current === run) this.current = null;
      run.resolve({ completed: completed && !run.cancelled && Boolean(stop.offConfirmed), offConfirmed: Boolean(stop.offConfirmed), reason: run.cancelReason ?? reason });
    }, (error) => {
      if (this.current === run) this.current = null;
      run.resolve({ completed: false, offConfirmed: false, reason: error instanceof Error ? error.message : reason });
    });
    return run.result;
  }

  cancel(reason = 'Axis check cancelled · motion stopped') {
    const run = this.current;
    return run ? this.finish(run, false, reason) : Promise.resolve({ completed: false, offConfirmed: false, reason });
  }

  dispose() {
    this.disposed = true;
    return this.cancel('Axis check closed · motion stopped');
  }
}
