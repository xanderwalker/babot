import { DEFAULT_MOUNTING_CALIBRATION, validateMountingCalibration } from './protocol.mjs';

export const CHASSIS_LIMITS = Object.freeze({ roll: 8, pitch: 3 });
export const DEFAULT_MOTION_STRENGTH = 0.25;
export const MOUNTING_STORAGE_KEY = 'babot.mounting.v1';
export const MOUNTING_BACKUP_VERSION = 1;
export const MAX_MOUNTING_BACKUP_LENGTH = 4096;

const hasExactKeys = (value, keys) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));

/** Calibration-only v1 envelope, also compatible with existing browser storage. */
export function serializeMountingCalibrationBackup(mounting) {
  return JSON.stringify({
    version: MOUNTING_BACKUP_VERSION,
    mounting: validateMountingCalibration(mounting),
  }, null, 2);
}

/** Strict and side-effect free: unknown fields, versions and invalid values fail. */
export function parseMountingCalibrationBackup(source) {
  if (typeof source !== 'string' || source.length > MAX_MOUNTING_BACKUP_LENGTH) {
    throw new Error('Choose a BaBot mounting backup smaller than 4 KB.');
  }
  let stored;
  try { stored = JSON.parse(source); }
  catch { throw new Error('This is not valid mounting backup JSON.'); }
  if (!hasExactKeys(stored, ['version', 'mounting']) || stored.version !== MOUNTING_BACKUP_VERSION
    || !hasExactKeys(stored.mounting, ['angleDegrees', 'invertRoll', 'invertPitch', 'verified'])) {
    throw new Error('Expected a version 1 BaBot mounting backup containing calibration only.');
  }
  try { return validateMountingCalibration(stored.mounting); }
  catch { throw new Error('The backup contains invalid mounting calibration values.'); }
}

/** A backup may retain verification only after explicit same-mount confirmation. */
export function restoreMountingCalibrationBackup(source, { samePhysicalMount = false } = {}) {
  const mounting = parseMountingCalibrationBackup(source);
  return validateMountingCalibration({ ...mounting, verified: mounting.verified && samePhysicalMount === true });
}

/** Both axes use one scale so the physical cue keeps the displayed balance. */
export function motionAmplitudes(strength) {
  const amount = Number.isFinite(strength) ? Math.max(0, Math.min(1, strength)) : 0;
  return { roll: CHASSIS_LIMITS.roll * amount, pitch: CHASSIS_LIMITS.pitch * amount };
}

export function readMountingCalibration(storage) {
  try {
    return parseMountingCalibrationBackup(storage.getItem(MOUNTING_STORAGE_KEY));
  } catch {
    return { ...DEFAULT_MOUNTING_CALIBRATION };
  }
}

export function saveMountingCalibration(storage, mounting) {
  const validated = validateMountingCalibration(mounting);
  storage.setItem(MOUNTING_STORAGE_KEY, serializeMountingCalibrationBackup(validated));
  return validated;
}
