export const GEAR_COUNT = 8;

export const GEAR_ORB = Object.freeze({
  rpmMin: 7_500,
  rpmMax: 12_200,
  activeScaleMin: 0.68,
  activeScaleMax: 1.45,
  inactiveScale: 0.16,
});

const GEAR_LANE_SPACING = 1.14;

export const GEAR_LANES = Object.freeze(
  Array.from({ length: GEAR_COUNT }, (_, index) =>
    Object.freeze({
      gear: index + 1,
      x: (index - (GEAR_COUNT - 1) / 2) * GEAR_LANE_SPACING,
    }),
  ),
);

export const GEAR_CAMERA = Object.freeze({
  fovDegrees: 40,
  near: 0.1,
  far: 140,
  baseDistance: 12,
  horizontalExtent: 5.05,
  verticalExtent: 3.2,
  positionY: 0.38,
  vanishingPoint: Object.freeze({ x: 0, y: 0.38, z: -48 }),
});

export const GEAR_TRAIL = Object.freeze({
  pointCount: 121,
  frontZ: 0,
  horizonZ: GEAR_CAMERA.vanishingPoint.z,
  radiusScale: 0.22,
  horizonRadiusScale: 0.16,
  activeOpacity: 0.92,
  inactiveOpacity: 0.34,
  horizonOpacityScale: 0.28,
  speedMinKph: 0,
  speedMaxKph: 350,
  liftMin: -1.15,
  liftMax: 1.35,
});

export function clamp(value, min = 0, max = 1) {
  const finiteValue = Number.isFinite(value) ? value : min;
  return Math.min(max, Math.max(min, finiteValue));
}

export function lerp(start, end, amount) {
  return start + (end - start) * amount;
}

export function smoothstep(amount) {
  const normalized = clamp(amount);
  return normalized * normalized * (3 - 2 * normalized);
}

export function clampGear(gear) {
  const numericGear = Number.isFinite(Number(gear)) ? Number(gear) : 1;
  return Math.round(clamp(numericGear, 1, GEAR_COUNT));
}

function finiteNumber(value, fallback = 0) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

export function tupleToGearSample(tuple) {
  return {
    t: finiteNumber(tuple?.[0]),
    speed: Math.max(0, finiteNumber(tuple?.[1])),
    rpm: Math.max(0, finiteNumber(tuple?.[2])),
    throttle: clamp(finiteNumber(tuple?.[3]), 0, 100),
    brake: Math.max(0, finiteNumber(tuple?.[4])),
    gear: clampGear(tuple?.[5]),
  };
}

function objectToGearSample(sample) {
  return {
    t: finiteNumber(sample?.t ?? sample?.t_s),
    speed: Math.max(0, finiteNumber(sample?.speed ?? sample?.speed_kph)),
    rpm: Math.max(0, finiteNumber(sample?.rpm)),
    throttle: clamp(
      finiteNumber(sample?.throttle ?? sample?.throttle_pct),
      0,
      100,
    ),
    brake: Math.max(0, finiteNumber(sample?.brake)),
    gear: clampGear(sample?.gear ?? sample?.n_gear),
  };
}

function toGearSample(sample) {
  return Array.isArray(sample)
    ? tupleToGearSample(sample)
    : objectToGearSample(sample);
}

function sampleTime(sample) {
  return Array.isArray(sample)
    ? finiteNumber(sample[0])
    : finiteNumber(sample?.t ?? sample?.t_s);
}

/**
 * Interpolates continuous telemetry while keeping a shift as a hard event.
 * Gear, RPM and brake all switch together at the interval midpoint, avoiding
 * fractional gears or a synthetic RPM sweep through an actual up/downshift.
 */
export function sampleGearTelemetryAt(samples, time) {
  if (!samples?.length) {
    return tupleToGearSample([finiteNumber(time), 0, 0, 0, 0, 1]);
  }

  const requestedTime = finiteNumber(time, sampleTime(samples[0]));
  const first = toGearSample(samples[0]);
  const last = toGearSample(samples.at(-1));

  if (requestedTime <= first.t) return first;
  if (requestedTime >= last.t) return last;

  let low = 0;
  let high = samples.length - 1;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (sampleTime(samples[middle]) <= requestedTime) low = middle;
    else high = middle;
  }

  const current = toGearSample(samples[low]);
  const next = toGearSample(samples[high]);
  const amount = clamp(
    (requestedTime - current.t) / Math.max(0.001, next.t - current.t),
  );
  const useNextDiscreteState = amount >= 0.5;
  const gearChanged = current.gear !== next.gear;

  return {
    t: requestedTime,
    speed: lerp(current.speed, next.speed, amount),
    rpm: gearChanged
      ? useNextDiscreteState
        ? next.rpm
        : current.rpm
      : lerp(current.rpm, next.rpm, amount),
    throttle: lerp(current.throttle, next.throttle, amount),
    brake: useNextDiscreteState ? next.brake : current.brake,
    gear: gearChanged && useNextDiscreteState ? next.gear : current.gear,
  };
}

export function gearOrbTargetScale(sample, laneGear) {
  const telemetry = toGearSample(sample);
  if (telemetry.gear !== clampGear(laneGear)) return GEAR_ORB.inactiveScale;

  const rpmAmount = clamp(
    (telemetry.rpm - GEAR_ORB.rpmMin) / (GEAR_ORB.rpmMax - GEAR_ORB.rpmMin),
  );
  return lerp(
    GEAR_ORB.activeScaleMin,
    GEAR_ORB.activeScaleMax,
    smoothstep(rpmAmount),
  );
}

/**
 * @param {number} speed
 * @param {number} [speedMaxKph]
 */
export function speedToSharedLift(
  speed,
  speedMaxKph = GEAR_TRAIL.speedMaxKph,
) {
  const safeMaximum = Math.max(
    GEAR_TRAIL.speedMinKph + 1,
    finiteNumber(speedMaxKph, GEAR_TRAIL.speedMaxKph),
  );
  const normalizedSpeed = clamp(
    (finiteNumber(speed) - GEAR_TRAIL.speedMinKph) /
      (safeMaximum - GEAR_TRAIL.speedMinKph),
  );
  return lerp(GEAR_TRAIL.liftMin, GEAR_TRAIL.liftMax, normalizedSpeed);
}

/**
 * Returns the camera's front-plane distance while preserving a centered,
 * fixed one-point perspective and fitting every lane at common aspect ratios.
 */
export function gearTubeCameraDistance(aspectRatio) {
  const safeAspect = Math.max(
    0.32,
    Number.isFinite(aspectRatio) ? aspectRatio : 1,
  );
  const halfFovRadians = (GEAR_CAMERA.fovDegrees * Math.PI) / 360;
  const tangent = Math.tan(halfFovRadians);
  const horizontalFit = GEAR_CAMERA.horizontalExtent / (tangent * safeAspect);
  const verticalFit = GEAR_CAMERA.verticalExtent / tangent;
  return Math.max(GEAR_CAMERA.baseDistance, horizontalFit, verticalFit);
}

/**
 * Builds one front-to-horizon tube. The history domain always starts at the
 * lap's first sample, so a fixed telemetry event moves toward the horizon as
 * elapsed time advances instead of remaining pinned to a screen coordinate.
 */
export function buildGearTrail(samples, elapsed, laneGear, options = {}) {
  if (!samples?.length) return [];

  const gear = clampGear(laneGear);
  const lane = GEAR_LANES[gear - 1];
  const pointCount = Math.max(
    2,
    Math.round(finiteNumber(options.pointCount, GEAR_TRAIL.pointCount)),
  );
  const firstTime = sampleTime(samples[0]);
  const lastTime = sampleTime(samples.at(-1));
  const requestedStart = finiteNumber(options.startTime, firstTime);
  const startTime = clamp(requestedStart, firstTime, lastTime);
  const safeElapsed = clamp(finiteNumber(elapsed, startTime), startTime, lastTime);
  const historyDuration = Math.max(0, safeElapsed - startTime);
  const speedMaximum = finiteNumber(
    options.speedMaxKph,
    GEAR_TRAIL.speedMaxKph,
  );

  return Array.from({ length: pointCount }, (_, index) => {
    const age = index / (pointCount - 1);
    const time = safeElapsed - historyDuration * age;
    const sample = sampleGearTelemetryAt(samples, time);
    const perspective = 1 - age;
    const active = sample.gear === gear;
    const targetScale = gearOrbTargetScale(sample, gear);
    const radiusPerspective = lerp(
      GEAR_TRAIL.horizonRadiusScale,
      1,
      perspective,
    );
    const opacity =
      (active ? GEAR_TRAIL.activeOpacity : GEAR_TRAIL.inactiveOpacity) *
      lerp(GEAR_TRAIL.horizonOpacityScale, 1, perspective);

    return {
      time,
      x: lerp(GEAR_CAMERA.vanishingPoint.x, lane.x, perspective),
      y: lerp(
        GEAR_CAMERA.vanishingPoint.y,
        speedToSharedLift(sample.speed, speedMaximum),
        perspective,
      ),
      z: lerp(GEAR_TRAIL.horizonZ, GEAR_TRAIL.frontZ, perspective),
      radius: GEAR_TRAIL.radiusScale * targetScale * radiusPerspective,
      active,
      opacity,
      brake: sample.brake > 0,
      gear: sample.gear,
      rpm: sample.rpm,
      speed: sample.speed,
    };
  });
}
