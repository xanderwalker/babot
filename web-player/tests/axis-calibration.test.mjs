import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_MOUNTING_CALIBRATION, carPoseToFirmwarePose } from '../src/protocol.mjs';
import { AXIS_CALIBRATION_PROFILE, AxisCalibrationSession, deriveMountingCalibration, sampleAxisCalibration } from '../src/axis-calibration.mjs';

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const flush = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };

test('each isolated pulse stays within one degree, ramps smoothly, and finishes level', () => {
  assert.equal(AXIS_CALIBRATION_PROFILE.durationSeconds, 3);
  for (const axis of ['roll', 'pitch']) {
    let previous = null;
    for (let i = 0; i <= 3500; i++) {
      const sample = sampleAxisCalibration(axis, i / 1000);
      assert.equal(sample[axis === 'roll' ? 'pitch' : 'roll'], 0);
      assert.ok(sample[axis] >= 0 && sample[axis] <= 1);
      if (previous !== null) assert.ok(Math.abs(sample[axis] - previous) < 0.00215, 'bounded smooth ramp');
      previous = sample[axis];
    }
    for (const t of [0, 0.3, 2.7, 3, 10]) near(sampleAxisCalibration(axis, t)[axis], 0);
    for (const t of [1, 1.5, 2]) near(sampleAxisCalibration(axis, t)[axis], 1);
    assert.equal(sampleAxisCalibration(axis, 3).complete, true);
    for (const boundary of [0.3, 1, 2, 2.7]) {
      const before = sampleAxisCalibration(axis, boundary - 1e-5)[axis];
      const after = sampleAxisCalibration(axis, boundary + 1e-5)[axis];
      assert.ok(Math.abs(after - before) < 1e-8, 'zero velocity at ramp boundary');
    }
  }
  for (const t of [-1, NaN, Infinity]) assert.throws(() => sampleAxisCalibration('roll', t), /clock/);
  assert.throws(() => sampleAxisCalibration('yaw', 0), /roll or pitch/);
});

test('observed normal, reversed, quarter-turn, and mirrored axes produce the known corrections', () => {
  const cases = [
    ['right-down', 'nose-down', 45, false],
    ['left-down', 'nose-up', -135, false],
    ['nose-down', 'left-down', -45, false],
    ['nose-up', 'right-down', 135, false],
    ['right-down', 'nose-up', 45, true],
    ['left-down', 'nose-down', -135, true],
    ['nose-down', 'right-down', 135, true],
    ['nose-up', 'left-down', -45, true],
  ];
  for (const [rollDirection, pitchDirection, angleDegrees, invertPitch] of cases) {
    assert.deepEqual(deriveMountingCalibration({ rollDirection, pitchDirection }), { angleDegrees, invertRoll: false, invertPitch, verified: false });
  }
  for (const observations of [{}, { rollDirection: 'unknown', pitchDirection: 'nose-down' }, { rollDirection: 'nose-up', pitchDirection: 'nose-down' }]) {
    assert.throws(() => deriveMountingCalibration(observations), /distinct physical axis/);
  }
});

test('correction composes with the mounting actually used for the observations', () => {
  const base = { angleDegrees: -30, invertRoll: true, invertPitch: false, verified: true };
  const corrected = deriveMountingCalibration({ rollDirection: 'nose-down', pitchDirection: 'right-down' }, base);
  // These observations swap the two old inputs. New roll must equal old pitch,
  // and new pitch must equal old roll, regardless of existing angle/inversions.
  const newRoll = carPoseToFirmwarePose({ roll: 1, pitch: 0 }, 1, corrected);
  const oldPitch = carPoseToFirmwarePose({ roll: 0, pitch: 1 }, 1, base);
  const newPitch = carPoseToFirmwarePose({ roll: 0, pitch: 1 }, 1, corrected);
  const oldRoll = carPoseToFirmwarePose({ roll: 1, pitch: 0 }, 1, base);
  near(newRoll.roll, oldPitch.roll); near(newRoll.pitch, oldPitch.pitch);
  near(newPitch.roll, oldRoll.roll); near(newPitch.pitch, oldRoll.pitch);
  assert.equal(corrected.verified, false);
});

function harness({ offConfirmed = true, deferStop = false } = {}) {
  let now = 0, timerId = 0, getPose, endRun, releaseStop;
  const timers = new Map();
  const calls = { starts: 0, stops: 0 };
  const controller = {
    start(sample) { calls.starts++; getPose = sample; return new Promise((resolve) => { endRun = resolve; }); },
    async stop() {
      calls.stops++;
      if (deferStop) await new Promise((resolve) => { releaseStop = resolve; });
      endRun?.();
      return { acknowledged: true, offConfirmed };
    },
  };
  const session = new AxisCalibrationSession(controller, {
    now: () => now,
    setTimeout: (fn, ms) => { timers.set(++timerId, { fn, at: now + ms }); return timerId; },
    clearTimeout: (id) => timers.delete(id),
  });
  return { session, calls, sample: () => getPose?.(), release: () => releaseStop?.(),
    setNow: (value) => { now = value; },
    advance: (ms) => {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
    },
  };
}

test('axis session stays level before ARM, freezes mounting, and completes only after OFF', async () => {
  const h = harness({ deferStop: true });
  const mounting = { ...DEFAULT_MOUNTING_CALIBRATION, angleDegrees: 0 };
  const result = h.session.run('roll', mounting);
  mounting.angleDegrees = 90;
  await flush();
  h.advance(500);
  assert.deepEqual(h.sample(), { roll: 0, pitch: 0, sampledAt: 500 });
  h.session.updateStatus('following');
  let peak = 0;
  for (let i = 0; i < 149; i++) {
    h.advance(20);
    const pose = h.sample();
    near(pose.pitch, 0);
    assert.ok(Math.hypot(pose.roll, pose.pitch) <= 1);
    peak = Math.max(peak, pose.roll);
  }
  assert.equal(peak, 1);
  h.advance(20);
  await flush();
  assert.equal(h.sample(), null);
  assert.equal(h.calls.stops, 1);
  assert.equal(h.session.isRunning, true, 'return confirmation retains the lock');
  assert.throws(() => h.session.run('pitch'), /Wait/);
  h.release();
  const done = await result;
  assert.equal(done.completed, true);
  assert.equal(done.offConfirmed, true);
  assert.equal(h.session.isRunning, false);
});

test('cancel before start or during a pulse never leaves a reusable stale pose', async () => {
  const immediate = harness();
  const immediateResult = immediate.session.run('roll');
  await immediate.session.cancel();
  assert.equal((await immediateResult).completed, false);
  assert.equal(immediate.calls.starts, 0);
  const h = harness();
  const result = h.session.run('pitch');
  await flush();
  h.session.updateStatus('following');
  h.advance(100);
  assert.ok(h.sample());
  await h.session.cancel();
  assert.equal(h.sample(), null);
  assert.equal((await result).completed, false);
  assert.equal(h.calls.stops, 1);
});

test('external cancellation or fault while waiting for OFF revokes a completed pulse observation', async () => {
  for (const action of ['cancel', 'fault', 'disconnected', 'dispose']) {
    const h = harness({ deferStop: true });
    const result = h.session.run('roll');
    await flush();
    h.session.updateStatus('following');
    for (let i = 0; i < 149; i++) { h.advance(20); h.sample(); }
    h.advance(20);
    await flush();
    assert.equal(h.calls.stops, 1);
    assert.equal(h.session.isRunning, true, 'natural completion still awaits OFF');
    if (action === 'cancel') void h.session.cancel('External stop');
    else if (action === 'dispose') void h.session.dispose();
    else h.session.updateStatus(action);
    h.release();
    const done = await result;
    assert.equal(done.offConfirmed, true, action);
    assert.equal(done.completed, false, action);
    assert.equal(h.calls.stops, 1, 'reuse the pending STOP instead of issuing another');
  }
});

test('stale, regressed, and nonfinite clocks stop without automatic restart', async () => {
  for (const badTime of [180, -1, NaN, Infinity]) {
    const h = harness();
    const result = h.session.run('roll');
    await flush();
    h.session.updateStatus('following');
    assert.ok(h.sample());
    h.setNow(badTime);
    assert.equal(h.sample(), null);
    const done = await result;
    assert.equal(done.completed, false);
    h.setNow(500);
    h.session.updateStatus('following');
    assert.equal(h.sample(), null);
    assert.equal(h.calls.starts, 1);
  }
});

test('startup timeout, controller fault, late deadline and unconfirmed OFF cannot mark calibration complete', async () => {
  for (const mode of ['startup-timeout', 'fault', 'late-deadline', 'off-missing']) {
    const h = harness({ offConfirmed: mode !== 'off-missing' });
    const result = h.session.run('roll');
    await flush();
    if (mode === 'startup-timeout') h.advance(2000);
    else {
      h.session.updateStatus('following');
      if (mode === 'fault') h.session.updateStatus('fault');
      else if (mode === 'late-deadline') h.advance(4000);
      else for (let i = 0; i < 150; i++) { h.advance(20); h.sample(); }
    }
    assert.equal((await result).completed, false, mode);
    assert.equal(h.calls.stops, 1, mode);
  }
});

test('invalid configuration cannot arm and disposal permanently prevents new tests', async () => {
  const h = harness();
  assert.throws(() => h.session.run('roll', { ...DEFAULT_MOUNTING_CALIBRATION, angleDegrees: NaN }), /mounting/);
  assert.equal(h.calls.starts, 0);
  const result = h.session.run('pitch');
  await flush();
  await h.session.dispose();
  assert.equal((await result).completed, false);
  assert.throws(() => h.session.run('roll'), /disposed/);
});
