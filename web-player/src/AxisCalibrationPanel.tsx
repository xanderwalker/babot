import { useEffect, useId, useRef, useState } from 'react';
import { deriveMountingCalibration } from './axis-calibration.mjs';
import { validateMountingCalibration } from './protocol.mjs';
import {
  MAX_MOUNTING_BACKUP_LENGTH,
  parseMountingCalibrationBackup,
  restoreMountingCalibrationBackup,
  serializeMountingCalibrationBackup,
} from './motion-settings.mjs';
import './AxisCalibrationPanel.css';

export type CalibrationAxis = 'roll' | 'pitch';
export type MountingCalibration = {
  angleDegrees: number;
  invertRoll: boolean;
  invertPitch: boolean;
  verified: boolean;
};

type Direction = 'right-down' | 'left-down' | 'nose-down' | 'nose-up';
type Observation = Direction | 'unclear' | '';
type Check = { completed: boolean; observation: Observation };
type Checks = { mountingKey: string; roll: Check; pitch: Check };

export type AxisCalibrationPanelProps = {
  mounting: MountingCalibration;
  connected: boolean;
  busy: boolean;
  runningAxis: CalibrationAxis | null;
  readOnly?: boolean;
  initiallyOpen?: boolean;
  /** Revoke previous verification when a user begins a physical check. */
  onBeginCheck: () => void;
  /** Resolve true only after the pulse completes and controller OFF is confirmed. */
  onPulse: (axis: CalibrationAxis) => Promise<boolean>;
  onStop: () => void;
  onApply: (config: MountingCalibration) => void | Promise<void>;
  onOpen?: () => void;
};

const emptyChecks = (mountingKey: string): Checks => ({
  mountingKey,
  roll: { completed: false, observation: '' },
  pitch: { completed: false, observation: '' },
});
const configKey = (config: MountingCalibration) => JSON.stringify([
  config.angleDegrees, config.invertRoll, config.invertPitch,
]);
const directions: [Direction, string][] = [
  ['right-down', 'Right side down'],
  ['left-down', 'Left side down'],
  ['nose-down', 'Nose down'],
  ['nose-up', 'Nose up'],
];

export function AxisCalibrationPanel({
  mounting, connected, busy, runningAxis, readOnly = false, initiallyOpen = false, onBeginCheck, onPulse, onStop, onApply, onOpen,
}: AxisCalibrationPanelProps) {
  const panelId = useId();
  const mountingKey = configKey(mounting);
  const [open, setOpen] = useState(initiallyOpen);
  const [handsClear, setHandsClear] = useState(false);
  const [checks, setChecks] = useState<Checks>(() => emptyChecks(mountingKey));
  const [pendingAxis, setPendingAxis] = useState<CalibrationAxis | null>(null);
  const [message, setMessage] = useState('');
  const [backupText, setBackupText] = useState('');
  const [backupError, setBackupError] = useState('');
  const [samePhysicalMount, setSamePhysicalMount] = useState(false);
  const [saving, setSaving] = useState(false);
  const generation = useRef(0);
  const pending = useRef<symbol | null>(null);
  const backupRead = useRef(0);
  const applying = useRef(false);
  const appliedKey = useRef<string | null>(null);
  const latest = useRef({ mountingKey, connected, onStop });
  latest.current = { mountingKey, connected, onStop };

  useEffect(() => {
    generation.current += 1;
    if (pending.current) latest.current.onStop();
    setChecks(emptyChecks(mountingKey));
    setHandsClear(false);
    setSamePhysicalMount(false);
    if (!connected) setMessage('Connect BaBot over USB before running the checks.');
    else if (appliedKey.current !== mountingKey) setMessage('');
    appliedKey.current = null;
  }, [mountingKey, connected]);

  useEffect(() => () => {
    generation.current += 1;
    backupRead.current += 1;
    if (pending.current) latest.current.onStop();
  }, []);

  const running = pendingAxis ?? runningAxis;
  const editingBlocked = readOnly || busy || saving || Boolean(running);
  const currentChecks = checks.mountingKey === mountingKey ? checks : emptyChecks(mountingKey);
  const complete = currentChecks.roll.completed && currentChecks.pitch.completed;
  const observed = complete && currentChecks.roll.observation !== '' && currentChecks.pitch.observation !== '';
  const matches = observed && currentChecks.roll.observation === 'right-down' && currentChecks.pitch.observation === 'nose-down';
  let candidate: MountingCalibration | null = null;
  let observationError = '';
  if (observed && !matches) {
    try {
      candidate = deriveMountingCalibration({
        rollDirection: currentChecks.roll.observation,
        pitchDirection: currentChecks.pitch.observation,
      }, mounting);
    } catch {
      observationError = 'These observations do not identify two distinct axes. Repeat the checks; mixed or unclear movement needs another look.';
    }
  }

  let backupMounting: MountingCalibration | null = null;
  let backupValidationError = '';
  if (backupText.trim()) {
    try { backupMounting = parseMountingCalibrationBackup(backupText); }
    catch (error) { backupValidationError = error instanceof Error ? error.message : 'Invalid mounting backup.'; }
  }

  const discardChecks = () => {
    generation.current += 1;
    setChecks(emptyChecks(latest.current.mountingKey));
    setHandsClear(false);
  };

  const cancel = () => {
    discardChecks();
    onStop();
    setMessage('Check cancelled. Both observations were cleared.');
  };

  const toggleOpen = () => {
    if (open) {
      if (running || pending.current) cancel();
      // Closing an idle panel is navigation, not a new calibration attempt.
      setHandsClear(false);
      setSamePhysicalMount(false);
    } else {
      if (!readOnly) onOpen?.();
    }
    setOpen(!open);
  };

  const pulse = async (axis: CalibrationAxis) => {
    if (!open || !handsClear || !connected || editingBlocked || pending.current) return;
    const token = Symbol(axis);
    const checkGeneration = generation.current;
    const startKey = mountingKey;
    pending.current = token;
    setPendingAxis(axis);
    setChecks(previous => ({
      ...(previous.mountingKey === startKey ? previous : emptyChecks(startKey)),
      [axis]: { completed: false, observation: '' },
    }));
    setMessage(`Running +${axis}: 1° pulse, then return to level and stop.`);
    try {
      onBeginCheck();
      const completed = await onPulse(axis);
      if (generation.current !== checkGeneration || latest.current.mountingKey !== startKey) return;
      if (!completed || !latest.current.connected) {
        discardChecks();
        setMessage('The check stopped before it could be accepted. Both observations were cleared. Check the controller status, then repeat both tests.');
        return;
      }
      setChecks(previous => ({ ...previous, [axis]: { completed: true, observation: '' } }));
      setMessage(`+${axis} check complete · controller off. Record the direction you observed.`);
    } catch {
      if (generation.current !== checkGeneration || latest.current.mountingKey !== startKey) return;
      discardChecks();
      onStop();
      setMessage('The check failed. Both observations were cleared. Check the controller status before retrying.');
    } finally {
      if (pending.current === token) {
        pending.current = null;
        setPendingAxis(null);
      }
    }
  };

  const apply = async (verified: boolean) => {
    if (!connected || editingBlocked || applying.current || pending.current || !handsClear || !complete) return;
    if (verified ? !matches : !candidate) return;
    const config = validateMountingCalibration(verified ? { ...mounting, verified: true } : candidate!);
    applying.current = true;
    setSaving(true);
    try {
      appliedKey.current = configKey(config);
      await onApply(config);
      discardChecks();
      setMessage(verified
        ? 'Mounting verified: +roll lowers the right side and +pitch lowers the nose.'
        : 'Correction saved as unverified. Clear the platform, repeat both checks, then verify the observed directions.');
    } catch (error) {
      appliedKey.current = null;
      setMessage(error instanceof Error ? error.message : 'Mounting could not be saved.');
    } finally {
      applying.current = false;
      setSaving(false);
    }
  };

  const changeBackupText = (value: string) => {
    backupRead.current += 1;
    setBackupText(value);
    setSamePhysicalMount(false);
    setBackupError('');
  };

  const loadBackupFile = async (file: File) => {
    const token = ++backupRead.current;
    setSamePhysicalMount(false);
    setBackupText('');
    setBackupError('');
    if (file.size > MAX_MOUNTING_BACKUP_LENGTH) {
      setBackupError('Choose a BaBot mounting backup smaller than 4 KB.');
      return;
    }
    try {
      const text = await file.text();
      if (token === backupRead.current) setBackupText(text);
    } catch {
      if (token === backupRead.current) setBackupError('The backup file could not be read. Current mounting is unchanged.');
    }
  };

  const exportBackup = () => {
    const url = URL.createObjectURL(new Blob([serializeMountingCalibrationBackup(mounting)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'babot-mounting-backup.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setBackupError('');
  };

  const restoreBackup = async () => {
    if (editingBlocked || applying.current || pending.current) return;
    let config: MountingCalibration;
    try {
      // Parse again at the action boundary; invalid input never reaches onApply.
      config = restoreMountingCalibrationBackup(backupText, { samePhysicalMount });
    } catch (error) {
      setBackupError(`${error instanceof Error ? error.message : 'The backup is invalid.'} Current mounting is unchanged.`);
      return;
    }
    applying.current = true;
    setSaving(true);
    try {
      appliedKey.current = configKey(config);
      await onApply(config);
      discardChecks();
      setSamePhysicalMount(false);
      setBackupError('');
      setMessage(config.verified
        ? 'Verified mounting restored for the same physical mount. No motion started.'
        : 'Mounting restored as unverified. Run both checks before enabling replay motion.');
    } catch (error) {
      appliedKey.current = null;
      setBackupError(error instanceof Error ? error.message : 'The backup could not be saved. Check the current mounting status before continuing.');
    } finally {
      applying.current = false;
      setSaving(false);
    }
  };

  return <section className="axis-calibration" aria-label="BaBot mounting calibration">
    <div className="axis-calibration-heading">
      <span className={`axis-calibration-state${mounting.verified ? ' is-verified' : ''}`}>
        {mounting.verified ? 'Mounting verified' : 'Mounting not verified'}
      </span>
      <button type="button" aria-expanded={open} aria-controls={panelId} onClick={toggleOpen}>
        {open ? 'Close check' : 'Check mounting'}
      </button>
    </div>
    {open && <div id={panelId} className="axis-calibration-body">
      <p>View from behind the model, with its nose toward the screen. Run each 1° check, then record what moved.</p>
      <p className="axis-calibration-expected">Expected: <strong>+roll → right side down</strong>; <strong>+pitch → nose down</strong>.</p>
      <label className="axis-calibration-clear">
        <input type="checkbox" checked={handsClear} disabled={readOnly || Boolean(running)} onChange={event => {
          if (!event.target.checked) discardChecks();
          else setHandsClear(true);
        }}/>
        <span>Platform clear; hands away from the mechanism.</span>
      </label>
      {!connected && <p className="axis-calibration-hint">Connect BaBot over USB to run the checks.</p>}
      <div className="axis-calibration-checks">
        {(['roll', 'pitch'] as const).map((axis, index) => {
          const check = currentChecks[axis];
          return <fieldset key={axis} className="axis-calibration-check">
            <legend>{index + 1}. Check {axis}</legend>
            <button type="button" onClick={() => void pulse(axis)} disabled={!handsClear || !connected || editingBlocked}>
              {running === axis ? `Checking +${axis}…` : `${check.completed ? 'Repeat' : 'Run'} +${axis} · 1°`}
            </button>
            <label htmlFor={`${panelId}-${axis}`}>Observed movement</label>
            <select id={`${panelId}-${axis}`} value={check.observation} disabled={!check.completed || !connected || editingBlocked} onChange={event => {
              const observation = event.target.value as Observation;
              setChecks(previous => ({ ...previous, [axis]: { ...previous[axis], observation } }));
              setMessage('');
            }}>
              <option value="">Choose after the check</option>
              {directions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              <option value="unclear">Mixed / no clear motion</option>
            </select>
            {check.completed && <small>Complete · controller off</small>}
          </fieldset>;
        })}
      </div>
      {running && <button type="button" className="axis-calibration-cancel" onClick={cancel}>Cancel check + stop</button>}
      {observationError && <p className="axis-calibration-hint" role="status">{observationError}</p>}
      <div className="axis-calibration-actions">
        {candidate && <button type="button" onClick={() => void apply(false)} disabled={!handsClear || !connected || editingBlocked}>Apply correction</button>}
        <button type="button" className="axis-calibration-verify" onClick={() => void apply(true)} disabled={!matches || !handsClear || !connected || editingBlocked}>Verify mounting</button>
      </div>
      <p className="axis-calibration-message" role="status" aria-live="polite">{message || (mounting.verified
        ? 'Saved verification is retained. Starting a new check makes the mounting unverified until both checks pass.'
        : 'A correction must pass two fresh checks before it can be verified.')}</p>
      <details className="axis-calibration-backup">
        <summary>Back up or restore mounting</summary>
        <p>Export a file to keep the calibration if browser storage is cleared. Backups contain mounting only.</p>
        <button type="button" onClick={exportBackup}>Export backup</button>
        <label htmlFor={`${panelId}-backup-file`}>Load a backup file</label>
        <input id={`${panelId}-backup-file`} type="file" accept=".json,application/json" disabled={editingBlocked} onChange={event => {
          const file = event.target.files?.[0];
          if (file) void loadBackupFile(file);
          event.target.value = '';
        }}/>
        <label htmlFor={`${panelId}-backup-text`}>Or paste backup JSON</label>
        <textarea id={`${panelId}-backup-text`} rows={5} value={backupText} disabled={editingBlocked} spellCheck={false} onChange={event => changeBackupText(event.target.value)}/>
        {backupMounting?.verified && <label className="axis-calibration-clear">
          <input type="checkbox" checked={samePhysicalMount} disabled={editingBlocked} onChange={event => setSamePhysicalMount(event.target.checked)}/>
          <span>This backup is for the same unchanged physical mount.</span>
        </label>}
        {backupMounting?.verified && !samePhysicalMount && <p>Without this confirmation, the mapping will be restored as unverified.</p>}
        {(backupError || backupValidationError) && <p className="axis-calibration-hint" role="alert">{backupError || `${backupValidationError} Current mounting is unchanged.`}</p>}
        <button type="button" onClick={() => void restoreBackup()} disabled={!backupMounting || editingBlocked}>
          {saving ? 'Saving mounting…' : backupMounting?.verified && samePhysicalMount ? 'Restore verified mounting' : 'Restore as unverified'}
        </button>
      </details>
      <p className="axis-calibration-footnote">Saved in this browser. Closing this panel keeps completed checks. Repeat them if the model or platform mounting changes.</p>
    </div>}
  </section>;
}
