import test from 'node:test';
import assert from 'node:assert/strict';
import {
  motionAmplitudes, readMountingCalibration, saveMountingCalibration, MOUNTING_STORAGE_KEY,
  MAX_MOUNTING_BACKUP_LENGTH, parseMountingCalibrationBackup,
  restoreMountingCalibrationBackup, serializeMountingCalibrationBackup,
} from '../src/motion-settings.mjs';

const verifiedMounting = Object.freeze({ angleDegrees: 135, invertRoll: false, invertPitch: true, verified: true });
const envelope = (mounting = verifiedMounting) => ({ version: 1, mounting });

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

test('existing v1 storage retains its verified mounting without requiring a new check', () => {
  const historicalV1 = '{"version":1,"mounting":{"angleDegrees":135,"invertRoll":false,"invertPitch":true,"verified":true}}';
  assert.deepEqual(readMountingCalibration({ getItem: () => historicalV1 }), verifiedMounting);
  assert.deepEqual(parseMountingCalibrationBackup(historicalV1), verifiedMounting);
});

test('backup export contains only versioned mounting and round-trips every calibration field', () => {
  const exported = serializeMountingCalibrationBackup({ ...verifiedMounting, strength: .9, wantsMotion: true });
  assert.deepEqual(JSON.parse(exported), envelope());
  assert.deepEqual(parseMountingCalibrationBackup(exported), verifiedMounting);
  assert.equal(Object.isFrozen(parseMountingCalibrationBackup(exported)), true);
});

test('restoring verification requires explicit same-physical-mount confirmation', () => {
  const backup = serializeMountingCalibrationBackup(verifiedMounting);
  for (const samePhysicalMount of [undefined, false, 'true', 1, null]) {
    assert.deepEqual(restoreMountingCalibrationBackup(backup, { samePhysicalMount }), { ...verifiedMounting, verified: false });
  }
  assert.deepEqual(restoreMountingCalibrationBackup(backup, { samePhysicalMount: true }), verifiedMounting);
  const unverified = serializeMountingCalibrationBackup({ ...verifiedMounting, verified: false });
  assert.equal(restoreMountingCalibrationBackup(unverified, { samePhysicalMount: true }).verified, false);
});

test('strict backup schema rejects unknown fields, invalid envelopes and unsupported versions', () => {
  const invalid = [
    null, [], {}, { mounting: verifiedMounting }, { ...envelope(), version: '1' },
    { ...envelope(), version: 2 }, { ...envelope(), strength: .5 },
    { ...envelope(), wantsMotion: true }, { ...envelope(), playback: { playing: true } },
    envelope(null), envelope([]), envelope({ ...verifiedMounting, strength: .8 }),
    envelope({ ...verifiedMounting, wantsMotion: true }),
    envelope({ angleDegrees: 45, invertRoll: false, invertPitch: false }),
    envelope({ ...verifiedMounting, angleDegrees: '135' }),
    envelope({ ...verifiedMounting, angleDegrees: null }),
    envelope({ ...verifiedMounting, angleDegrees: 181 }),
    envelope({ ...verifiedMounting, angleDegrees: -181 }),
    envelope({ ...verifiedMounting, invertRoll: 0 }),
    envelope({ ...verifiedMounting, invertPitch: 'true' }),
    envelope({ ...verifiedMounting, verified: 1 }),
  ];
  for (const value of invalid) {
    const text = JSON.stringify(value);
    assert.throws(() => parseMountingCalibrationBackup(text), undefined, text);
    assert.throws(() => restoreMountingCalibrationBackup(text, { samePhysicalMount: true }), undefined, text);
    assert.equal(readMountingCalibration({ getItem: () => text }).verified, false);
  }
  for (const text of ['', '{', 'null', ' '.repeat(MAX_MOUNTING_BACKUP_LENGTH + 1), undefined, 1]) {
    assert.throws(() => parseMountingCalibrationBackup(text));
  }
});

test('a downloaded backup recovers calibration after browser storage is cleared without restoring motion intent', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  saveMountingCalibration(storage, verifiedMounting);
  const downloadedBackup = serializeMountingCalibrationBackup(readMountingCalibration(storage));
  values.clear();
  assert.equal(readMountingCalibration(storage).verified, false);
  const restored = restoreMountingCalibrationBackup(downloadedBackup, { samePhysicalMount: true });
  saveMountingCalibration(storage, restored);
  assert.deepEqual(readMountingCalibration(storage), verifiedMounting);
  assert.deepEqual([...values.keys()], [MOUNTING_STORAGE_KEY]);
  assert.deepEqual(JSON.parse(values.get(MOUNTING_STORAGE_KEY)), envelope());
});

test('invalid backup cannot replace an existing persisted calibration', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  saveMountingCalibration(storage, verifiedMounting);
  const before = values.get(MOUNTING_STORAGE_KEY);
  assert.throws(() => saveMountingCalibration(storage, restoreMountingCalibrationBackup(
    JSON.stringify({ ...envelope(), strength: 1 }), { samePhysicalMount: true },
  )));
  assert.equal(values.get(MOUNTING_STORAGE_KEY), before);
  assert.deepEqual(readMountingCalibration(storage), verifiedMounting);
});
