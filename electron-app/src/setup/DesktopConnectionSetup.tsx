import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import appIcon from '../assets/torwatch-app-icon.png';
import { SetupApp } from './SetupApp';
import type { DesktopServerConnection, SetupApi } from './types';

export function DesktopConnectionSetup({ api }: { api: SetupApi }) {
  const [connection, setConnection] = useState<DesktopServerConnection>({ mode: 'remote', origin: '' });
  const [active, setActive] = useState<DesktopServerConnection | null>(null);
  const [hasLegacySetup, setHasLegacySetup] = useState(false);
  const [legacy, setLegacy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [status, setStatus] = useState({ error: false, message: '' });
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.getDesktopConnection?.(), api.getMode()]).then(([saved, mode]) => {
      if (cancelled) return;
      if (saved?.connection) { setConnection(saved.connection); setActive(saved.connection); }
      setHasLegacySetup(saved?.hasLegacySetup ?? false);
      setLegacy(mode.mode === 'tmdb-gate');
      if (mode.issue) setStatus({ error: true, message: mode.issue });
    }).catch(() => {
      if (!cancelled) {
        setLoadFailed(true);
        setStatus({ error: true, message: 'Settings could not be loaded. Close this window and reopen Settings to retry.' });
      }
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [api]);

  const changeMode = (mode: DesktopServerConnection['mode']) => {
    setConnection({ mode, origin: active?.mode === mode ? active.origin : mode === 'local' ? 'http://127.0.0.1:8080' : '' });
    setStatus({ error: false, message: '' });
  };
  const connect = async (save: boolean) => {
    const action = save ? api.connectDesktopServer : api.probeDesktopServer;
    if (!action) { setStatus({ error: true, message: 'The desktop connection bridge is unavailable. Restart TorWatch.' }); return; }
    setBusy(save ? 'save' : 'test');
    setStatus({ error: false, message: save ? 'Checking your server before saving…' : 'Checking server readiness and compatibility…' });
    try {
      const result = await action(connection);
      if (!result.ok) throw new Error(result.error || 'The server could not be connected.');
      setStatus({ error: false, message: save
        ? 'Connection saved. TorWatch is restarting…'
        : `Connected to TorWatch ${result.connection?.serverVersion || 'server'}. Ready to save.` });
      if (!save) setBusy(null);
    } catch (error) {
      setBusy(null);
      setStatus({ error: true, message: error instanceof Error ? error.message : 'Connection failed. Check the server address and retry.' });
    }
  };
  const openGuide = async () => {
    try {
      const result = await api.openDesktopServerGuide?.();
      if (!result?.ok) throw new Error(result?.error || 'The server setup guide could not be opened.');
    } catch (error) {
      setStatus({ error: true, message: error instanceof Error ? error.message : 'The guide could not be opened.' });
    }
  };

  if (legacy) return <>
    <div className="desktop-legacy-back"><button type="button" onClick={() => setLegacy(false)}>Back to server connection</button></div>
    <SetupApp api={api} />
  </>;

  return <>
    <div className="window-chrome"><img src={appIcon} alt="" /><span>TorWatch</span></div>
    <main className="desktop-connection">
      <header>
        <img className="brand-mark" src={appIcon} alt="" />
        <div className="header-copy"><h1>Connect TorWatch</h1>
          <p className="intro">Choose where your server runs. Your movies, library and watch progress come from that server.</p>
        </div>
      </header>
      <form onSubmit={(event: FormEvent) => { event.preventDefault(); void connect(true); }}>
        <section aria-labelledby="desktop-server-heading">
          <div className="section-heading"><h2 id="desktop-server-heading">Your server</h2></div>
          <fieldset className="desktop-server-modes" disabled={Boolean(busy) || loading || loadFailed}>
            <legend className="desktop-sr-only">Where does your server run?</legend>
            <label className="desktop-server-choice">
              <input type="radio" name="server-mode" value="remote" checked={connection.mode === 'remote'} onChange={() => changeMode('remote')} />
              <span><strong>Homeserver (recommended)</strong><span>Use your phone's server for a shared library. Link its viewing profile below for Continue Watching.</span></span>
            </label>
            <label className="desktop-server-choice">
              <input type="radio" name="server-mode" value="local" checked={connection.mode === 'local'} onChange={() => changeMode('local')} />
              <span><strong>Server on this PC</strong><span>Run an independent server with Docker Desktop and your own database.</span></span>
            </label>
          </fieldset>
          <label className="desktop-server-url">Server URL
            <input type="url" value={connection.origin} required autoComplete="url" spellCheck={false}
              placeholder={connection.mode === 'local' ? 'http://127.0.0.1:8080' : 'https://your-homeserver.ts.net'}
              disabled={Boolean(busy) || loading || loadFailed} aria-describedby="desktop-server-hint"
              onChange={(event) => { setConnection({ ...connection, origin: event.target.value }); setStatus({ error: false, message: '' }); }} />
            <span className="hint" id="desktop-server-hint">{connection.mode === 'local'
              ? 'Start your Docker server first. Use its gateway address and port.'
              : 'Use the same server URL as your phone, including its port if needed.'}</span>
          </label>
          {connection.mode === 'remote' && <details><summary>Link Continue Watching from your phone</summary><div className="grid"><label className="wide">Phone viewing profile ID <span className="optional">Optional</span>
            <input value={connection.progressSubjectId || ''} autoComplete="off" spellCheck={false}
              disabled={Boolean(busy) || loading || loadFailed} maxLength={128}
              placeholder="Your phone's mw_device_id"
              aria-describedby="desktop-profile-hint"
              onChange={(event) => { setConnection({ ...connection, progressSubjectId: event.target.value }); setStatus({ error: false, message: '' }); }} />
            <span className="hint" id="desktop-profile-hint">Use your phone's existing profile to share Continue Watching and resume positions. Leave blank for this desktop's own progress.</span>
          </label></div></details>}
          <p className="desktop-server-note">{connection.mode === 'local'
            ? 'This server has its own library and progress. Use the local server starter from the Windows ZIP to set it up. Closing the desktop app leaves it running.'
            : 'Video plays on this Windows PC. Provider credentials stay on the server. Connect this PC to its network or Tailscale first.'}</p>
          <button className="help-link" type="button" onClick={() => void openGuide()}>Server setup guide</button>
        </section>
        {active && <p className="desktop-current-server">Current server: <span>{active.origin}</span></p>}
        <div className="desktop-server-status" role="status" aria-live="polite" aria-atomic="true" data-error={status.error}>
          {loading ? 'Loading saved connection…' : status.message || 'The address is checked before it is saved. Saving restarts the desktop app.'}
        </div>
        <div className="button-row desktop-server-actions">
          <button type="button" onClick={() => void connect(false)} disabled={!connection.origin.trim() || Boolean(busy) || loading || loadFailed}>
            {busy === 'test' ? 'Checking…' : 'Test connection'}
          </button>
          <button className="primary" type="submit" disabled={!connection.origin.trim() || Boolean(busy) || loading || loadFailed}>
            {busy === 'save' ? 'Connecting…' : 'Save and open TorWatch'}
          </button>
        </div>
        {hasLegacySetup && !active && <button className="help-link desktop-legacy-link" type="button" disabled={Boolean(busy)} onClick={() => setLegacy(true)}>Manage existing built-in local services</button>}
      </form>
    </main>
  </>;
}
