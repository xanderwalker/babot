import React, { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import { readMountingCalibration, saveMountingCalibration } from './motion-settings.mjs';

const App = lazy(() => import('./App'));
const Setup = lazy(() => import('./Setup'));

function Router() {
  const [route, setRoute] = useState(() => window.location.hash);
  const [setupVerified, setSetupVerified] = useState(false);
  const setupBusy = useRef(false);
  const setupBusyChanged = useCallback((busy: boolean) => { setupBusy.current = busy; }, []);
  useEffect(() => {
    const changed = () => {
      if (setupBusy.current && window.location.hash !== '#setup') {
        // Browser Back and hand-edited hashes must not abandon an active write.
        window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#setup`);
        return;
      }
      setRoute(window.location.hash); window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  const continueSetup = () => {
    // Installation can target a different robot. Existing browser mounting
    // settings must never authorize this robot without fresh physical checks.
    try {
      saveMountingCalibration(window.localStorage, { ...readMountingCalibration(window.localStorage), verified: false });
    } catch { /* App's setup mode also revokes verification in memory. */ }
    setSetupVerified(true);
    window.location.hash = 'setup-complete';
  };
  return <Suspense fallback={<main className="route-loading" role="status">Opening BaBot…</main>}>
    {route === '#setup'
      ? <Setup onContinue={continueSetup} onBack={() => { window.location.hash = ''; }} onBusyChange={setupBusyChanged}/>
      : <App key={route === '#setup-complete' ? 'setup' : 'replay'} setupMode={route === '#setup-complete' && setupVerified}/>}
  </Suspense>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><Router /></React.StrictMode>);
