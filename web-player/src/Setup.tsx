import { useEffect, useRef, useState } from 'react';
import { assetUrl } from './asset-url';
import { createFirmwareInstaller } from './firmware-installer.mjs';
import { SetupUsbLease } from './setup-usb-lease.mjs';
import './Setup.css';

type Manifest = { version: string; board: string; hexUrl: string; sourceZipUrl: string; sha256: string; sizeBytes: number };
type Stage = { stage: string; message: string; progress?: number };
type Verification = { compatible: boolean; version?: string | null; protocol?: number; offsets?: number[] | null; current?: boolean; message?: string };
type Installer = {
  prepare: (url: string) => Promise<Manifest>;
  resetRuntime: () => Promise<unknown>;
  flashBootloader: () => Promise<unknown>;
  verifyRuntime: (options?: { requirePreparedVersion?: boolean }) => Promise<Verification>;
  cancel: () => Promise<unknown>;
};
type Step = 'prepare' | 'install' | 'verify' | 'finish';
type Props = { onContinue: () => void; onBack: () => void; onBusyChange?: (busy: boolean) => void };
const steps: { id: Step; title: string; subtitle: string }[] = [
  { id: 'prepare', title: 'Prepare', subtitle: 'Cable & power' },
  { id: 'install', title: 'Install', subtitle: 'BaBot Motion firmware' },
  { id: 'verify', title: 'Verify', subtitle: 'Read your device' },
  { id: 'finish', title: 'Set up replay', subtitle: 'Mounting & Singapore' },
];

function messageOf(error: unknown) { return error instanceof Error ? error.message : 'The operation could not finish. Try the recovery instructions below.'; }
function codeOf(error: unknown) { return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''; }

function CableDiagram() {
  return <svg className="setup-cable-diagram" viewBox="0 0 560 142" role="img" aria-labelledby="setup-cable-title">
    <title id="setup-cable-title">Computer USB data cable connects to Upload Code. Keep Power Up disconnected during installation.</title>
    <rect x="22" y="20" width="110" height="72" rx="5" fill="#10191c" stroke="#637a7c" />
    <rect x="29" y="27" width="96" height="57" rx="1" fill="#18282c" />
    <path d="M13 100h128l-10 9H23Z" fill="#354a4e" />
    <path d="M139 58h57q15 0 15 16v10q0 15 15 15h70" fill="none" stroke="#96cfc2" strokeWidth="3" />
    <rect x="295" y="39" width="236" height="76" rx="5" fill="#152327" stroke="#637a7c" />
    <rect x="290" y="88" width="14" height="20" rx="1" fill="#96cfc2" />
    <rect x="457" y="85" width="44" height="15" rx="2" fill="#0b1113" stroke="#6d6c5b" />
    <path d="m462 81 33 24m-33 0 33-24" stroke="#ff824b" strokeWidth="1.5" />
    <text x="338" y="66" fill="#e8eeeb" fontSize="15" fontFamily="Barlow,Arial,sans-serif" fontWeight="600">BaBot</text>
    <text x="313" y="101" fill="#96cfc2" fontSize="10" fontFamily="Barlow,Arial,sans-serif">Upload Code</text>
    <text x="454" y="129" fill="#ffad83" fontSize="10" fontFamily="Barlow,Arial,sans-serif">Power Up: off</text>
    <text x="145" y="42" fill="#9bafb1" fontSize="10" fontFamily="Barlow,Arial,sans-serif">USB data cable</text>
  </svg>;
}

export function Setup({ onContinue, onBack, onBusyChange }: Props) {
  const [step, setStep] = useState<Step>('prepare');
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [stage, setStage] = useState<Stage>({ stage: 'preparing', message: 'Loading and checking the firmware release…' });
  const [releaseError, setReleaseError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusyState] = useState(false);
  const [leaseOwned, setLeaseOwned] = useState(false);
  const [leaseMessage, setLeaseMessage] = useState('Checking USB ownership…');
  const [preparedHardware, setPreparedHardware] = useState(false);
  const [powerDisconnected, setPowerDisconnected] = useState(false);
  const [resetDone, setResetDone] = useState(false);
  const [flashed, setFlashed] = useState(false);
  const [verification, setVerification] = useState<Verification | null>(null);
  const [closeFailed, setCloseFailed] = useState(false);
  const installer = useRef<Installer | null>(null);
  const lease = useRef<SetupUsbLease | null>(null);
  const mounted = useRef(false);
  const inOperation = useRef(false);
  const cancelling = useRef(false);
  const sequence = useRef(0);
  const supportsUsb = typeof window !== 'undefined' && window.isSecureContext && 'serial' in navigator && 'locks' in navigator;
  const prepared = preparedHardware && powerDisconnected;
  const canUseUsb = supportsUsb && leaseOwned && !!manifest && prepared && !busy && !closeFailed;
  const stepIndex = steps.findIndex(item => item.id === step);
  const setBusy = (value: boolean) => { setBusyState(value); onBusyChange?.(value); };

  useEffect(() => {
    let live = true;
    mounted.current = true;
    const currentInstaller = createFirmwareInstaller({ onStage: (next: Stage) => { if (live) setStage(next); } }) as Installer;
    const currentLease = new SetupUsbLease();
    installer.current = currentInstaller;
    lease.current = currentLease;
    // No chooser, reset, write, or motion command runs during page loading.
    Promise.resolve().then(async () => {
      if (!live) return;
      try {
        const release = await currentInstaller.prepare(assetUrl('firmware/manifest.json'));
        if (live) { setManifest(release); setReleaseError(''); }
      } catch (failure) { if (live) setReleaseError(messageOf(failure)); }
    });
    if (supportsUsb) Promise.resolve().then(async () => {
      if (!live) return;
      try {
        const owned = await currentLease.acquire();
        if (live) {
          setLeaseOwned(owned === true);
          setLeaseMessage(owned ? '' : 'Another player tab owns BaBot USB. Disconnect it there, then try again here.');
        }
      } catch (failure) { if (live) setLeaseMessage(messageOf(failure)); }
    });
    return () => {
      live = false;
      mounted.current = false;
      sequence.current += 1;
      void currentLease.dispose(() => currentInstaller.cancel()).catch(() => {
        // The lease remains held if USB closure cannot be confirmed.
      });
    };
  }, [supportsUsb]);

  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (!inOperation.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, []);

  const retryLease = async () => {
    if (!lease.current || inOperation.current) return;
    setLeaseMessage('Checking USB ownership…');
    try {
      const owned = await lease.current.acquire();
      if (!mounted.current) return;
      setLeaseOwned(owned === true);
      setLeaseMessage(owned ? '' : 'Another player tab still owns BaBot USB. Disconnect it there first.');
    } catch (failure) { if (mounted.current) setLeaseMessage(messageOf(failure)); }
  };

  const loadRelease = async () => {
    if (!installer.current || inOperation.current) return;
    inOperation.current = true;
    setBusy(true);
    setReleaseError('');
    try { const release = await installer.current.prepare(assetUrl('firmware/manifest.json')); if (mounted.current) setManifest(release); }
    catch (failure) { if (mounted.current) setReleaseError(messageOf(failure)); }
    finally { inOperation.current = false; if (mounted.current) setBusy(false); }
  };

  // Invoke the operation synchronously from its click so Web Serial retains the user gesture.
  const run = async (operation: (engine: Installer) => Promise<unknown>, onSuccess: (result: unknown) => void) => {
    if (!installer.current || inOperation.current || !canUseUsb) return;
    const token = ++sequence.current;
    inOperation.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await operation(installer.current);
      if (mounted.current && token === sequence.current) onSuccess(result);
    } catch (failure) {
      if (mounted.current && token === sequence.current) {
        setError(messageOf(failure));
        if (codeOf(failure) === 'cleanup-failed') setCloseFailed(true);
      }
    } finally {
      if (token === sequence.current) { inOperation.current = false; if (mounted.current) setBusy(false); }
    }
  };

  const reset = () => { setResetDone(false); void run(engine => engine.resetRuntime(), () => setResetDone(true)); };
  const flash = () => {
    setVerification(null);
    void run(engine => engine.flashBootloader(), () => {
      setFlashed(true);
      setResetDone(false);
      setStep('verify');
    });
  };
  const verify = () => {
    setVerification(null);
    void run(engine => engine.verifyRuntime({ requirePreparedVersion: flashed }), result => {
      const checked = result as Verification;
      if (checked.compatible) { setVerification(checked); setStep('finish'); }
      else setError(checked.message || 'BaBot Motion did not respond. Install the firmware, then check it again.');
    });
  };
  const cancel = async () => {
    if (!installer.current || cancelling.current) return;
    cancelling.current = true;
    ++sequence.current;
    inOperation.current = true;
    setBusy(true);
    try {
      await installer.current.cancel();
      if (mounted.current) {
        setError('Operation cancelled. Keep motor power disconnected. If installation had started, use the reset instructions and install again before reconnecting power.');
        setResetDone(false);
        setCloseFailed(false);
      }
    } catch (failure) { if (mounted.current) { setError(messageOf(failure)); setCloseFailed(true); } }
    finally { cancelling.current = false; inOperation.current = false; if (mounted.current) setBusy(false); }
  };

  const leave = async (next: () => void) => {
    if (inOperation.current || !installer.current || !lease.current) return;
    inOperation.current = true;
    setBusy(true);
    try {
      await lease.current.close(() => installer.current!.cancel());
      if (mounted.current) { setLeaseOwned(false); next(); }
    } catch (failure) { if (mounted.current) { setError(messageOf(failure)); setCloseFailed(true); } }
    finally { inOperation.current = false; if (mounted.current) setBusy(false); }
  };

  return <main className="setup-page">
    <header className="setup-topbar">
      <div className="brand"><span className="brand-mark">b</span><span>BABOT<em>POLE LAP PLAYER</em></span></div>
      <button className="setup-back" disabled={busy} onClick={() => void leave(onBack)}>← Back to player</button>
    </header>

    <section className="setup-intro" aria-labelledby="setup-title">
      <div><div className="setup-eyebrow">YOUR FIRST LAP STARTS HERE</div><h1 id="setup-title">Set up your BaBot<span>.</span></h1><p>Install BaBot Motion over USB, check your mounting, then follow the Singapore pole lap.</p></div>
      <div className="setup-destination"><span>FIRST REPLAY</span><strong>Singapore</strong><small>2026 · Marina Bay</small></div>
    </section>

    <div className="setup-beta"><span>BROWSER INSTALLER · BETA</span><p>For BaBot with an Arduino Leonardo / ATmega32U4 controller. Browser installation needs first-device validation.</p></div>

    <div className="setup-layout">
      <nav className="setup-steps" aria-label="Setup progress"><ol>{steps.map((item, index) => {
        const skipped = item.id === 'install' && !flashed && stepIndex > 1;
        const complete = index < stepIndex && !skipped;
        return <li key={item.id} className={complete ? 'complete' : item.id === step ? 'current' : ''} aria-current={item.id === step ? 'step' : undefined}>
          <span className="setup-step-number">{skipped ? '—' : complete ? '✓' : `0${index + 1}`}</span><div><strong>{item.title}</strong><span>{skipped ? 'Using installed firmware' : item.subtitle}</span></div>
        </li>;
      })}</ol><div className="setup-release-label"><span>FIRMWARE RELEASE</span><strong>{manifest ? `BaBot Motion ${manifest.version}` : releaseError ? 'Release unavailable' : 'Checking release…'}</strong><small>Leonardo · USB installation</small></div></nav>

      <div className="setup-workspace">
        {!supportsUsb && <div className="setup-notice" role="status"><strong>Open this page in desktop Chrome or Edge.</strong><p>Installation needs Web Serial and Web Locks on HTTPS or localhost. You can still download the firmware and use the Arduino IDE instructions below.</p></div>}
        {supportsUsb && !leaseOwned && <div className="setup-notice" role="status"><strong>USB access is waiting</strong><p>{leaseMessage}</p><button onClick={() => void retryLease()} disabled={busy}>Check USB ownership again</button></div>}
        {releaseError && <div className="setup-error" role="alert"><strong>Could not verify the firmware download</strong><p>{releaseError}</p><button disabled={busy} onClick={() => void loadRelease()}>Retry release download</button></div>}

        <section className="setup-card" aria-labelledby="setup-step-title">
          <div className="setup-card-heading"><span>0{stepIndex + 1} / 04</span><span>{manifest ? `FIRMWARE ${manifest.version}` : 'RELEASE CHECK'}</span></div>

          {step === 'prepare' && <>
            <h2 id="setup-step-title">One cable. Power off.</h2><p className="setup-lead">Start with BaBot on a stable surface and keep its separate motor power disconnected throughout installation.</p>
            <CableDiagram />
            <p className="setup-diagram-caption">Connection guide · Port positions vary by BaBot version; follow the labels on your unit.</p>
            <div className="setup-checks">
              <label><input type="checkbox" checked={preparedHardware} onChange={event => setPreparedHardware(event.target.checked)} disabled={busy} /><span>My BaBot has a Leonardo / ATmega32U4 controller, and a USB <strong>data cable</strong> connects my computer to <strong>Upload Code</strong>.</span></label>
              <label><input type="checkbox" checked={powerDisconnected} onChange={event => setPowerDisconnected(event.target.checked)} disabled={busy} /><span>I disconnected <strong>Power Up</strong> / separate motor power, removed the model or ball, and closed any Arduino serial monitor or other BaBot connection.</span></label>
            </div>
            <div className="setup-actions"><button className="setup-primary" disabled={!canUseUsb} onClick={() => { setError(''); setStep('install'); }}>Continue to installation <span>→</span></button><button className="setup-secondary" disabled={!canUseUsb} onClick={() => { setError(''); setStep('verify'); }}>I already have BaBot Motion</button></div>
            <p className="setup-footnote">Installation replaces the running firmware. The installer reads the stored servo calibration and verifies that it is unchanged after installation.</p>
          </>}

          {step === 'install' && <>
            <h2 id="setup-step-title">Install BaBot Motion.</h2><p className="setup-lead">You’ll choose BaBot twice: once to restart it, then its temporary bootloader port to install the firmware.</p>
            <div className={`setup-install-action ${resetDone ? 'done' : ''}`}><div className="setup-action-index">A</div><div><h3>Restart in installation mode</h3><p>Choose the Arduino Leonardo / BaBot port connected to <strong>Upload Code</strong>. Its USB port will briefly disappear.</p><button className={!resetDone ? 'setup-primary' : ''} disabled={!canUseUsb} onClick={reset}>{resetDone ? 'Restart BaBot again' : 'Reset BaBot'}</button></div></div>
            <div className={`setup-install-action ${resetDone ? 'ready' : ''}`}><div className="setup-action-index">B</div><div><h3>Choose the bootloader immediately</h3><p>The installation port appears for about <strong>8 seconds</strong> after reset. Select <strong>Arduino Leonardo bootloader</strong> or the newly appeared Leonardo port. Keep the cable connected until verification finishes.</p><button className={resetDone ? 'setup-primary' : ''} disabled={!canUseUsb} onClick={flash}>Choose bootloader and install <span>→</span></button></div></div>
            <details className="setup-recovery"><summary>Bootloader disappeared, or no normal USB port?</summary><p>Keep motor power disconnected. If the normal USB port is still present, select <strong>Reset BaBot</strong> again, then immediately select <strong>Choose bootloader and install</strong>. If the chooser is empty, cancel it and retry the reset. Check that your cable carries data and no other app owns the port.</p><p>For recovery when normal firmware cannot start, use the controller board’s documented reset procedure, then immediately choose the bootloader. The BaBot front <strong>Mode</strong> button is not the controller reset. If you cannot access the controller reset, follow the Arduino IDE and BaBot hardware instructions below.</p><p>If an upload was interrupted, restore a verified firmware image before reconnecting motor power.</p></details>
          </>}

          {step === 'verify' && <>
            <div className="setup-large-symbol" aria-hidden="true">{flashed ? '✓' : '↔'}</div><h2 id="setup-step-title">{flashed ? 'Installed. Now check the device.' : 'Check your installed firmware.'}</h2>
            <p className="setup-lead">{flashed ? 'Flash readback and EEPROM preservation passed. Wait for BaBot’s normal USB port to return, then choose it below.' : 'Choose BaBot’s normal USB port. We’ll ask the running firmware for its protocol and release version.'}</p>
            <div className="setup-verification-list"><div><span>01</span><p>Keep <strong>Power Up disconnected</strong> and Upload Code connected.</p></div><div><span>02</span><p>Choose the normal <strong>Arduino Leonardo / BaBot</strong> port, not its bootloader.</p></div><div><span>03</span><p>This check reads firmware information. Mounting and movement are checked next in the player.</p></div></div>
            <div className="setup-actions"><button className="setup-primary" disabled={!canUseUsb} onClick={verify}>Check installed firmware <span>→</span></button>{!flashed && <button disabled={busy} onClick={() => { setError(''); setStep('install'); }}>Install firmware instead</button>}</div>
          </>}

          {step === 'finish' && verification?.compatible && <>
            <div className="setup-large-symbol" aria-hidden="true">✓</div><h2 id="setup-step-title">Your firmware is ready.</h2><p className="setup-lead">Next, connect motor power and check how your model is mounted before enabling lap motion.</p>
            <div className="setup-verified"><span className="setup-verified-dot" /><div><strong>BaBot Motion {verification.version || 'protocol verified'}</strong><span>Protocol {verification.protocol ?? 1}{verification.offsets ? ` · Servo offsets ${verification.offsets.join(' / ')}` : ' · Firmware release version unavailable'}</span></div></div>
            {!verification.version && <p className="setup-footnote">This firmware answers the motion protocol but does not report a release version. Install the current release for version identification.</p>}
            <ol className="setup-next-steps"><li>With the model removed, connect BaBot’s separate <strong>Power Up</strong> supply and let it settle.</li><li>Mount the model securely. Keep hands clear and use the player’s guided <strong>roll and pitch checks</strong> to confirm its direction.</li><li>Preview Singapore, then enable motion only after both mounting checks pass.</li></ol>
            <div className="setup-actions"><button className="setup-primary" disabled={busy || closeFailed} onClick={() => void leave(onContinue)}>Continue to mounting & Singapore <span>→</span></button></div>
            <p className="setup-footnote">Firmware verification does not confirm physical mounting or movement. Your previous mounting verification will be cleared for this setup.</p>
          </>}

          {(busy || stage.stage === 'preparing') && <div className="setup-progress" role="status" aria-live="polite"><div><span>{stage.message}</span>{typeof stage.progress === 'number' && <strong>{Math.round(Math.max(0, Math.min(1, stage.progress)) * 100)}%</strong>}</div><progress max="1" value={typeof stage.progress === 'number' ? Math.max(0, Math.min(1, stage.progress)) : undefined} aria-label="Firmware operation progress" /></div>}
          {error && <div className="setup-error" role="alert"><strong>{closeFailed ? 'USB connection needs recovery' : 'Setup needs another try'}</strong><p>{error}</p>{closeFailed && <p>Unplug Upload Code USB. Retry closing the connection below; if it still cannot close, reload this page before reconnecting. Do not reconnect motor power until firmware is verified.</p>}</div>}
          {(busy || closeFailed) && stage.stage !== 'preparing' && <div className="setup-cancel"><button onClick={() => void cancel()}>{closeFailed ? 'Retry closing USB' : 'Cancel operation'}</button><span>Keep motor power disconnected.</span></div>}
          {step !== 'prepare' && step !== 'finish' && !busy && <button className="setup-text-link" onClick={() => { setStep('prepare'); setError(''); }}>← Review cable & power preparation</button>}
        </section>

        <details className="setup-manual"><summary><span>Downloads & manual installation</span><span aria-hidden="true">+</span></summary><div>
          <p>Use Arduino IDE if browser installation does not work with your computer. Keep the same cable and power preparation above.</p>
          {manifest ? <div className="setup-downloads"><a href={manifest.sourceZipUrl} download>Download firmware source ZIP <span>↓</span></a><a href={manifest.hexUrl} download>Download compiled HEX <span>↓</span></a></div> : <p className="setup-footnote">Downloads become available after the release manifest and firmware have been checked.</p>}
          <ol><li>Unzip the source download and open the included BaBot sketch in Arduino IDE.</li><li>Follow <strong>INSTALL.txt</strong> in the ZIP. Install <strong>Arduino AVR Boards 1.8.8</strong>, <strong>Servo 1.3.0</strong>, and <strong>CD74HC4067 1.0.2</strong>, then select <strong>Arduino Leonardo</strong> and BaBot’s Upload Code port.</li><li>Upload the sketch. If the port is missing, follow the controller board’s documented reset procedure and retry while its bootloader is visible. The BaBot front Mode button is not a reset button.</li><li>Return here, choose <strong>I already have BaBot Motion</strong>, then check the installed firmware before connecting motor power.</li></ol>
          <p><a href="https://www.ba-bot.com/manual/" target="_blank" rel="noreferrer">BaBot hardware manual ↗</a><a href="https://www.arduino.cc/en/software/" target="_blank" rel="noreferrer">Get Arduino IDE ↗</a></p>
          {manifest && <details className="setup-checksum"><summary>Release details & checksum</summary><dl><dt>Version</dt><dd>{manifest.version}</dd><dt>Board</dt><dd>{manifest.board}</dd><dt>HEX bytes</dt><dd>{manifest.sizeBytes?.toLocaleString()}</dd><dt>SHA-256</dt><dd>{manifest.sha256}</dd></dl></details>}
        </div></details>
      </div>
    </div>
    <footer className="setup-footer"><span>BABOT MOTION</span><p>Install once. Connect, check your mounting, and replay.</p><span>Singapore · First lap</span></footer>
  </main>;
}

export default Setup;
