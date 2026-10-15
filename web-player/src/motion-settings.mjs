import { DEFAULT_MOUNTING_CALIBRATION, validateMountingCalibration } from './protocol.mjs';

export const CHASSIS_LIMITS = Object.freeze({ roll: 8, pitch: 3 });
export const DEFAULT_MOTION_STRENGTH = 0.25;
export const MOUNTING_STORAGE_KEY = 'babot.mounting.v1';

/** Both axes use one scale so the physical cue keeps the displayed balance. */
export function motionAmplitudes(strength) {
  const amount = Number.isFinite(strength) ? Math.max(0, Math.min(1, strength)) : 0;
  return { roll: CHASSIS_LIMITS.roll * amount, pitch: CHASSIS_LIMITS.pitch * amount };
}

export function readMountingCalibration(storage) {
  try {
    const stored = JSON.parse(storage.getItem(MOUNTING_STORAGE_KEY));
    if (stored?.version !== 1) return { ...DEFAULT_MOUNTING_CALIBRATION };
    return validateMountingCalibration(stored.mounting);
  } catch {
    return { ...DEFAULT_MOUNTING_CALIBRATION };
  }
}

export function saveMountingCalibration(storage, mounting) {
  const validated = validateMountingCalibration(mounting);
  storage.setItem(MOUNTING_STORAGE_KEY, JSON.stringify({ version: 1, mounting: validated }));
  return validated;
}
