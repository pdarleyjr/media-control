import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

function App() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const mode = params.get('mode') || 'splash';
  const [status, setStatus] = useState(mode === 'offline' ? 'Offline / reconnecting' : 'Booting');

  useEffect(() => {
    return window.mbfdConsoleShell?.onStatus((nextStatus) => setStatus(nextStatus));
  }, []);

  const isOffline = mode === 'offline';

  return (
    <main className="shell-screen">
      <section className="brand-card" aria-live="polite">
        <div className="brand-mark" aria-hidden="true">
          <span>MBFD</span>
        </div>
        <p className="eyebrow">Media Bureau Field Device</p>
        <h1>MBFD Media Control Console</h1>
        <p className="subtitle">Classroom 1 podium controller</p>
        <div className={`status-panel ${isOffline ? 'offline' : ''}`}>
          <span className="pulse" aria-hidden="true" />
          <span>{status}</span>
        </div>
        {isOffline ? (
          <p className="hint">The console cannot reach Media Control yet. It will retry automatically; remote support can still connect through Tailscale when the network is available.</p>
        ) : (
          <p className="hint">Starting trusted console session, loading the Guest profile, and preparing touchscreen controls.</p>
        )}
      </section>
    </main>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<App />);
