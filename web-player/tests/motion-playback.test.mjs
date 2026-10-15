import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildSingaporeBabotMotionSeries,
  createSingaporePlaybackMotionSampler,
  normalizeSingaporeDerivedMotion,
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
      // Check the actual full-lap demand, including reconstructed transitions.
      assert.ok(Math.abs(sample.pitch - previous.pitch) < 0.11, `pitch step at ${time}`);
      assert.ok(Math.abs(sample.roll - previous.roll) < 0.11, `roll step at ${time}`);
      const degreesPerSecond = Math.hypot(sample.pitch - previous.pitch, sample.roll - previous.roll) * 10 / 0.02;
      assert.ok(degreesPerSecond < 60, `10 degree axes exceed the intended cue slew at ${time}`);
    }
    previous = sample;
  }
  assert.equal(JSON.stringify(model), original, "strict derived source remains unchanged");
});

test("all three real gaps reconstruct bounded source cues and disclose their lower confidence", () => {
  for (const [start, end] of [[26.58, 27.7], [50.52, 51.68], [61.96, 63.14]]) {
    for (let index = 1; index < 100; index++) {
      const amount = index / 100;
      const sample = sampleAt(start + (end - start) * amount);
      assert.equal(sample.valid, true);
      assert.equal(sample.sourceValid, false);
      assert.equal(sample.playbackMode, "reconstructed-gap");
      assert.equal(sample.reconstructed, true);
      assert.equal(sample.cueSource, "reconstructed-path-and-speed");
      assert.ok(sample.confidence > 0 && sample.confidence <= 0.35);
      for (const axis of ["pitch", "roll"]) {
        assert.ok(Number.isFinite(sample[axis]) && Math.abs(sample[axis]) <= 1);
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

test("off-grid samples at every reconstructed support edge retain the lower confidence cap", () => {
  let checked = 0;
  for (let index = 1; index < model.playbackSamples.length; index++) {
    const a = model.playbackSamples[index - 1], b = model.playbackSamples[index];
    if (a.reconstructed === b.reconstructed) continue;
    for (let ms = a.timeMs + 1; ms < b.timeMs; ms++) {
      const sample = sampleAt(ms / 1000);
      assert.equal(sample.reconstructed, true);
      for (const key of ["confidence", "longitudinalConfidence", "lateralConfidence"]) {
        assert.ok(sample[key] <= 0.35, `${key} leaked at ${ms}`);
      }
      checked++;
    }
  }
  assert.ok(checked >= 100, "exercise both sides of all three reconstruction supports");
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
    // Derivative support near a gap also uses reconstructed positions; original
    // sample availability remains independent of the cue's source/confidence.
    if (strict.valid && !playback.reconstructed) {
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

test("the recorded missing right turn retains its net heading change instead of blending near-zero roll", () => {
  let headingChange = 0;
  for (let t = 50; t < 52; t += 0.02) headingChange += sampleAt(t).yawRateRadS * 0.02;
  // Surrounding source headings show roughly 56 degrees clockwise. The exact
  // racing line and peak G remain unknown, but a near-zero turn is inconsistent.
  assert.ok(headingChange < -0.85 && headingChange > -1.2);
  assert.ok(sampleAt(51).roll < -0.7);
  assert.ok(sampleAt(51).latG < -2);
  assert.equal(sampleAt(51).sourceValid, false);
  // The other long dropout is a straight, and must not acquire a turn pulse.
  for (let t = 62; t < 63.1; t += 0.02) assert.ok(Math.abs(sampleAt(t).roll) < 0.1);
});

function turnFixture(gapEnd = 3.2) {
  const carSamples = [], locationSamples = [];
  const speed = 20, yaw = -Math.PI / 3;
  for (let step = 0; step <= 30; step++) {
    const t = step / 5;
    if (t > 2 && t < gapEnd - 1e-8) continue;
    const arc = Math.max(0, Math.min(1, t - 2));
    const exit = Math.max(0, t - 3);
    const x = speed * Math.min(t, 2) + speed * Math.sin(yaw * arc) / yaw + speed * Math.cos(yaw) * exit;
    const y = speed * (1 - Math.cos(yaw * arc)) / yaw + speed * Math.sin(yaw) * exit;
    carSamples.push([t * 1000, speed * 3.6, 10000, 100, 0, 4, 0]);
    locationSamples.push([t * 1000, x * 10, y * 10, 0]);
  }
  return { meta: { lapDurationMs: 6000 }, carSamples, locationSamples };
}

test("a turn wholly inside a supported source dropout is reconstructed without per-corner rules", () => {
  const fixture = turnFixture();
  const before = JSON.stringify(fixture);
  const series = buildSingaporeBabotMotionSeries(fixture);
  const at = createSingaporePlaybackMotionSampler(series);
  let headingChange = 0;
  for (let t = 1.2; t < 4; t += 0.02) headingChange += at(t).yawRateRadS * 0.02;
  assert.ok(Math.abs(headingChange + Math.PI / 3) < 0.15, `60 degree turn lost: ${headingChange}`);
  assert.ok(at(2.6).roll < -0.4);
  assert.equal(at(2.6).sourceValid, false);
  assert.equal(at(2.6).reconstructed, true);
  assert.equal(singaporeMotionAt(series, 2.6).valid, false);
  assert.equal(JSON.stringify(fixture), before);
});

test("source reconstruction never bridges more than 1.2 seconds or extrapolates outside the lap", () => {
  const series = buildSingaporeBabotMotionSeries(turnFixture(3.4));
  const at = createSingaporePlaybackMotionSampler(series);
  assert.equal(at(2.6).valid, false);
  assert.equal(at(-0.001).valid, false);
  assert.equal(at(6.001).valid, false);
  assert.equal(series.diagnostics.reconstructedPathGaps, undefined);
});

test("rebuilding a short dropout does not authorize interpolation across a separate source jump", () => {
  const fixture = turnFixture();
  fixture.locationSamples = fixture.locationSamples.map(row => row[0] >= 4200
    ? [row[0], row[1] + 10000, row[2], row[3]] : row);
  const series = buildSingaporeBabotMotionSeries(fixture);
  const at = createSingaporePlaybackMotionSampler(series);
  assert.equal(at(2.6).valid, true, "supported temporal gap still reconstructs");
  assert.equal(singaporeMotionAt(series, 4.1).valid, false);
  assert.equal(at(4.1).valid, false, "source teleport must remain unavailable");
});

test("a spatial or speed discontinuity coincident with a short dropout rejects the entire gap", () => {
  for (const channel of ["path", "speed"]) {
    const fixture = turnFixture();
    if (channel === "path") {
      fixture.locationSamples = fixture.locationSamples.map(row => row[0] >= 3200
        ? [row[0], row[1] + 1000, row[2], row[3]] : row);
    } else {
      fixture.carSamples = fixture.carSamples.map(row => row[0] >= 3200
        ? [row[0], 420, ...row.slice(2)] : row);
    }
    const series = buildSingaporeBabotMotionSeries(fixture);
    const at = createSingaporePlaybackMotionSampler(series);
    for (let ms = 2020; ms < 3200; ms += 20) {
      assert.equal(at(ms / 1000).valid, false, `${channel} jump accepted at ${ms}`);
    }
  }
});

test("braking anticipation is reduced without turning the command into a sharp step", () => {
  const old = createSingaporePlaybackMotionSampler(buildSingaporeBabotMotionSeries(fixture, {
    speedSmoothingWindowMs: 900, headingSmoothingWindowMs: 900, yawSmoothingWindowMs: 900,
    longitudinalSoftScaleG: 1.1, lateralSoftScaleG: 1.25,
    longitudinalCueResponseMs: 0, reconstructPlayback: false,
  }));
  const onset = (at, brakeAt) => {
    for (let ms = Math.floor((brakeAt - 1) * 50) * 20; ms < brakeAt * 1000; ms += 20) {
      if (at(ms / 1000).pitch > 0.2) return ms / 1000;
    }
    return brakeAt;
  };
  for (const brakeAt of [3.641, 45.88, 87.001]) {
    const lead = brakeAt - onset(sampleAt, brakeAt);
    assert.ok(lead <= 0.18, `excessive anticipation before brake ${brakeAt}: ${lead}`);
    assert.ok(onset(sampleAt, brakeAt) - onset(old, brakeAt) > 0.2);
  }
});

test("different high loads retain useful amplitude separation instead of living near the limits", () => {
  const moderate = normalizeSingaporeDerivedMotion(-3, 3);
  const high = normalizeSingaporeDerivedMotion(-4, 4);
  assert.ok(high.roll - moderate.roll > 0.08);
  assert.ok(high.pitch - moderate.pitch > 0.05);
  const samples = Array.from({ length: Math.ceil(durationSeconds * 50) }, (_, index) => sampleAt(index / 50));
  assert.ok(samples.filter(s => Math.abs(s.roll) > 0.9).length / samples.length < 0.03);
  assert.ok(samples.filter(s => Math.abs(s.pitch) > 0.9).length / samples.length < 0.05);
});
