import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_MOUNTING_CALIBRATION, validateMountingCalibration, carPoseToFirmwarePose, commandedPoseDegrees, formatPoseCommand, formatArmCommand, isApprovedControllerOrigin } from "../src/protocol.mjs";

test("car calibration preserves the established 45 degree mapping", () => {
  assert.equal(DEFAULT_MOUNTING_CALIBRATION.verified, false);
  const pitch = carPoseToFirmwarePose({ roll: 0, pitch: -1 });
  assert.ok(Math.abs(pitch.roll - Math.SQRT1_2) < 1e-12);
  assert.ok(Math.abs(pitch.pitch + Math.SQRT1_2) < 1e-12);
  assert.deepEqual(commandedPoseDegrees({ roll: 1, pitch: -1 }), { roll: 1, pitch: -0.75 });
});

test("configured mounting rotates and inverts isolated car axes without changing magnitude", () => {
  const config = { angleDegrees: 90, invertRoll: true, invertPitch: false, verified: true };
  const roll = carPoseToFirmwarePose({ roll: 3, pitch: 0 }, 20, config);
  assert.ok(Math.abs(roll.roll) < 1e-12);
  assert.equal(roll.pitch, -3);
  const pitch = carPoseToFirmwarePose({ roll: 0, pitch: 4 }, 20, config);
  assert.equal(pitch.roll, -4);
  assert.ok(Math.abs(pitch.pitch) < 1e-12);
  const combined = carPoseToFirmwarePose({ roll: 12, pitch: 16 }, 10, config);
  assert.ok(Math.abs(Math.hypot(combined.roll, combined.pitch) - 10) < 1e-12);
});

test("mounting rejects corrupt saved settings and keeps an immutable validated snapshot", () => {
  const base = { ...DEFAULT_MOUNTING_CALIBRATION };
  const snapshot = validateMountingCalibration(base);
  base.angleDegrees = -45;
  assert.equal(snapshot.angleDegrees, 45);
  assert.equal(Object.isFrozen(snapshot), true);
  for (const angleDegrees of [NaN, Infinity, -Infinity, 181, -181, '45', null, undefined]) {
    assert.throws(() => validateMountingCalibration({ ...base, angleDegrees }), /mounting/);
  }
  for (const value of [null, [], {}, { ...base, invertRoll: 1 }, { ...base, invertPitch: 'false' }, { ...base, verified: undefined }]) {
    assert.throws(() => validateMountingCalibration(value), /mounting/);
  }
  for (const angleDegrees of [-180, 0, 180]) assert.equal(validateMountingCalibration({ ...base, angleDegrees }).angleDegrees, angleDegrees);
});

test("decimal wire poses stay inside the firmware circular envelope at every heading", () => {
  for (let degrees = 0; degrees < 360; degrees += 0.1) {
    const radians = degrees * Math.PI / 180;
    const wire = formatPoseCommand(123, { roll: 20 * Math.cos(radians), pitch: 20 * Math.sin(radians) });
    const [, sequence, roll, pitch] = wire.trim().split(" ");
    assert.equal(sequence, "123");
    assert.ok(Math.hypot(Number(roll), Number(pitch)) <= 20, wire);
    assert.ok(wire.endsWith("\n"));
  }
});

test("invalid numbers and sequences are rejected instead of becoming neutral commands", () => {
  assert.throws(() => formatPoseCommand(1, { roll: NaN, pitch: 1 }), /Invalid BaBot pose/);
  assert.throws(() => formatPoseCommand(1, { roll: 1, pitch: Infinity }), /Invalid BaBot pose/);
  for (const id of [0, -1, 0.5, 0x100000000, NaN]) assert.throws(() => formatArmCommand(id), /sequence/);
});

test("USB permits secure top-level localhost and hosted HTTPS origins", () => {
  for (const hostname of ["localhost", "127.0.0.1", "::1", "[::1]", "visualizerf1.xanderwalker.com", "example.com"]) {
    assert.equal(isApprovedControllerOrigin({ hostname, isSecureContext: true, isTopLevel: true }), true);
  }
  assert.equal(isApprovedControllerOrigin({ isSecureContext: true, isTopLevel: true }), true, "hostname is not an access gate");
});

test("USB rejects insecure, embedded and unverified browsing contexts", () => {
  for (const context of [
    { hostname: "localhost", isSecureContext: false, isTopLevel: true },
    { hostname: "localhost", isSecureContext: true, isTopLevel: false },
    { hostname: "visualizerf1.xanderwalker.com", isSecureContext: false, isTopLevel: true },
    { hostname: "visualizerf1.xanderwalker.com", isSecureContext: true, isTopLevel: false },
    { isSecureContext: true },
    { isTopLevel: true },
    { isSecureContext: "true", isTopLevel: true },
    { isSecureContext: true, isTopLevel: "true" },
    {},
  ]) assert.equal(isApprovedControllerOrigin(context), false);
  assert.equal(isApprovedControllerOrigin(), false);
});
