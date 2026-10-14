import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildSingaporeBabotMotionSeries,
  createSingaporePlaybackMotionSampler,
  singaporeMotionAt,
  SINGAPORE_RECORDED_PLAYBACK_CONTRACT,
} from "../src/motion.mjs";
import { canSendMotion } from "../src/player-clock.mjs";

const fixture = JSON.parse(await readFile(new URL("../data/openf1-singapore-2026-verstappen-pole.json", import.meta.url), "utf8"));
const model = buildSingaporeBabotMotionSeries(fixture);
const durationSeconds = fixture.meta.lapDurationSeconds;
const sampleAt = createSingaporePlaybackMotionSampler(model, { durationSeconds });
const close = (actual, expected, tolerance = 1e-10) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} ≈ ${expected}`);
const synthetic = (timeMs, pitch = 0, roll = 0) => ({ ...model.samples[0], timeMs, pitch, roll, valid: true });

test("the whole recorded pole lap has finite, bounded, continuous playback poses at 50 Hz", () => {
  const original = JSON.stringify(model);
  const times = Array.from({ length: Math.ceil(durationSeconds * 50) }, (_, index) => index / 50);
  times.push(durationSeconds);
  let previous;
  for (const time of times) {
    const sample = sampleAt(time);
    assert.equal(sample.valid, true, `playback pose unavailable at ${time}`);
    for (const [key, value] of Object.entries(sample)) {
      if (typeof value === "number") assert.ok(Number.isFinite(value), `${time}: ${key}`);
    }
    assert.ok(Math.abs(sample.pitch) <= 1 && Math.abs(sample.roll) <= 1);
    assert.ok(Math.hypot(sample.pitch * 10, sample.roll * 10) < 20, "10 degree axes stay inside the firmware envelope");
    if (previous) {
      // The measured series itself changes at most 0.10018 normalized units
      // per tick. Filling its gaps must not create a discontinuity beyond that.
      assert.ok(Math.abs(sample.pitch - previous.pitch) < 0.11, `pitch step at ${time}`);
      assert.ok(Math.abs(sample.roll - previous.roll) < 0.11, `roll step at ${time}`);
    }
    previous = sample;
  }
  assert.equal(JSON.stringify(model), original, "strict derived source remains unchanged");
});

test("all three real gaps blend adjacent finite valid poses without overshoot or neutral dips", () => {
  for (const [start, end] of [[26.58, 27.7], [50.52, 51.68], [61.96, 63.14]]) {
    const a = sampleAt(start);
    const b = sampleAt(end);
    for (let index = 1; index < 100; index++) {
      const amount = index / 100;
      const sample = sampleAt(start + (end - start) * amount);
      assert.equal(sample.valid, true);
      assert.equal(sample.sourceValid, false);
      assert.equal(sample.playbackMode, "interpolated-gap");
      for (const axis of ["pitch", "roll"]) {
        close(sample[axis], a[axis] + (b[axis] - a[axis]) * amount, 1e-8);
        assert.ok(sample[axis] >= Math.min(a[axis], b[axis]) && sample[axis] <= Math.max(a[axis], b[axis]));
      }
    }
    for (const boundary of [start, end]) {
      const before = sampleAt(boundary - 1e-6);
      const after = sampleAt(boundary + 1e-6);
      close(before.pitch, after.pitch, 1e-5);
      close(before.roll, after.roll, 1e-5);
    }
  }
});

test("short uncovered lap endpoints hold their nearest pose only within the lap", () => {
  for (const time of [0, 0.1, 0.299]) {
    const sample = sampleAt(time);
    assert.equal(sample.playbackMode, "held-start");
    assert.equal(sample.valid, true);
    assert.equal(sample.sourceValid, false);
    close(sample.pitch, model.samples[0].pitch);
    close(sample.roll, model.samples[0].roll);
  }
  for (const time of [91.201, 91.3, durationSeconds]) {
    const sample = sampleAt(time);
    assert.equal(sample.playbackMode, "held-end");
    close(sample.pitch, model.samples.at(-1).pitch);
    close(sample.roll, model.samples.at(-1).roll);
  }
  for (const time of [-0.001, durationSeconds + 0.001, 1e8, NaN, Infinity, -Infinity, undefined, "1"]) {
    const sample = sampleAt(time);
    assert.equal(sample.valid, false, `unsupported clock ${time}`);
    assert.equal(sample.playbackMode, "unavailable");
    assert.equal(sample.pitch, 0);
    assert.equal(sample.roll, 0);
  }
});

test("strict source validity remains available and seek order cannot affect playback", () => {
  for (const time of [0, 27, 51, 62.5, durationSeconds]) {
    assert.equal(singaporeMotionAt(model, time).valid, false);
    assert.equal(sampleAt(time).sourceValid, false);
    assert.equal(sampleAt(time).valid, true);
  }
  for (const time of [90, 1, 28, 25, 0.3, 52, 91.2, 64, 27, 50, 27]) {
    const playback = sampleAt(time);
    const strict = singaporeMotionAt(model, time);
    assert.equal(playback.sourceValid, strict.valid);
    if (strict.valid) {
      close(playback.pitch, strict.pitch);
      close(playback.roll, strict.roll);
    }
    assert.deepEqual(sampleAt(time), playback);
  }
});

test("unsupported long gaps stay invalid even immediately next to valid samples", () => {
  const sample = createSingaporePlaybackMotionSampler([
    synthetic(0, -1, 1), synthetic(20, -0.9, 0.9),
    synthetic(2000, 0.9, -0.9), synthetic(2020, 1, -1),
  ], { durationSeconds: 2.02 });
  for (const time of [0.020001, 0.5, 1, 1.999999]) {
    assert.equal(sample(time).valid, false);
    assert.equal(sample(time).playbackReason, "interpolation-gap-limit");
  }
  assert.equal(sample(0.02).valid, true);
  assert.equal(sample(2).valid, true);
  const limit = SINGAPORE_RECORDED_PLAYBACK_CONTRACT.maximumInterpolationGapMs;
  const atLimit = createSingaporePlaybackMotionSampler([synthetic(0, -1, 1), synthetic(limit, 1, -1)], { durationSeconds: limit / 1000 });
  assert.equal(atLimit(limit / 2000).valid, true);
  close(atLimit(limit / 2000).pitch, 0);
});

test("long missing endpoints cannot become valid through a near-endpoint request", () => {
  const leading = createSingaporePlaybackMotionSampler([synthetic(400), synthetic(420)], { durationSeconds: 0.42 });
  assert.equal(leading(0).valid, false);
  assert.equal(leading(0.399).valid, false);
  assert.equal(leading(0.4).valid, true);
  const trailing = createSingaporePlaybackMotionSampler([synthetic(0), synthetic(20)], { durationSeconds: 0.42 });
  assert.equal(trailing(0.021).valid, false);
  assert.equal(trailing(0.42).valid, false);
  assert.equal(trailing(0.02).valid, true);
});

test("invalid, nonfinite, or out-of-range anchors cannot introduce a NaN or unbounded pose", () => {
  const sample = createSingaporePlaybackMotionSampler([
    synthetic(0, -0.5, 0.5),
    synthetic(20, NaN, 0),
    { ...synthetic(40), valid: false },
    synthetic(60, 2, 0),
    { ...synthetic(80), latG: Infinity },
    synthetic(100, 0.5, -0.5),
  ], { durationSeconds: 0.1 });
  for (const time of [0.02, 0.04, 0.06, 0.08]) {
    const result = sample(time);
    assert.equal(result.valid, true);
    assert.equal(result.sourceValid, false);
    close(result.pitch, -0.5 + time * 10);
    assert.ok(Number.isFinite(result.latG));
  }
  const empty = createSingaporePlaybackMotionSampler([], { durationSeconds: 1 });
  assert.equal(empty(0).valid, false);
  for (const duration of [0, -1, NaN, Infinity]) assert.throws(() => createSingaporePlaybackMotionSampler([], { durationSeconds: duration }), /duration/);
});

test("bridged playback poses do not bypass clock freshness or the playback safety gates", () => {
  const gate = {
    playing: true, videoMode: true, ready: true, seeking: false,
    hidden: false, ended: false, confirmed: true,
    valid: sampleAt(27).valid, sampledAt: 1000, now: 1020,
  };
  assert.equal(canSendMotion(gate), true);
  for (const patch of [
    { now: 1180 }, { now: 999 }, { sampledAt: NaN }, { playing: false },
    { seeking: true }, { hidden: true }, { ended: true }, { confirmed: false },
    { videoMode: false }, { ready: false },
  ]) assert.equal(canSendMotion({ ...gate, ...patch }), false);
});
