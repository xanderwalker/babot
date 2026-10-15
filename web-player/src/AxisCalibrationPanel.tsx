import { useEffect, useId, useRef, useState } from 'react';
import { deriveMountingCalibration } from './axis-calibration.mjs';
import { validateMountingCalibration } from './protocol.mjs';
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
  /** Resolve true only after the pulse completes and controller OFF is confirmed. */
  onPulse: (axis: CalibrationAxis) => Promise<boolean>;
  onStop: () => void;
  onApply: (config: MountingCalibration) => void;
  onOpen?: () => void;
};

const emptyChecks = (mountingKey: string): Checks => ({
  mountingKey,
  roll: { completed: false, observation: '' },
  pitch: { completed: false, observation: '' },
});
const configKey = (config: MountingCalibration) => JSON.stringify([
  config.angleDegrees, config.invertRoll, config.invertPitch, config.verified,
]);
const directions: [Direction, string][] = [
  ['right-down', 'Right side down'],
  ['left-down', 'Left side down'],
  ['nose-down', 'Nose down'],
  ['nose-up', 'Nose up'],
];

export function AxisCalibrationPanel({
  mounting, connected, busy, runningAxis, onPulse, onStop, onApply, onOpen,
}: AxisCalibrationPanelProps) {
  const panelId = useId();
  const mountingKey = configKey(mounting);
  const [open, setOpen] = useState(false);
  const [handsClear, setHandsClear] = useState(false);
  const [checks, setChecks] = useState<Checks>(() => emptyChecks(mountingKey));
  const [pendingAxis, setPendingAxis] = useState<CalibrationAxis | null>(null);
  const [message, setMessage] = useState('');
  const generation = useRef(0);
  const pending = useRef<symbol | null>(null);
  const appliedKey = useRef<string | null>(null);
  const latest = useRef({ mountingKey, connected, onStop });
  latest.current = { mountingKey, connected, onStop };

  useEffect(() => {
    generation.current += 1;
    if (pending.current) latest.current.onStop();
    setChecks(emptyChecks(mountingKey));
    setHandsClear(false);
    if (!connected) setMessage('Connect BaBot over USB before running the checks.');
    else if (appliedKey.current !== mountingKey) setMessage('');
    appliedKey.current = null;
  }, [mountingKey, connected]);

  useEffect(() => () => {
    generation.current += 1;
    if (pending.current) latest.current.onStop();
  }, []);

  const running = pendingAxis ?? runningAxis;
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

  const discardChecks = () => {
    generation.current += 1;
    setChecks(emptyChecks(mountingKey));
    setHandsClear(false);
  };

  const cancel = () => {
    discardChecks();
    onStop();
    setMessage('Check cancelled. Both observations were cleared.');
  };

  const toggleOpen = () => {
    if (open) {
      if (running || pending.current) onStop();
      discardChecks();
      setMessage('');
    } else {
      onOpen?.();
    }
    setOpen(!open);
  };

  const pulse = async (axis: CalibrationAxis) => {
    if (!open || !handsClear || !connected || busy || running || pending.current) return;
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

  const apply = (verified: boolean) => {
    if (!connected || busy || running || pending.current || !handsClear || !complete) return;
    if (verified ? !matches : !candidate) return;
    const config = validateMountingCalibration(verified ? { ...mounting, verified: true } : candidate!);
    discardChecks();
    appliedKey.current = configKey(config);
    onApply(config);
    setMessage(verified
      ? 'Mounting verified: +roll lowers the right side and +pitch lowers the nose.'
      : 'Correction saved as unverified. Clear the platform, repeat both checks, then verify the observed directions.');
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
        <input type="checkbox" checked={handsClear} disabled={Boolean(running)} onChange={event => {
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
            <button type="button" onClick={() => void pulse(axis)} disabled={!handsClear || !connected || busy || Boolean(running)}>
              {running === axis ? `Checking +${axis}…` : `${check.completed ? 'Repeat' : 'Run'} +${axis} · 1°`}
            </button>
            <label htmlFor={`${panelId}-${axis}`}>Observed movement</label>
            <select id={`${panelId}-${axis}`} value={check.observation} disabled={!check.completed || !connected || busy || Boolean(running)} onChange={event => {
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
        {candidate && <button type="button" onClick={() => apply(false)} disabled={!handsClear || !connected || busy || Boolean(running)}>Apply correction</button>}
        <button type="button" className="axis-calibration-verify" onClick={() => apply(true)} disabled={!matches || !handsClear || !connected || busy || Boolean(running)}>Verify mounting</button>
      </div>
      <p className="axis-calibration-message" role="status" aria-live="polite">{message || 'A correction must pass two fresh checks before it can be verified.'}</p>
      <p className="axis-calibration-footnote">Saved in this browser. Repeat these checks if the model or platform mounting changes.</p>
    </div>}
  </section>;
}
