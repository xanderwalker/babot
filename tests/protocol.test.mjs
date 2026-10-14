import assert from "node:assert/strict";
import test from "node:test";
import { carPoseToFirmwarePose, commandedPoseDegrees, formatPoseCommand, formatArmCommand, isApprovedControllerOrigin } from "../src/protocol.mjs";

test("car calibration preserves the established 45 degree mapping", () => {
  const pitch = carPoseToFirmwarePose({ roll: 0, pitch: -1 });
  assert.ok(Math.abs(pitch.roll - Math.SQRT1_2) < 1e-12);
  assert.ok(Math.abs(pitch.pitch + Math.SQRT1_2) < 1e-12);
  assert.deepEqual(commandedPoseDegrees({ roll: 1, pitch: -1 }), { roll: 1, pitch: -0.75 });
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
