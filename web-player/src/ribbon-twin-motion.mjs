import {
  clamp as sharedClamp,
  clampGear,
  lerp,
  sampleGearTelemetryAt,
  speedToSharedLift,
} from "./ribbon-gear-motion.mjs";

const YELLOW = Object.freeze({ r: 255, g: 224, b: 62 });
const RED = Object.freeze({ r: 255, g: 42, b: 56 });

export const TWIN_RIBBON_TELEMETRY_CONTRACT = Object.freeze({
  tuple: Object.freeze([
    "t_s",
    "speed_kph",
    "rpm",
    "throttle_pct",
    "brake",
    "gear",
    "drs",
  ]),
  geometry: "two-exactly-x-mirrored-ground-parallel-ribbons",
  throttle: "linear-half-width",
  speed: "vertical-y",
  rpm: "yellow-ffe03e-to-red-ff2a38",
  time: "deterministic-negative-z-transport",
  sampleRateHz: 50,
  unusedChannels: Object.freeze(["brake", "gear", "drs"]),
});

export const TWIN_RIBBON_TELEMETRY_CHANNELS = Object.freeze([
  "throttle-ribbon-width",
  "speed-vertical-y",
  "rpm-yellow-to-red",
  "time-negative-z-horizon",
  "pair-exact-x-mirror",
]);

/**
 * Renderer-independent settings for an opaque, wet latex surface. A Three.js
 * consumer can pass the numeric fields to MeshPhysicalMaterial without this
 * module importing or depending on Three.js.
 */
export const TWIN_RIBBON_MATERIAL_CONTRACT = Object.freeze({
  model: "opaque-wet-latex-physical",
  vertexColors: true,
  colorInterpolation: "linear-srgb",
  lowRpmColor: "#ffe03e",
  highRpmColor: "#ff2a38",
  metalness: 0,
  roughness: 0.14,
  clearcoat: 1,
  clearcoatRoughness: 0.045,
  sheen: 0.28,
  transmission: 0,
  opacity: 1,
  transparent: false,
  depthWrite: true,
  closedGeometry: true,
});

export const TWIN_RIBBON = Object.freeze({
  sampleRateHz: TWIN_RIBBON_TELEMETRY_CONTRACT.sampleRateHz,
  laneCenterX: 1.65,
  halfWidthMin: 0.13,
  halfWidthMax: 1.1,
  thickness: 0.09,
  speedMaxKph: 350,
  liftMin: -1.15,
  liftMax: 1.35,
  rpmMin: 7_500,
  rpmMax: 12_500,
  rpmYellow: YELLOW,
  rpmRed: RED,
  frontZ: 0,
  horizonZ: -48,
  depthSpan: 48,
});

function finiteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function cleanZero(value) {
  return value === 0 ? 0 : value;
}

export function clamp(value, minimum = 0, maximum = 1) {
  return sharedClamp(finiteNumber(value, minimum), minimum, maximum);
}

function normalizeDrs(value) {
  if (value === null || value === undefined) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function freezeSample(sample) {
  return Object.freeze({
    t: Math.max(0, finiteNumber(sample?.t)),
    speed: Math.max(0, finiteNumber(sample?.speed)),
    rpm: Math.max(0, finiteNumber(sample?.rpm)),
    throttle: clamp(sample?.throttle, 0, 100),
    brake: finiteNumber(sample?.brake) > 0 ? 100 : 0,
    gear: clampGear(finiteNumber(sample?.gear, 1)),
    drs: normalizeDrs(sample?.drs),
  });
}

/** Normalize the canonical tuple or its equivalent named object. */
export function tupleToTwinRibbonSample(sample) {
  if (Array.isArray(sample)) {
    return freezeSample({
      t: sample[0],
      speed: sample[1],
      rpm: sample[2],
      throttle: sample[3],
      brake: sample[4],
      gear: sample[5],
      drs: sample[6],
    });
  }

  return freezeSample({
    t: sample?.t ?? sample?.t_s ?? sample?.time ?? sample?.time_s,
    speed: sample?.speed ?? sample?.speed_kph,
    rpm: sample?.rpm,
    throttle: sample?.throttle ?? sample?.throttle_pct,
    brake: sample?.brake,
    gear: sample?.gear ?? sample?.n_gear,
    drs: sample?.drs,
  });
}

/** Sort and deduplicate without mutating the caller's collection. */
export function normalizeTwinRibbonSamples(samples) {
  const normalized = (Array.isArray(samples) ? samples : [])
    .map(tupleToTwinRibbonSample)
    .sort((left, right) => left.t - right.t);

  if (!normalized.length) {
    normalized.push(tupleToTwinRibbonSample([0, 0, 0, 0, 0, 1, null]));
  }

  const deduplicated = [];
  normalized.forEach((sample) => {
    if (deduplicated.at(-1)?.t === sample.t) {
      deduplicated[deduplicated.length - 1] = sample;
    } else {
      deduplicated.push(sample);
    }
  });
  return Object.freeze(deduplicated);
}

function sampleInterval(samples, time) {
  if (samples.length < 2) return { low: 0, high: 0, amount: 0 };
  if (time <= samples[0].t) return { low: 0, high: 0, amount: 0 };
  if (time >= samples.at(-1).t) {
    const last = samples.length - 1;
    return { low: last, high: last, amount: 0 };
  }

  let low = 0;
  let high = samples.length - 1;
  while (low + 1 < high) {
    const middle = (low + high) >> 1;
    if (samples[middle].t <= time) low = middle;
    else high = middle;
  }
  return {
    low,
    high,
    amount: clamp(
      (time - samples[low].t) /
        Math.max(0.001, samples[high].t - samples[low].t),
    ),
  };
}

function sampleFromNormalized(samples, time) {
  const requested = finiteNumber(time, samples[0].t);
  const telemetry = sampleGearTelemetryAt(samples, requested);
  const interval = sampleInterval(samples, requested);
  const discrete = interval.amount >= 0.5 ? samples[interval.high] : samples[interval.low];
  return freezeSample({ ...telemetry, drs: discrete.drs });
}

/**
 * Interpolate speed/throttle while preserving the repository's discrete shift,
 * RPM-drop, brake, gear and DRS handoff behavior.
 */
export function sampleTwinRibbonTelemetryAt(samples, time) {
  return sampleFromNormalized(normalizeTwinRibbonSamples(samples), time);
}

function smoothSpeedFromNormalized(samples, time) {
  if (samples.length < 2) return samples[0]?.speed ?? 0;
  const requested = finiteNumber(time, samples[0].t);
  if (requested <= samples[0].t) return samples[0].speed;
  if (requested >= samples.at(-1).t) return samples.at(-1).speed;

  const { low, high, amount } = sampleInterval(samples, requested);
  const p0 = samples[Math.max(0, low - 1)];
  const p1 = samples[low];
  const p2 = samples[high];
  const p3 = samples[Math.min(samples.length - 1, high + 1)];
  const interval = Math.max(0.001, p2.t - p1.t);
  const amount2 = amount * amount;
  const amount3 = amount2 * amount;
  const tangent1 =
    ((p2.speed - p0.speed) / Math.max(0.001, p2.t - p0.t)) * interval;
  const tangent2 =
    ((p3.speed - p1.speed) / Math.max(0.001, p3.t - p1.t)) * interval;
  const value =
    (2 * amount3 - 3 * amount2 + 1) * p1.speed +
    (amount3 - 2 * amount2 + amount) * tangent1 +
    (-2 * amount3 + 3 * amount2) * p2.speed +
    (amount3 - amount2) * tangent2;

  return clamp(value, Math.min(p1.speed, p2.speed), Math.max(p1.speed, p2.speed));
}

/** Time-aware Hermite speed interpolation with local overshoot clamped away. */
export function smoothTwinRibbonSpeedAt(samples, time) {
  return smoothSpeedFromNormalized(normalizeTwinRibbonSamples(samples), time);
}

/** Throttle maps linearly and exclusively to ribbon half-width. */
export function throttleToRibbonHalfWidth(
  throttle,
  minimum = TWIN_RIBBON.halfWidthMin,
  maximum = TWIN_RIBBON.halfWidthMax,
) {
  const safeMinimum = Math.max(0, finiteNumber(minimum, TWIN_RIBBON.halfWidthMin));
  const safeMaximum = Math.max(
    safeMinimum,
    finiteNumber(maximum, TWIN_RIBBON.halfWidthMax),
  );
  return lerp(safeMinimum, safeMaximum, clamp(throttle, 0, 100) / 100);
}

/** Speed maps linearly to the shared vertical lift used by the 3D histories. */
export function speedToRibbonY(speed, topSpeedKph = TWIN_RIBBON.speedMaxKph) {
  const safeTopSpeed = Math.max(1, finiteNumber(topSpeedKph, TWIN_RIBBON.speedMaxKph));
  return speedToSharedLift(Math.max(0, finiteNumber(speed)), safeTopSpeed);
}

function colorChannelToHex(channel) {
  return Math.round(clamp(channel, 0, 255)).toString(16).padStart(2, "0");
}

/** RPM maps linearly from the exact requested yellow to the exact red. */
export function rpmToRibbonColor(
  rpm,
  minimum = TWIN_RIBBON.rpmMin,
  maximum = TWIN_RIBBON.rpmMax,
) {
  const safeMinimum = Math.max(0, finiteNumber(minimum, TWIN_RIBBON.rpmMin));
  const safeMaximum = Math.max(
    safeMinimum + 1,
    finiteNumber(maximum, TWIN_RIBBON.rpmMax),
  );
  const amount = clamp(
    (finiteNumber(rpm) - safeMinimum) / (safeMaximum - safeMinimum),
  );
  const rgb = Object.freeze({
    r: Math.round(lerp(YELLOW.r, RED.r, amount)),
    g: Math.round(lerp(YELLOW.g, RED.g, amount)),
    b: Math.round(lerp(YELLOW.b, RED.b, amount)),
  });
  const unit = Object.freeze({
    r: rgb.r / 255,
    g: rgb.g / 255,
    b: rgb.b / 255,
  });
  const hex = `#${colorChannelToHex(rgb.r)}${colorChannelToHex(rgb.g)}${colorChannelToHex(rgb.b)}`;
  return Object.freeze({
    amount,
    ...rgb,
    rgb,
    unit,
    hex,
    css: `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`,
  });
}

/** Exact reflection across X=0, normalizing JavaScript's negative zero. */
export function mirrorRibbonX(x) {
  return cleanZero(-finiteNumber(x));
}

/** Canonical positive-X coordinate and its exact negative-X reflection. */
export function twinRibbonXPair(x = TWIN_RIBBON.laneCenterX) {
  const positive = Math.abs(finiteNumber(x, TWIN_RIBBON.laneCenterX));
  return Object.freeze({ positive, negative: mirrorRibbonX(positive) });
}

/** Mirrored inner/outer ribbon edges for a given center and half-width. */
export function twinRibbonEdges(
  centerX = TWIN_RIBBON.laneCenterX,
  halfWidth = TWIN_RIBBON.halfWidthMin,
) {
  const centers = twinRibbonXPair(centerX);
  const width = Math.max(0, finiteNumber(halfWidth, TWIN_RIBBON.halfWidthMin));
  const positive = Object.freeze({
    center: centers.positive,
    inner: centers.positive - width,
    outer: centers.positive + width,
  });
  const negative = Object.freeze({
    center: centers.negative,
    inner: mirrorRibbonX(positive.inner),
    outer: mirrorRibbonX(positive.outer),
  });
  return Object.freeze({ positive, negative });
}

function safeDuration(value, fallback = 0) {
  return Math.max(0, finiteNumber(value, fallback));
}

function safeDepthSpan(value = TWIN_RIBBON.depthSpan) {
  return Math.max(0, finiteNumber(value, TWIN_RIBBON.depthSpan));
}

/** Canonical positive local Z before the frame's negative transport is applied. */
export function twinRibbonPathZAt(
  emittedAt,
  duration,
  depthSpan = TWIN_RIBBON.depthSpan,
) {
  const safeLapDuration = safeDuration(duration);
  if (safeLapDuration === 0) return 0;
  return (
    clamp(emittedAt, 0, safeLapDuration) /
    safeLapDuration
  ) * safeDepthSpan(depthSpan);
}

/** Continuous world translation that carries existing history toward negative Z. */
export function twinRibbonTransportZAt(
  elapsed,
  duration,
  depthSpan = TWIN_RIBBON.depthSpan,
) {
  const safeLapDuration = safeDuration(duration);
  if (safeLapDuration === 0) return 0;
  return cleanZero(
    -(
      (clamp(elapsed, 0, safeLapDuration) / safeLapDuration) *
      safeDepthSpan(depthSpan)
    ),
  );
}

/** Visible historic samples are zero at the live head and negative behind it. */
export function twinRibbonHistoryZAt(
  elapsed,
  emittedAt,
  duration,
  depthSpan = TWIN_RIBBON.depthSpan,
) {
  return cleanZero(
    twinRibbonPathZAt(emittedAt, duration, depthSpan) +
      twinRibbonTransportZAt(elapsed, duration, depthSpan),
  );
}

function resolveStateOptions(normalized, options = {}) {
  const measuredTopSpeed = Math.max(1, ...normalized.map((sample) => sample.speed));
  return {
    topSpeedKph: Math.max(
      1,
      finiteNumber(options.topSpeedKph ?? options.topSpeed, measuredTopSpeed),
    ),
    laneCenterX: Math.abs(
      finiteNumber(options.laneCenterX, TWIN_RIBBON.laneCenterX),
    ),
    halfWidthMin: Math.max(
      0,
      finiteNumber(options.halfWidthMin, TWIN_RIBBON.halfWidthMin),
    ),
    halfWidthMax: Math.max(
      0,
      finiteNumber(options.halfWidthMax, TWIN_RIBBON.halfWidthMax),
    ),
    rpmMin: Math.max(0, finiteNumber(options.rpmMin, TWIN_RIBBON.rpmMin)),
    rpmMax: Math.max(1, finiteNumber(options.rpmMax, TWIN_RIBBON.rpmMax)),
  };
}

function stateFromNormalized(normalized, elapsed, options) {
  const sample = sampleFromNormalized(normalized, elapsed);
  const smoothSpeed = smoothSpeedFromNormalized(normalized, elapsed);
  const halfWidth = throttleToRibbonHalfWidth(
    sample.throttle,
    options.halfWidthMin,
    Math.max(options.halfWidthMin, options.halfWidthMax),
  );
  const xPair = twinRibbonXPair(options.laneCenterX);
  return Object.freeze({
    sample,
    y: speedToRibbonY(smoothSpeed, options.topSpeedKph),
    halfWidth,
    color: rpmToRibbonColor(
      sample.rpm,
      options.rpmMin,
      Math.max(options.rpmMin + 1, options.rpmMax),
    ),
    xPair,
    edges: twinRibbonEdges(options.laneCenterX, halfWidth),
  });
}

/** Live mapping for renderer/UI use; it never mutates or accumulates seek state. */
export function twinRibbonStateAt(samples, elapsed, options = {}) {
  const normalized = normalizeTwinRibbonSamples(samples);
  return stateFromNormalized(normalized, elapsed, resolveStateOptions(normalized, options));
}

/**
 * Precompute a complete lap at exactly 50 Hz, plus the exact lap endpoint when
 * its duration is not divisible by 20 ms. Z remains a positive local base;
 * twinRibbonFrameState supplies the deterministic negative world translation.
 */
export function buildTwinRibbonPath(samples, options = {}) {
  const normalized = normalizeTwinRibbonSamples(samples);
  const observedDuration = normalized.at(-1)?.t ?? 0;
  const duration = safeDuration(
    options.duration ?? options.lapDuration ?? options.lapDurationSeconds,
    observedDuration,
  );
  const sampleRateHz = TWIN_RIBBON.sampleRateHz;
  const segmentCount = duration > 0 ? Math.ceil(duration * sampleRateHz) : 0;
  const depthSpan = safeDepthSpan(options.depthSpan);
  const stateOptions = resolveStateOptions(normalized, options);
  const points = Array.from({ length: segmentCount + 1 }, (_, index) => {
    const t = index === segmentCount ? duration : index / sampleRateHz;
    const state = stateFromNormalized(normalized, t, stateOptions);
    return Object.freeze({
      index,
      t,
      progress: duration > 0 ? t / duration : 0,
      y: state.y,
      zBase: twinRibbonPathZAt(t, duration, depthSpan),
      halfWidth: state.halfWidth,
      color: state.color,
      xPair: state.xPair,
      edges: state.edges,
      speed: state.sample.speed,
      rpm: state.sample.rpm,
      throttle: state.sample.throttle,
    });
  });

  return Object.freeze({
    sampleRateHz,
    duration,
    depthSpan,
    depthPerSecond: duration > 0 ? depthSpan / duration : 0,
    pointCount: points.length,
    topSpeedKph: stateOptions.topSpeedKph,
    rpmMin: stateOptions.rpmMin,
    rpmMax: Math.max(stateOptions.rpmMin + 1, stateOptions.rpmMax),
    halfWidthMin: stateOptions.halfWidthMin,
    halfWidthMax: Math.max(
      stateOptions.halfWidthMin,
      stateOptions.halfWidthMax,
    ),
    xPair: twinRibbonXPair(stateOptions.laneCenterX),
    points: Object.freeze(points),
  });
}

function visibleHeadIndices(points, elapsed) {
  if (points.length <= 1 || elapsed <= points[0].t) {
    return { lowerIndex: 0, upperIndex: 0, headMix: 0 };
  }
  if (elapsed >= points.at(-1).t) {
    const last = points.length - 1;
    return { lowerIndex: last, upperIndex: last, headMix: 0 };
  }

  let low = 0;
  let high = points.length - 1;
  while (low + 1 < high) {
    const middle = (low + high) >> 1;
    if (points[middle].t <= elapsed) low = middle;
    else high = middle;
  }
  const interval = Math.max(0.000001, points[high].t - points[low].t);
  const headMix = clamp((elapsed - points[low].t) / interval);
  if (headMix <= 1e-12) {
    return { lowerIndex: low, upperIndex: low, headMix: 0 };
  }
  return { lowerIndex: low, upperIndex: high, headMix };
}

/** Cheap, deterministic reveal/transport state for any random-access seek. */
export function twinRibbonFrameState(path, elapsed, durationOverride) {
  const points = Array.isArray(path?.points) ? path.points : [];
  if (!points.length) {
    return Object.freeze({
      elapsed: 0,
      progress: 0,
      lowerIndex: 0,
      upperIndex: 0,
      headMix: 0,
      completePoints: 0,
      completeSegments: 0,
      visiblePoints: 0,
      visibleSegments: 0,
      zOffset: 0,
      headZ: 0,
    });
  }

  const duration = safeDuration(durationOverride, safeDuration(path?.duration));
  const safeElapsed = clamp(elapsed, 0, duration);
  const indices = visibleHeadIndices(points, safeElapsed);
  return Object.freeze({
    elapsed: safeElapsed,
    progress: duration > 0 ? safeElapsed / duration : 0,
    ...indices,
    completePoints: indices.lowerIndex + 1,
    completeSegments: indices.lowerIndex,
    visiblePoints: indices.upperIndex + 1,
    visibleSegments: indices.upperIndex,
    zOffset: twinRibbonTransportZAt(
      safeElapsed,
      duration,
      safeDepthSpan(path?.depthSpan),
    ),
    headZ: 0,
  });
}
