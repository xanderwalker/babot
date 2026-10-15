import test from 'node:test';
import assert from 'node:assert/strict';
import { motionAmplitudes, readMountingCalibration, saveMountingCalibration, MOUNTING_STORAGE_KEY } from '../src/motion-settings.mjs';

test('physical strength preserves the chassis roll/pitch balance and cannot amplify above it', () => {
  assert.deepEqual(motionAmplitudes(.25), { roll: 2, pitch: .75 });
  assert.deepEqual(motionAmplitudes(1), { roll: 8, pitch: 3 });
  assert.deepEqual(motionAmplitudes(99), { roll: 8, pitch: 3 });
  for (const invalid of [NaN, Infinity, -1, '1']) assert.deepEqual(motionAmplitudes(invalid), { roll: 0, pitch: 0 });
});

test('missing, invalid, blocked and outdated calibration storage always starts unverified', () => {
  for (const value of [null, '{', '{}', '{"version":2}', '{"version":1,"mounting":{"verified":true}}']) {
    assert.equal(readMountingCalibration({ getItem: () => value }).verified, false);
  }
  assert.equal(readMountingCalibration({ getItem() { throw new Error('blocked'); } }).verified, false);
});

test('validated mounting persists without storing playback intent or motion strength', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const mounting = { angleDegrees: 135, invertRoll: false, invertPitch: true, verified: true };
  saveMountingCalibration(storage, mounting);
  assert.deepEqual(readMountingCalibration(storage), mounting);
  assert.deepEqual(Object.keys(JSON.parse(values.get(MOUNTING_STORAGE_KEY))).sort(), ['mounting', 'version']);
});
