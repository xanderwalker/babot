const GRAVITY_MPS2 = 9.80665;

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export const SINGAPORE_BABOT_MOTION_CONTRACT = deepFreeze({
  version: 2,
  inputSchema: {
    fixture: "{ meta, carSamples, locationSamples }",
    carTuple: [
      "tMs",
      "speedKph",
      "rpm",
      "throttlePct",
      "brakeOn",
      "gear",
      "drs",
    ],
    locationTuple: ["tMs", "x", "y", "z"],
  },
  outputIntervalMs: 20,
  outputHz: 50,
  expectedSourceHz: 3.7,
  gravityMps2: GRAVITY_MPS2,
  maximumSourceGapMs: 900,
  speedSmoothingWindowMs: 500,
  headingSmoothingWindowMs: 750,
  yawSmoothingWindowMs: 650,
  longitudinalCueResponseMs: 100,
  speedJumpLimitMps2: 75,
  locationJumpMedianFactor: 4,
  longitudinalSoftScaleG: 2,
  lateralSoftScaleG: 2.5,
  maximumEstimatedAbsG: 6,
  maximumModelConfidence: 0.68,
  lateralFadeStartMps: 4,
  lateralFadeFullMps: 12,
  measuredG: false,
  provenanceLabel: "OpenF1-derived acceleration motion cue",
  honestyLabel: "Estimated from speed and approximate path; not measured G-force",
  coordinateFrame: {
    longitudinalPositive: "increasing forward speed",
    lateralPositive: "counter-clockwise yaw in the OpenF1 x/y plane",
    pitchPositive: "nose-down normalized car pose; acceleration cue is negative (nose-up)",
    rollPositive: "positive OpenF1 path-yaw cue",
  },
});

function finite(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, finite(value, minimum)));
}

function lerp(start, end, amount) {
  return start + (end - start) * amount;
}

function median(values) {
  const finiteValues = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!finiteValues.length) return 0;
  const middle = Math.floor(finiteValues.length / 2);
  return finiteValues.length % 2
    ? finiteValues[middle]
    : (finiteValues[middle - 1] + finiteValues[middle]) * 0.5;
}

function medianAbsoluteDeviation(values, center = median(values)) {
  return median(values.map((value) => Math.abs(value - center)));
}

function smoothstep(value) {
  const amount = clamp(value);
  return amount * amount * (3 - 2 * amount);
}

function wrapAngle(radians) {
  let angle = finite(radians);
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle <= -Math.PI) angle += Math.PI * 2;
  return angle;
}

function cloneSerializable(value) {
  if (value === null || ["string", "boolean"].includes(typeof value)) return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(cloneSerializable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined && typeof child !== "function")
        .map(([key, child]) => [key, cloneSerializable(child)]),
    );
  }
  return String(value ?? "");
}

function deduplicateByTime(points) {
  const sorted = [...points].sort((left, right) => left.tMs - right.tMs);
  const deduplicated = [];
  let duplicateCount = 0;
  for (const point of sorted) {
    if (deduplicated.length && point.tMs === deduplicated.at(-1).tMs) {
      deduplicated[deduplicated.length - 1] = point;
      duplicateCount += 1;
    } else {
      deduplicated.push(point);
    }
  }
  return { points: deduplicated, duplicateCount };
}

function estimatedRateHz(points) {
  const intervals = [];
  for (let index = 1; index < points.length; index += 1) {
    const interval = points[index].tMs - points[index - 1].tMs;
    if (interval > 0 && interval <= SINGAPORE_BABOT_MOTION_CONTRACT.maximumSourceGapMs) {
      intervals.push(interval);
    }
  }
  const typicalInterval = median(intervals);
  return typicalInterval > 0 ? 1_000 / typicalInterval : 0;
}

function removeIsolatedScalarOutliers(points, valueKey, absoluteFloor) {
  if (points.length < 5) return { points, rejected: 0 };
  const residuals = [];
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const next = points[index + 1];
    const span = next.tMs - previous.tMs;
    if (
      span <= 0 ||
      current.tMs - previous.tMs > SINGAPORE_BABOT_MOTION_CONTRACT.maximumSourceGapMs ||
      next.tMs - current.tMs > SINGAPORE_BABOT_MOTION_CONTRACT.maximumSourceGapMs
    ) {
      continue;
    }
    const amount = (current.tMs - previous.tMs) / span;
    const predicted = lerp(previous[valueKey], next[valueKey], amount);
    residuals.push(Math.abs(current[valueKey] - predicted));
  }
  const center = median(residuals);
  const deviation = medianAbsoluteDeviation(residuals, center);
  const threshold = Math.max(absoluteFloor, center + Math.max(absoluteFloor, deviation * 8));
  let rejected = 0;
  const kept = points.filter((current, index) => {
    if (index === 0 || index === points.length - 1) return true;
    const previous = points[index - 1];
    const next = points[index + 1];
    const span = next.tMs - previous.tMs;
    if (
      span <= 0 ||
      current.tMs - previous.tMs > SINGAPORE_BABOT_MOTION_CONTRACT.maximumSourceGapMs ||
      next.tMs - current.tMs > SINGAPORE_BABOT_MOTION_CONTRACT.maximumSourceGapMs
    ) {
      return true;
    }
    const predicted = lerp(
      previous[valueKey],
      next[valueKey],
      (current.tMs - previous.tMs) / span,
    );
    if (Math.abs(current[valueKey] - predicted) <= threshold) return true;
    rejected += 1;
    return false;
  });
  return { points: kept, rejected };
}

function normalizeCarSamples(input) {
  const parsed = [];
  let invalidCount = 0;
  for (const tuple of Array.isArray(input) ? input : []) {
    const tMs = Number(tuple?.[0]);
    const speedKph = Number(tuple?.[1]);
    if (!Number.isFinite(tMs) || !Number.isFinite(speedKph) || speedKph < 0 || speedKph > 450) {
      invalidCount += 1;
      continue;
    }
    parsed.push({
      tMs,
      speedKph,
      rpm: Math.max(0, finite(tuple?.[2])),
      throttlePct: clamp(tuple?.[3], 0, 100),
      brakeOn: finite(tuple?.[4]) > 0 ? 1 : 0,
      gear: Math.max(0, Math.round(finite(tuple?.[5]))),
      drs: Math.round(finite(tuple?.[6])),
    });
  }
  const deduplicated = deduplicateByTime(parsed);
  const cleaned = removeIsolatedScalarOutliers(deduplicated.points, "speedKph", 45);
  const segmented = [];
  let segment = 0;
  let gapCount = 0;
  let jumpCount = 0;
  for (const point of cleaned.points) {
    const previous = segmented.at(-1);
    if (previous) {
      const deltaMs = point.tMs - previous.tMs;
      const acceleration = deltaMs > 0
        ? Math.abs((point.speedKph - previous.speedKph) / 3.6 / (deltaMs / 1_000))
        : Infinity;
      if (deltaMs > SINGAPORE_BABOT_MOTION_CONTRACT.maximumSourceGapMs) {
        segment += 1;
        gapCount += 1;
      } else if (acceleration > SINGAPORE_BABOT_MOTION_CONTRACT.speedJumpLimitMps2) {
        segment += 1;
        jumpCount += 1;
      }
    }
    segmented.push({ ...point, segment });
  }
  return {
    points: segmented,
    invalidCount,
    duplicateCount: deduplicated.duplicateCount,
    outlierCount: cleaned.rejected,
    gapCount,
    jumpCount,
  };
}

function removeIsolatedLocationOutliers(points) {
  if (points.length < 5) return { points, rejected: 0 };
  const stepDistances = [];
  for (let index = 1; index < points.length; index += 1) {
    const deltaMs = points[index].tMs - points[index - 1].tMs;
    if (deltaMs > 0 && deltaMs <= SINGAPORE_BABOT_MOTION_CONTRACT.maximumSourceGapMs) {
      stepDistances.push(Math.hypot(
        points[index].x - points[index - 1].x,
        points[index].y - points[index - 1].y,
      ));
    }
  }
  const typicalStep = median(stepDistances);
  const residuals = [];
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const next = points[index + 1];
    const span = next.tMs - previous.tMs;
    if (
      span <= 0 ||
      current.tMs - previous.tMs > SINGAPORE_BABOT_MOTION_CONTRACT.maximumSourceGapMs ||
      next.tMs - current.tMs > SINGAPORE_BABOT_MOTION_CONTRACT.maximumSourceGapMs
    ) {
      continue;
    }
    const amount = (current.tMs - previous.tMs) / span;
    residuals.push(Math.hypot(
      current.x - lerp(previous.x, next.x, amount),
      current.y - lerp(previous.y, next.y, amount),
    ));
  }
  const center = median(residuals);
  const deviation = medianAbsoluteDeviation(residuals, center);
  const threshold = Math.max(50, typicalStep * 3, center + Math.max(50, deviation * 8));
  let rejected = 0;
  const kept = points.filter((current, index) => {
    if (index === 0 || index === points.length - 1) return true;
    const previous = points[index - 1];
    const next = points[index + 1];
    const span = next.tMs - previous.tMs;
    if (
      span <= 0 ||
      current.tMs - previous.tMs > SINGAPORE_BABOT_MOTION_CONTRACT.maximumSourceGapMs ||
      next.tMs - current.tMs > SINGAPORE_BABOT_MOTION_CONTRACT.maximumSourceGapMs
    ) {
      return true;
    }
    const amount = (current.tMs - previous.tMs) / span;
    const residual = Math.hypot(
      current.x - lerp(previous.x, next.x, amount),
      current.y - lerp(previous.y, next.y, amount),
    );
    if (residual <= threshold) return true;
    rejected += 1;
    return false;
  });
  return { points: kept, rejected };
}

function normalizeLocationSamples(input) {
  const parsed = [];
  let invalidCount = 0;
  for (const tuple of Array.isArray(input) ? input : []) {
    const [tMs, x, y] = [Number(tuple?.[0]), Number(tuple?.[1]), Number(tuple?.[2])];
    if (![tMs, x, y].every(Number.isFinite)) {
      invalidCount += 1;
      continue;
    }
    parsed.push({ tMs, x, y, z: finite(tuple?.[3]) });
  }
  const deduplicated = deduplicateByTime(parsed);
  const cleaned = removeIsolatedLocationOutliers(deduplicated.points);
  const rates = [];
  for (let index = 1; index < cleaned.points.length; index += 1) {
    const previous = cleaned.points[index - 1];
    const current = cleaned.points[index];
    const deltaMs = current.tMs - previous.tMs;
    if (deltaMs > 0 && deltaMs <= SINGAPORE_BABOT_MOTION_CONTRACT.maximumSourceGapMs) {
      rates.push(Math.hypot(current.x - previous.x, current.y - previous.y) / (deltaMs / 1_000));
    }
  }
  const typicalRate = median(rates);
  const rateDeviation = medianAbsoluteDeviation(rates, typicalRate);
  const jumpThreshold = Math.max(
    200,
    typicalRate * SINGAPORE_BABOT_MOTION_CONTRACT.locationJumpMedianFactor,
    typicalRate + rateDeviation * 8,
  );
  const segmented = [];
  let segment = 0;
  let gapCount = 0;
  let jumpCount = 0;
  for (const point of cleaned.points) {
    const previous = segmented.at(-1);
    if (previous) {
      const deltaMs = point.tMs - previous.tMs;
      const rate = deltaMs > 0
        ? Math.hypot(point.x - previous.x, point.y - previous.y) / (deltaMs / 1_000)
        : Infinity;
      if (deltaMs > SINGAPORE_BABOT_MOTION_CONTRACT.maximumSourceGapMs) {
        segment += 1;
        gapCount += 1;
      } else if (rate > jumpThreshold) {
        segment += 1;
        jumpCount += 1;
      }
    }
    segmented.push({ ...point, segment });
  }
  return {
    points: segmented,
    invalidCount,
    duplicateCount: deduplicated.duplicateCount,
    outlierCount: cleaned.rejected,
    gapCount,
    jumpCount,
    jumpThreshold,
  };
}

function weightedLinearFit(points, index, valueKey, windowMs) {
  const target = points[index];
  const neighbours = [];
  for (let cursor = 0; cursor < points.length; cursor += 1) {
    const candidate = points[cursor];
    const distanceMs = Math.abs(candidate.tMs - target.tMs);
    if (candidate.segment !== target.segment || distanceMs > windowMs) continue;
    const normalized = distanceMs / Math.max(1, windowMs);
    neighbours.push({
      x: (candidate.tMs - target.tMs) / 1_000,
      y: candidate[valueKey],
      weight: (1 - normalized ** 3) ** 3,
    });
  }
  if (neighbours.length < 2) {
    return { value: target[valueKey], slope: 0, confidence: 0, supportCount: neighbours.length };
  }

  const fit = (extraWeights = null) => {
    let weightTotal = 0;
    let meanX = 0;
    let meanY = 0;
    for (let cursor = 0; cursor < neighbours.length; cursor += 1) {
      const weight = neighbours[cursor].weight * (extraWeights?.[cursor] ?? 1);
      weightTotal += weight;
      meanX += neighbours[cursor].x * weight;
      meanY += neighbours[cursor].y * weight;
    }
    if (weightTotal <= 1e-12) return { intercept: target[valueKey], slope: 0 };
    meanX /= weightTotal;
    meanY /= weightTotal;
    let covariance = 0;
    let variance = 0;
    for (let cursor = 0; cursor < neighbours.length; cursor += 1) {
      const weight = neighbours[cursor].weight * (extraWeights?.[cursor] ?? 1);
      covariance += weight * (neighbours[cursor].x - meanX) * (neighbours[cursor].y - meanY);
      variance += weight * (neighbours[cursor].x - meanX) ** 2;
    }
    const slope = variance > 1e-12 ? covariance / variance : 0;
    return { intercept: meanY - slope * meanX, slope };
  };

  let result = fit();
  if (neighbours.length >= 4) {
    const residuals = neighbours.map((point) =>
      point.y - (result.intercept + result.slope * point.x));
    const residualCenter = median(residuals);
    const scale = medianAbsoluteDeviation(residuals, residualCenter) * 1.4826;
    if (scale > 1e-9) {
      const robustWeights = residuals.map((residual) => {
        const normalized = Math.abs(residual - residualCenter) / (4.685 * scale);
        return normalized >= 1 ? 0 : (1 - normalized ** 2) ** 2;
      });
      result = fit(robustWeights);
    }
  }

  const spanMs = Math.max(...neighbours.map((point) => point.x)) * 1_000 -
    Math.min(...neighbours.map((point) => point.x)) * 1_000;
  const confidence = clamp(
    Math.min(1, neighbours.length / 5) * Math.min(1, spanMs / Math.max(1, windowMs)),
  );
  return {
    value: result.intercept,
    slope: result.slope,
    confidence,
    supportCount: neighbours.length,
  };
}

function deriveCarKinematics(points, windowMs) {
  return points.map((point, index) => {
    const speedFit = weightedLinearFit(points, index, "speedKph", windowMs);
    return {
      ...point,
      smoothedSpeedKph: Math.max(0, speedFit.value),
      longG: speedFit.slope / 3.6 / GRAVITY_MPS2,
      confidence: speedFit.confidence,
    };
  });
}

function derivePathKinematics(points, headingWindowMs, yawWindowMs) {
  const headings = points.map((point, index) => {
    const xFit = weightedLinearFit(points, index, "x", headingWindowMs);
    const yFit = weightedLinearFit(points, index, "y", headingWindowMs);
    const zFit = weightedLinearFit(points, index, "z", headingWindowMs);
    const velocityMagnitude = Math.hypot(xFit.slope, yFit.slope);
    return {
      ...point,
      x: xFit.value,
      y: yFit.value,
      z: zFit.value,
      headingRad: velocityMagnitude > 1e-6 ? Math.atan2(yFit.slope, xFit.slope) : 0,
      confidence: Math.min(xFit.confidence, yFit.confidence),
    };
  });
  for (let index = 1; index < headings.length; index += 1) {
    if (headings[index].segment !== headings[index - 1].segment) continue;
    headings[index].headingRad = headings[index - 1].headingRad + wrapAngle(
      headings[index].headingRad - headings[index - 1].headingRad,
    );
  }
  return headings.map((point, index) => {
    const yawFit = weightedLinearFit(headings, index, "headingRad", yawWindowMs);
    return {
      ...point,
      headingRad: yawFit.value,
      yawRateRadS: yawFit.slope,
      confidence: Math.min(point.confidence, yawFit.confidence),
    };
  });
}

// A short dropout can contain the turn itself. Blending the two already-derived
// roll values would erase that turn, so reconstruct bounded positions first and
// then differentiate the resulting path. The original samples remain untouched.
// Monotone Hermite tangents cannot overshoot either coordinate's endpoint range.
function reconstructShortGaps(points, keys, path = false, maximumPathRate = Infinity) {
  const output = [];
  const gaps = [];
  for (let index = 0; index < points.length; index++) {
    const a = points[index];
    output.push(a);
    const b = points[index + 1];
    if (!b) continue;
    const spanMs = b.tMs - a.tMs;
    if (spanMs <= SINGAPORE_BABOT_MOTION_CONTRACT.maximumSourceGapMs ||
        spanMs > SINGAPORE_RECORDED_PLAYBACK_CONTRACT.maximumInterpolationGapMs) continue;
    const duration = spanMs / 1000;
    // A dropout can coincide with a teleport/reset. Apply the same source jump
    // limits across the missing interval before allowing any reconstructed cue.
    const rate = path ? Math.hypot(b.x - a.x, b.y - a.y) / duration
      : Math.abs(b.speedKph - a.speedKph) / 3.6 / duration;
    const rateLimit = path ? maximumPathRate : SINGAPORE_BABOT_MOTION_CONTRACT.speedJumpLimitMps2;
    if (!Number.isFinite(rate) || rate > rateLimit) continue;
    const tangents = {};
    if (path) {
      for (const key of ["x", "y"]) {
        const slope = (b[key] - a[key]) / duration;
        if (Math.abs(slope) < 1e-9) { tangents[key] = [0, 0]; continue; }
        const left = weightedLinearFit(points, index, key, 750).slope / slope;
        const right = weightedLinearFit(points, index + 1, key, 750).slope / slope;
        const alpha = clamp(left, 0, 3), beta = clamp(right, 0, 3);
        const magnitude = Math.hypot(alpha, beta);
        const scale = magnitude > 3 ? 3 / magnitude : 1;
        tangents[key] = [alpha * slope * scale, beta * slope * scale];
      }
    }
    gaps.push({ startMs: a.tMs, endMs: b.tMs });
    const divisions = Math.ceil(spanMs / 200);
    for (let step = 1; step < divisions; step++) {
      const u = step / divisions;
      const point = { ...a, tMs: a.tMs + spanMs * u, reconstructed: true };
      for (const key of keys) {
        if (path && tangents[key]) {
          const [left, right] = tangents[key];
          point[key] = (2 * u ** 3 - 3 * u ** 2 + 1) * a[key] +
            (u ** 3 - 2 * u ** 2 + u) * duration * left +
            (-2 * u ** 3 + 3 * u ** 2) * b[key] +
            (u ** 3 - u ** 2) * duration * right;
        } else point[key] = lerp(a[key], b[key], u);
      }
      // Discrete channels are never used to manufacture a new pedal/gear event.
      if (!path) for (const key of ["brakeOn", "gear", "drs"]) point[key] = a[key];
      output.push(point);
    }
  }
  return { points: output, gaps };
}

function bracketAt(points, requestedMs) {
  if (!points.length || requestedMs < points[0].tMs || requestedMs > points.at(-1).tMs) {
    return null;
  }
  if (requestedMs === points[0].tMs) return { low: points[0], high: points[0], amount: 0 };
  if (requestedMs === points.at(-1).tMs) {
    return { low: points.at(-1), high: points.at(-1), amount: 0 };
  }
  let lowIndex = 0;
  let highIndex = points.length - 1;
  while (lowIndex + 1 < highIndex) {
    const middle = (lowIndex + highIndex) >> 1;
    if (points[middle].tMs <= requestedMs) lowIndex = middle;
    else highIndex = middle;
  }
  const low = points[lowIndex];
  const high = points[highIndex];
  if (
    low.segment !== high.segment ||
    high.tMs - low.tMs > SINGAPORE_BABOT_MOTION_CONTRACT.maximumSourceGapMs
  ) {
    return null;
  }
  return {
    low,
    high,
    amount: clamp((requestedMs - low.tMs) / Math.max(1, high.tMs - low.tMs)),
  };
}

function interpolateContinuous(bracket, key, fallback = 0) {
  if (!bracket) return fallback;
  return lerp(finite(bracket.low[key], fallback), finite(bracket.high[key], fallback), bracket.amount);
}

function interpolateDiscrete(bracket, key, fallback = 0) {
  if (!bracket) return fallback;
  return finite((bracket.amount < 0.5 ? bracket.low : bracket.high)[key], fallback);
}

export function normalizeSingaporeDerivedMotion(longG, latG, options = {}) {
  const longitudinalScale = Math.max(
    0.01,
    finite(options.longitudinalSoftScaleG, SINGAPORE_BABOT_MOTION_CONTRACT.longitudinalSoftScaleG),
  );
  const lateralScale = Math.max(
    0.01,
    finite(options.lateralSoftScaleG, SINGAPORE_BABOT_MOTION_CONTRACT.lateralSoftScaleG),
  );
  return Object.freeze({
    pitch: -Math.tanh(finite(longG) / longitudinalScale),
    roll: Math.tanh(finite(latG) / lateralScale),
  });
}

function confidenceLabel(score) {
  if (score >= 0.7) return "moderate";
  if (score >= 0.4) return "limited";
  return "low";
}

function emptyResult(meta, car, location, reason) {
  return deepFreeze({
    provenance: {
      source: "OpenF1",
      measuredG: false,
      label: SINGAPORE_BABOT_MOTION_CONTRACT.provenanceLabel,
      warning: SINGAPORE_BABOT_MOTION_CONTRACT.honestyLabel,
      method: {
        longitudinal: "timestamp-aware derivative of robustly smoothed speed",
        lateral: "speed multiplied by yaw rate from robustly smoothed, unwrapped path heading",
      },
      fixtureMeta: cloneSerializable(meta ?? {}),
    },
    confidence: 0,
    confidenceDetails: {
      score: 0,
      label: "low",
      longitudinal: 0,
      lateral: 0,
      reasons: [reason],
    },
    diagnostics: {
      inputCarSampleCount: Array.isArray(car) ? car.length : 0,
      inputLocationSampleCount: Array.isArray(location) ? location.length : 0,
      outputSampleCount: 0,
    },
    samples: [],
  });
}

export function buildSingaporeBabotMotionSeries(fixture, options = {}) {
  if (!fixture || typeof fixture !== "object") {
    throw new TypeError("Singapore motion fixture must be an object");
  }
  if (!Array.isArray(fixture.carSamples) || !Array.isArray(fixture.locationSamples)) {
    throw new TypeError("Singapore motion fixture requires carSamples and locationSamples arrays");
  }
  const car = normalizeCarSamples(fixture.carSamples);
  const location = normalizeLocationSamples(fixture.locationSamples);
  if (car.points.length < 3 || location.points.length < 3) {
    return emptyResult(
      fixture.meta,
      fixture.carSamples,
      fixture.locationSamples,
      "At least three valid car and location samples are required",
    );
  }

  const speedWindowMs = Math.max(
    400,
    finite(options.speedSmoothingWindowMs, SINGAPORE_BABOT_MOTION_CONTRACT.speedSmoothingWindowMs),
  );
  const headingWindowMs = Math.max(
    400,
    finite(options.headingSmoothingWindowMs, SINGAPORE_BABOT_MOTION_CONTRACT.headingSmoothingWindowMs),
  );
  const yawWindowMs = Math.max(
    400,
    finite(options.yawSmoothingWindowMs, SINGAPORE_BABOT_MOTION_CONTRACT.yawSmoothingWindowMs),
  );
  const carKinematics = deriveCarKinematics(car.points, speedWindowMs);
  const pathKinematics = derivePathKinematics(location.points, headingWindowMs, yawWindowMs);
  const sourceStartMs = Math.max(carKinematics[0].tMs, pathKinematics[0].tMs);
  const sourceEndMs = Math.min(carKinematics.at(-1).tMs, pathKinematics.at(-1).tMs);
  const intervalMs = SINGAPORE_BABOT_MOTION_CONTRACT.outputIntervalMs;
  const gridStartMs = Math.ceil(sourceStartMs / intervalMs) * intervalMs;
  const gridEndMs = Math.floor(sourceEndMs / intervalMs) * intervalMs;
  if (gridEndMs < gridStartMs) {
    return emptyResult(
      fixture.meta,
      fixture.carSamples,
      fixture.locationSamples,
      "Car and location timelines do not overlap",
    );
  }
  const lapTimelineDurationMs = finite(
    fixture.meta?.durationMs,
    finite(fixture.meta?.lapDurationMs, gridEndMs - gridStartMs),
  );

  const samples = [];
  const longitudinalConfidences = [];
  const lateralConfidences = [];
  const responseMs = Math.max(0, finite(options.longitudinalCueResponseMs,
    SINGAPORE_BABOT_MOTION_CONTRACT.longitudinalCueResponseMs));
  const responseAmount = responseMs > 0 ? -Math.expm1(-intervalMs / responseMs) : 1;
  let previousLongG = null;
  for (let sourceTimeMs = gridStartMs; sourceTimeMs <= gridEndMs; sourceTimeMs += intervalMs) {
    const carBracket = bracketAt(carKinematics, sourceTimeMs);
    const pathBracket = bracketAt(pathKinematics, sourceTimeMs);
    const longitudinalConfidence = clamp(interpolateContinuous(carBracket, "confidence"));
    const pathConfidence = clamp(interpolateContinuous(pathBracket, "confidence"));
    const smoothedSpeedKph = Math.max(0, interpolateContinuous(carBracket, "smoothedSpeedKph"));
    const speedMps = smoothedSpeedKph / 3.6;
    const speedFade = smoothstep(
      (speedMps - SINGAPORE_BABOT_MOTION_CONTRACT.lateralFadeStartMps) /
        Math.max(
          0.01,
          SINGAPORE_BABOT_MOTION_CONTRACT.lateralFadeFullMps -
            SINGAPORE_BABOT_MOTION_CONTRACT.lateralFadeStartMps,
        ),
    );
    const lateralConfidence = pathBracket && carBracket
      ? clamp(Math.min(pathConfidence, longitudinalConfidence) * speedFade)
      : 0;
    const rawLongG = carBracket ? interpolateContinuous(carBracket, "longG") : 0;
    const rawLatG = pathBracket && carBracket
      ? speedMps * interpolateContinuous(pathBracket, "yawRateRadS") / GRAVITY_MPS2 * speedFade
      : 0;
    const maximumG = SINGAPORE_BABOT_MOTION_CONTRACT.maximumEstimatedAbsG;
    const boundedLongG = clamp(rawLongG, -maximumG, maximumG);
    // A short causal response controls jerk without looking farther into future
    // braking data. Reset across unavailable source segments, never stale-hold.
    const longG = carBracket && previousLongG !== null
      ? lerp(previousLongG, boundedLongG, responseAmount) : boundedLongG;
    previousLongG = carBracket ? longG : null;
    const latG = clamp(rawLatG, -maximumG, maximumG);
    const normalized = normalizeSingaporeDerivedMotion(longG, latG, options);
    const validLongitudinal = Boolean(carBracket) && longitudinalConfidence > 0;
    const validLateral = Boolean(pathBracket && carBracket) && lateralConfidence > 0;
    const confidence = Math.min(longitudinalConfidence, lateralConfidence);
    longitudinalConfidences.push(longitudinalConfidence);
    lateralConfidences.push(lateralConfidence);
    samples.push(Object.freeze({
      timeMs: sourceTimeMs,
      pitch: validLongitudinal ? normalized.pitch : 0,
      roll: validLateral ? normalized.roll : 0,
      longG: validLongitudinal ? longG : 0,
      latG: validLateral ? latG : 0,
      confidence,
      longitudinalConfidence,
      lateralConfidence,
      valid: validLongitudinal && validLateral,
      speedKph: Math.max(0, interpolateContinuous(carBracket, "speedKph")),
      rpm: Math.max(0, interpolateContinuous(carBracket, "rpm")),
      throttlePct: clamp(interpolateContinuous(carBracket, "throttlePct"), 0, 100),
      brakeOn: interpolateDiscrete(carBracket, "brakeOn") > 0 ? 1 : 0,
      gear: Math.max(0, Math.round(interpolateDiscrete(carBracket, "gear"))),
      drs: Math.round(interpolateDiscrete(carBracket, "drs")),
      x: interpolateContinuous(pathBracket, "x"),
      y: interpolateContinuous(pathBracket, "y"),
      z: interpolateContinuous(pathBracket, "z"),
      headingRad: interpolateContinuous(pathBracket, "headingRad"),
      yawRateRadS: interpolateContinuous(pathBracket, "yawRateRadS"),
    }));
  }

  const longitudinalScore = clamp(
    longitudinalConfidences.reduce((sum, value) => sum + value, 0) /
      Math.max(1, longitudinalConfidences.length),
  );
  const lateralScore = clamp(
    lateralConfidences.reduce((sum, value) => sum + value, 0) /
      Math.max(1, lateralConfidences.length),
  );
  // Derived OpenF1 motion can be useful, but approximate 3.7 Hz location data
  // should never be promoted to high-confidence measured acceleration.
  const confidenceScore = Math.min(
    SINGAPORE_BABOT_MOTION_CONTRACT.maximumModelConfidence,
    Math.sqrt(longitudinalScore * lateralScore),
  );
  const reasons = [
    "Longitudinal acceleration is differentiated from smoothed OpenF1 speed",
    "Lateral acceleration uses approximate OpenF1 path heading and does not resolve racing-line placement",
  ];
  if (car.gapCount + location.gapCount > 0) reasons.push("Strict source samples remain unavailable across gaps; playback may reconstruct bounded short gaps separately with lower confidence");
  if (car.jumpCount + location.jumpCount + car.outlierCount + location.outlierCount > 0) {
    reasons.push("Detected source jumps or isolated outliers were rejected");
  }

  const result = {
    provenance: {
      source: "OpenF1",
      measuredG: false,
      label: SINGAPORE_BABOT_MOTION_CONTRACT.provenanceLabel,
      warning: SINGAPORE_BABOT_MOTION_CONTRACT.honestyLabel,
      method: {
        longitudinal: "longG = d(smoothed speed)/dt / 9.80665, with a short causal cue response",
        lateral: "latG = smoothed speed * d(unwrapped smoothed path heading)/dt / 9.80665",
        normalization: "normalized pitch/roll use bounded tanh soft saturation",
      },
      fixtureMeta: cloneSerializable(fixture.meta ?? {}),
      fixtureProvenance: cloneSerializable(fixture.provenance ?? {}),
    },
    confidence: confidenceScore,
    confidenceDetails: {
      score: confidenceScore,
      label: confidenceLabel(confidenceScore),
      longitudinal: longitudinalScore,
      lateral: lateralScore,
      reasons,
    },
    diagnostics: {
      inputCarSampleCount: fixture.carSamples.length,
      acceptedCarSampleCount: car.points.length,
      rejectedCarSampleCount: car.invalidCount + car.duplicateCount + car.outlierCount,
      inputLocationSampleCount: fixture.locationSamples.length,
      acceptedLocationSampleCount: location.points.length,
      rejectedLocationSampleCount:
        location.invalidCount + location.duplicateCount + location.outlierCount,
      carGapCount: car.gapCount,
      locationGapCount: location.gapCount,
      carJumpCount: car.jumpCount,
      locationJumpCount: location.jumpCount,
      carOutlierCount: car.outlierCount,
      locationOutlierCount: location.outlierCount,
      carSourceHz: estimatedRateHz(car.points),
      locationSourceHz: estimatedRateHz(location.points),
      sourceStartMs: gridStartMs,
      sourceEndMs: gridEndMs,
      carTimelineStartMs: carKinematics[0].tMs,
      carTimelineEndMs: carKinematics.at(-1).tMs,
      locationTimelineStartMs: pathKinematics[0].tMs,
      locationTimelineEndMs: pathKinematics.at(-1).tMs,
      leadingTrimMs: Math.max(0, gridStartMs),
      trailingTrimMs: Math.max(0, lapTimelineDurationMs - gridEndMs),
      sourceOverlapLeadTrimMs:
        gridStartMs - Math.min(carKinematics[0].tMs, pathKinematics[0].tMs),
      sourceOverlapTailTrimMs:
        Math.max(carKinematics.at(-1).tMs, pathKinematics.at(-1).tMs) - gridEndMs,
      lapTimelineDurationMs,
      lapTailUncoveredMs: Math.max(
        0,
        lapTimelineDurationMs - gridEndMs,
      ),
      durationMs: gridEndMs - gridStartMs,
      outputIntervalMs: intervalMs,
      outputHz: 1_000 / intervalMs,
      outputSampleCount: samples.length,
    },
    samples,
  };
  if (options.reconstructPlayback !== false) {
    const reconstructedCar = reconstructShortGaps(car.points, ["speedKph", "rpm", "throttlePct"]);
    const reconstructedPath = reconstructShortGaps(location.points, ["x", "y", "z"], true, location.jumpThreshold);
    const carGaps = reconstructedCar.gaps;
    const pathGaps = reconstructedPath.gaps;
    let playback = result;
    if (carGaps.length || pathGaps.length) {
      playback = buildSingaporeBabotMotionSeries({
        ...fixture,
        carSamples: reconstructedCar.points.map(p => [p.tMs, p.speedKph, p.rpm, p.throttlePct, p.brakeOn, p.gear, p.drs]),
        locationSamples: reconstructedPath.points.map(p => [p.tMs, p.x, p.y, p.z]),
      }, { ...options, reconstructPlayback: false });
      result.diagnostics.reconstructedCarGaps = carGaps;
      result.diagnostics.reconstructedPathGaps = pathGaps;
      result.provenance.method.playbackReconstruction = "Inside gaps up to 1200 ms: linear speed and bounded monotone-Hermite path, before differentiation; confidence capped at 0.35";
    }
    const touches = (time, gaps, support) => gaps.some(gap => time > gap.startMs - support && time < gap.endMs + support);
    const inside = (time, gaps) => gaps.some(gap => time >= gap.startMs && time <= gap.endMs);
    result.playbackSamples = playback.samples.map(sample => {
      const sourceValid = singaporeMotionAt(result, sample.timeMs / 1000).valid;
      const reconstructed = touches(sample.timeMs, carGaps, speedWindowMs) ||
        touches(sample.timeMs, pathGaps, headingWindowMs + yawWindowMs);
      const cap = reconstructed ? SINGAPORE_RECORDED_PLAYBACK_CONTRACT.maximumReconstructedConfidence :
        SINGAPORE_BABOT_MOTION_CONTRACT.maximumModelConfidence;
      // Recomputing source statistics must never turn an unrelated jump or long
      // dropout into an accepted pose merely because another gap was rebuilt.
      const supported = (bracketAt(carKinematics, sample.timeMs) || inside(sample.timeMs, carGaps)) &&
        (bracketAt(pathKinematics, sample.timeMs) || inside(sample.timeMs, pathGaps));
      return {
        ...sample, valid: sample.valid && Boolean(supported), sourceValid, reconstructed,
        cueSource: reconstructed ? "reconstructed-path-and-speed" : "derived-source",
        confidence: Math.min(sample.confidence, cap),
        longitudinalConfidence: Math.min(sample.longitudinalConfidence, cap),
        lateralConfidence: Math.min(sample.lateralConfidence, cap),
      };
    });
  }
  return deepFreeze(result);
}

const CONTINUOUS_SAMPLE_KEYS = Object.freeze([
  "pitch",
  "roll",
  "longG",
  "latG",
  "confidence",
  "longitudinalConfidence",
  "lateralConfidence",
  "speedKph",
  "rpm",
  "throttlePct",
  "x",
  "y",
  "z",
  "headingRad",
  "yawRateRadS",
]);

function neutralMotionFrom(sample, requestedMs) {
  return Object.freeze({
    ...sample,
    timeMs: requestedMs,
    pitch: 0,
    roll: 0,
    longG: 0,
    latG: 0,
    confidence: 0,
    longitudinalConfidence: 0,
    lateralConfidence: 0,
    valid: false,
  });
}

export function singaporeMotionAt(series, elapsedSeconds) {
  const samples = Array.isArray(series) ? series : series?.samples;
  const requestedMs =
    Math.round(finite(elapsedSeconds) * 1_000 * 1_000_000) / 1_000_000;
  if (!Array.isArray(samples) || samples.length === 0) {
    return deepFreeze({
      timeMs: requestedMs,
      pitch: 0,
      roll: 0,
      longG: 0,
      latG: 0,
      confidence: 0,
      longitudinalConfidence: 0,
      lateralConfidence: 0,
      valid: false,
      speedKph: 0,
      rpm: 0,
      throttlePct: 0,
      brakeOn: 0,
      gear: 0,
      drs: 0,
      x: 0,
      y: 0,
      z: 0,
      headingRad: 0,
      yawRateRadS: 0,
    });
  }
  if (requestedMs < samples[0].timeMs) {
    return neutralMotionFrom(samples[0], requestedMs);
  }
  if (requestedMs > samples.at(-1).timeMs) {
    return neutralMotionFrom(samples.at(-1), requestedMs);
  }
  if (requestedMs === samples[0].timeMs) return samples[0];
  if (requestedMs === samples.at(-1).timeMs) return samples.at(-1);
  let lowIndex = 0;
  let highIndex = samples.length - 1;
  while (lowIndex + 1 < highIndex) {
    const middle = (lowIndex + highIndex) >> 1;
    if (samples[middle].timeMs <= requestedMs) lowIndex = middle;
    else highIndex = middle;
  }
  const low = samples[lowIndex];
  const high = samples[highIndex];
  if (requestedMs === low.timeMs) return low;
  if (requestedMs === high.timeMs) return high;
  const amount = clamp((requestedMs - low.timeMs) / Math.max(1, high.timeMs - low.timeMs));
  const nearest = amount < 0.5 ? low : high;
  const interpolated = {
    timeMs: requestedMs,
    valid: low.valid && high.valid,
    brakeOn: nearest.brakeOn,
    gear: nearest.gear,
    drs: nearest.drs,
  };
  for (const key of CONTINUOUS_SAMPLE_KEYS) {
    interpolated[key] = lerp(finite(low[key]), finite(high[key]), amount);
  }
  return Object.freeze(interpolated);
}

// The recorded 2026 pole lap has three valid-pose brackets of 1120, 1160,
// and 1180 ms, plus 300 ms / 173 ms of uncovered leading / trailing time.
// These are playback limits, not a change to the strict source-data model.
export const SINGAPORE_RECORDED_PLAYBACK_CONTRACT = Object.freeze({
  maximumInterpolationGapMs: 1200,
  maximumEndpointHoldMs: 350,
  maximumNormalizedAxis: 1,
  maximumReconstructedConfidence: 0.35,
});

const DISCRETE_SAMPLE_KEYS = Object.freeze(["brakeOn", "gear", "drs"]);

function finitePlaybackSample(sample) {
  return sample?.valid === true && Number.isFinite(sample.timeMs) &&
    [...CONTINUOUS_SAMPLE_KEYS, ...DISCRETE_SAMPLE_KEYS].every((key) => Number.isFinite(sample[key])) &&
    Math.abs(sample.pitch) <= 1 && Math.abs(sample.roll) <= 1;
}

/**
 * Prepare once for an immutable, recorded lap; call the returned sampler with
 * lap seconds. `valid` means a bounded playback pose is available, while
 * `sourceValid` retains the strict source sampler's validity. Gap interpolation
 * and endpoint holds are disclosed in `playbackMode`. This has no live clock,
 * USB, arming, or watchdog authority: those checks still belong to the caller.
 */
export function createSingaporePlaybackMotionSampler(series, options = {}) {
  const durationSeconds = options.durationSeconds ?? series?.diagnostics?.lapTimelineDurationMs / 1000;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new TypeError("Recorded playback requires a finite positive lap duration");
  }
  const durationMs = durationSeconds * 1000;
  const input = Array.isArray(series) ? series : series?.playbackSamples ?? series?.samples;
  const hasReconstructedSeries = !Array.isArray(series) && Array.isArray(series?.playbackSamples);
  const samples = (Array.isArray(input) ? input : [])
    .filter((sample) => finitePlaybackSample(sample) && sample.timeMs >= 0 && sample.timeMs <= durationMs)
    .map((sample) => Object.freeze({ ...sample }))
    .sort((left, right) => left.timeMs - right.timeMs)
    .filter((sample, index, sorted) => !index || sample.timeMs !== sorted[index - 1].timeMs);
  const { maximumInterpolationGapMs, maximumEndpointHoldMs } = SINGAPORE_RECORDED_PLAYBACK_CONTRACT;

  return function playbackMotionAt(elapsedSeconds) {
    const finiteTime = Number.isFinite(elapsedSeconds);
    const requestedMs = finiteTime ? Math.round(elapsedSeconds * 1e9) / 1e6 : 0;
    const unavailable = (playbackReason) => Object.freeze({
      ...singaporeMotionAt([], requestedMs / 1000),
      sourceValid: false,
      playbackMode: "unavailable",
      playbackReason,
    });
    // Never clamp a stale or out-of-window clock into an indefinitely held pose.
    if (!finiteTime || elapsedSeconds < 0 || elapsedSeconds > durationSeconds) {
      return unavailable("outside-recorded-lap");
    }
    if (!samples.length) return unavailable("no-finite-valid-samples");

    const first = samples[0];
    const last = samples.at(-1);
    if (requestedMs < first.timeMs || requestedMs > last.timeMs) {
      const leading = requestedMs < first.timeMs;
      const endpoint = leading ? first : last;
      // The entire uncovered endpoint must be short, not just this request's
      // distance to it. A long missing opening/ending cannot become valid midway.
      const uncoveredMs = leading ? first.timeMs : durationMs - last.timeMs;
      if (uncoveredMs > maximumEndpointHoldMs) return unavailable("endpoint-hold-limit");
      return Object.freeze({
        ...endpoint,
        timeMs: requestedMs,
        valid: true,
        sourceValid: false,
        playbackMode: leading ? "held-start" : "held-end",
        playbackReason: "short-recorded-endpoint",
      });
    }

    // A prepared model has already decided which source gaps can be rebuilt.
    // Do not bridge its remaining invalid regions (for example source jumps).
    if (hasReconstructedSeries && !finitePlaybackSample(singaporeMotionAt(input, elapsedSeconds))) {
      return unavailable("unsupported-source-gap");
    }

    let lowIndex = 0;
    let highIndex = samples.length - 1;
    while (lowIndex + 1 < highIndex) {
      const middle = (lowIndex + highIndex) >> 1;
      if (samples[middle].timeMs <= requestedMs) lowIndex = middle;
      else highIndex = middle;
    }
    const low = samples[lowIndex];
    const high = samples[highIndex];
    const exact = requestedMs === low.timeMs ? low : requestedMs === high.timeMs ? high : null;
    if (exact) return Object.freeze({
      ...exact,
      sourceValid: finitePlaybackSample(singaporeMotionAt(series, elapsedSeconds)),
      playbackMode: exact.reconstructed ? "reconstructed-gap" : "source",
      playbackReason: exact.reconstructed ? "bounded-source-reconstruction" : "valid-recorded-pose",
    });
    const spanMs = high.timeMs - low.timeMs;
    if (spanMs > maximumInterpolationGapMs) return unavailable("interpolation-gap-limit");
    const amount = (requestedMs - low.timeMs) / spanMs;
    const nearest = amount < 0.5 ? low : high;
    const sourceValid = finitePlaybackSample(singaporeMotionAt(series, elapsedSeconds));
    const interpolated = {
      timeMs: requestedMs,
      valid: true,
      sourceValid,
      reconstructed: Boolean(low.reconstructed || high.reconstructed),
      cueSource: low.reconstructed || high.reconstructed ? "reconstructed-path-and-speed" : "derived-source",
      playbackMode: low.reconstructed || high.reconstructed ? "reconstructed-gap" : sourceValid ? "source" : "interpolated-gap",
      playbackReason: low.reconstructed || high.reconstructed ? "bounded-source-reconstruction" : sourceValid ? "valid-recorded-pose" : "short-recorded-gap",
      brakeOn: nearest.brakeOn,
      gear: nearest.gear,
      drs: nearest.drs,
    };
    // A convex blend cannot overshoot either valid normalized endpoint. Do not
    // extrapolate derivatives or bridge via the strict model's neutral placeholders.
    for (const key of CONTINUOUS_SAMPLE_KEYS) interpolated[key] = lerp(low[key], high[key], amount);
    // An off-grid sample touching reconstructed support inherits its lower
    // confidence even when the other endpoint is an ordinary derived cue.
    if (interpolated.reconstructed) {
      for (const key of ["confidence", "longitudinalConfidence", "lateralConfidence"]) {
        interpolated[key] = Math.min(interpolated[key], SINGAPORE_RECORDED_PLAYBACK_CONTRACT.maximumReconstructedConfidence);
      }
    }
    return Object.freeze(interpolated);
  };
}
