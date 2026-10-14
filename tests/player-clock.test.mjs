import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { canSendMotion, channelsAt, distanceAt, distanceSeries, lapTime, videoTime, windowFits } from "../src/player-clock.mjs";
import { buildSingaporeBabotMotionSeries, singaporeMotionAt } from "../src/motion.mjs";

const duration = 91.373;
const gate = {
  playing: true, videoMode: true, ready: true, seeking: false,
  hidden: false, ended: false, confirmed: true,
  valid: true, sampledAt: 1_000, now: 1_020,
};

test("the anchored video clock and lap scrubber round-trip without accumulating drift", () => {
  for (const offset of [0, 5.14, 127.281]) {
    for (const seconds of [0, 0.3, 27.002, 65.533, duration]) {
      assert.ok(Math.abs(lapTime(videoTime(seconds, offset, duration), offset, duration) - seconds) < 1e-10);
    }
    assert.equal(lapTime(offset - 20, offset, duration), 0);
    assert.equal(lapTime(offset + duration + 20, offset, duration), duration);
    assert.equal(videoTime(-50, offset, duration), offset);
    assert.equal(videoTime(500, offset, duration), offset + duration);
  }
});

test("video duration must cover the selected lap anchor within the documented frame tolerance", () => {
  assert.equal(windowFits(duration, 0, duration), true);
  assert.equal(windowFits(duration + 5.14, 5.14, duration), true);
  assert.equal(windowFits(duration + 5.14 - 0.1, 5.14, duration), true);
  assert.equal(windowFits(duration + 5.14 - 0.15, 5.14, duration), false);
  assert.equal(windowFits(60, 0, duration), false);
  assert.equal(windowFits(120, -1, duration), false);
  assert.equal(windowFits(NaN, 0, duration), false);
  assert.equal(windowFits(Infinity, 0, duration), false);
});

test("hardware requires playing, confirmed, current video data and every individual gate", () => {
  assert.equal(canSendMotion(gate), true);
  for (const flag of ["playing", "videoMode", "ready", "confirmed", "valid"]) {
    assert.equal(canSendMotion({ ...gate, [flag]: false }), false, flag);
  }
  for (const flag of ["seeking", "hidden", "ended"]) {
    assert.equal(canSendMotion({ ...gate, [flag]: true }), false, flag);
  }
});

test("clock freshness fails closed on old, future, missing or invalid timestamps", () => {
  assert.equal(canSendMotion({ ...gate, now: 1_179 }), true);
  assert.equal(canSendMotion({ ...gate, now: 1_180 }), false);
  assert.equal(canSendMotion({ ...gate, now: 1_400 }), false);
  assert.equal(canSendMotion({ ...gate, now: 999 }), false);
  assert.equal(canSendMotion({ ...gate, sampledAt: undefined }), false);
  assert.equal(canSendMotion({ ...gate, sampledAt: NaN }), false);
  assert.equal(canSendMotion({ ...gate, now: NaN }), false);
});

test("distance integrates recorded speed in SI units and is deterministic when seeking", () => {
  const series = distanceSeries([[0, 0], [1_000, 36], [2_000, 36], [4_000, 72]]);
  assert.deepEqual(series, [[0, 0], [1, 5], [2, 15], [4, 45]]);
  assert.equal(distanceAt(series, -20), 0);
  assert.equal(distanceAt(series, 1.5), 10);
  assert.equal(distanceAt(series, 3), 30);
  assert.equal(distanceAt(series, 20), 45);
  assert.equal(distanceAt(series, 1.5), 10);
  assert.equal(distanceAt([], 20), 0);
});

test("the real pole lap keeps source gaps and uncovered endpoints invalid for hardware", async () => {
  const fixture = JSON.parse(await readFile(new URL("../data/openf1-singapore-2026-verstappen-pole.json", import.meta.url), "utf8"));
  const model = buildSingaporeBabotMotionSeries(fixture);
  assert.equal(model.diagnostics.carGapCount, 3);
  assert.equal(model.diagnostics.locationGapCount, 3);
  for (const seconds of [0, 0.1, 27, 51, 62.5, duration]) {
    const sample = singaporeMotionAt(model, seconds);
    assert.equal(sample.valid, false, `source gap at ${seconds}`);
    assert.equal(canSendMotion({ ...gate, valid: sample.valid }), false);
  }
  for (const seconds of [1, 25, 28, 50, 52, 61, 64, 90]) {
    assert.equal(singaporeMotionAt(model, seconds).valid, true, `covered source at ${seconds}`);
  }
});

test("visual telemetry crosses the real source gap while physical motion stays invalid", async () => {
  const fixture = JSON.parse(await readFile(new URL("../data/openf1-singapore-2026-verstappen-pole.json", import.meta.url), "utf8"));
  const model = buildSingaporeBabotMotionSeries(fixture);
  const car = channelsAt(fixture.carSamples, 27);
  const location = channelsAt(fixture.locationSamples, 27);
  const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≈ ${expected}`);

  // Car samples bracket 26.600–27.681 s; location brackets 26.661–27.580 s.
  // These gaps exceed the physical model's 900 ms source-coverage limit.
  assert.equal(singaporeMotionAt(model, 27).valid, false);
  assert.equal(canSendMotion({ ...gate, valid: singaporeMotionAt(model, 27).valid }), false);
  assert.equal(car[0], 27_000);
  close(car[1], 308 - 55 * 400 / 1081);
  close(car[2], 11_020 - 2013 * 400 / 1081);
  close(car[3], 100 - 100 * 400 / 1081);
  assert.equal(car[4], 0, "brake holds its preceding recorded state across the gap");
  assert.equal(car[5], 8);
  assert.equal(car[6], null, "unknown DRS remains unknown");
  assert.equal(channelsAt(fixture.carSamples, 27.681)[4], 1, "brake switches at the actual sample");
  assert.equal(location[0], 27_000);
  close(location[1], -6875 - 637 * 339 / 919);
  close(location[2], 1399 + 418 * 339 / 919);
  close(location[3], 190 + 339 / 919);
});

test("visual gear and brake switch at their recorded sample instead of interpolating", async () => {
  const fixture = JSON.parse(await readFile(new URL("../data/openf1-singapore-2026-verstappen-pole.json", import.meta.url), "utf8"));
  // Both change between the recorded 5.080 s and 5.280 s car samples.
  const midpoint = channelsAt(fixture.carSamples, 5.18);
  assert.equal(midpoint[1], 148, "continuous speed is interpolated");
  assert.equal(midpoint[2], 10_541, "continuous RPM is interpolated");
  assert.equal(midpoint[4], 1);
  assert.equal(midpoint[5], 4);
  assert.deepEqual(channelsAt(fixture.carSamples, 5.28).slice(4, 6), [0, 3]);
});
