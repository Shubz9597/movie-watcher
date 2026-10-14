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
    setStatus({ error: false, message: save ? 'Checking the server before saving…' : 'Checking the server…' });
    try {
      const result = await action(connection);
      if (!result.ok) throw new Error(result.error || 'The server could not be connected.');
      setStatus({ error: false, message: save
        ? 'Saved. TorWatch is restarting…'
        : `Connected to TorWatch server ${result.connection?.serverVersion || ''}. Ready to save.`.replace(' .', '.') });
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

  const useBuiltIn = async () => {
    const result = await api.useBuiltInServices?.().catch(() => null);
    if (result && !result.ok) { setStatus({ error: true, message: result.error || 'The built-in services could not be selected.' }); return; }
    setLegacy(true);
  };

  if (legacy) return <>
    <div className="desktop-legacy-back"><button type="button" onClick={() => setLegacy(false)}>Back to server choice</button></div>
    <SetupApp api={api} />
  </>;

  const local = connection.mode === 'local';
  return <>
    <div className="window-chrome"><img src={appIcon} alt="" /><span>TorWatch</span></div>
    <main className="desktop-connection">
      <header>
        <img className="brand-mark" src={appIcon} alt="" />
        <div className="header-copy"><h1>Set up TorWatch</h1>
          <p className="intro">TorWatch plays video on this computer. A TorWatch server finds and streams the torrents and keeps your library and watch progress. Connect to a server you already run, or set up a new one on this computer.</p>
        </div>
      </header>
      <form onSubmit={(event: FormEvent) => { event.preventDefault(); void connect(true); }}>
        <section aria-labelledby="desktop-server-heading">
          <div className="section-heading"><h2 id="desktop-server-heading">Server</h2></div>
          <fieldset className="desktop-server-modes" disabled={Boolean(busy) || loading || loadFailed}>
            <legend className="desktop-sr-only">Which server should TorWatch use?</legend>
            <label className="desktop-server-choice">
              <input type="radio" name="server-mode" value="remote" checked={!local} onChange={() => changeMode('remote')} />
              <span><strong>Connect to an existing server</strong><span>A TorWatch server running on another computer, such as a home server or NAS. Every device that uses it shares the same library and watch progress.</span></span>
            </label>
            <label className="desktop-server-choice">
              <input type="radio" name="server-mode" value="local" checked={local} onChange={() => changeMode('local')} />
              <span><strong>Set up a new server on this computer</strong><span>Runs a TorWatch server here with Docker Desktop. It keeps its own library and watch progress.</span></span>
            </label>
          </fieldset>
          <label className="desktop-server-url">Server address
            <input type="url" value={connection.origin} required autoComplete="url" spellCheck={false}
              placeholder={local ? 'http://127.0.0.1:8080' : 'http://192.168.1.20:8080'}
              disabled={Boolean(busy) || loading || loadFailed} aria-describedby="desktop-server-hint"
              onChange={(event) => { setConnection({ ...connection, origin: event.target.value }); setStatus({ error: false, message: '' }); }} />
            <span className="hint" id="desktop-server-hint">{local
              ? 'Start the server with the local server starter (see the setup guide), then enter the address it shows, normally http://127.0.0.1:8080.'
              : 'The address your other devices use for this server, including its port. If it is only reachable over a VPN such as Tailscale, connect this computer to it first.'}</span>
          </label>
          <p className="desktop-server-note">{local
            ? 'Closing TorWatch leaves this server running in Docker. The setup guide explains how to start, stop and update it.'
            : 'Video plays on this computer and streams from the server. Provider keys such as TMDb stay on the server.'}</p>
          <button className="help-link" type="button" onClick={() => void openGuide()}>Server setup guide</button>
        </section>
        {active && <p className="desktop-current-server">Current server: <span>{active.origin}</span></p>}
        <div className="desktop-server-status" role="status" aria-live="polite" aria-atomic="true" data-error={status.error}>
          {loading ? 'Loading saved settings…' : status.message || 'TorWatch checks the server before saving, then restarts.'}
        </div>
        <div className="button-row desktop-server-actions">
          <button type="button" onClick={() => void connect(false)} disabled={!connection.origin.trim() || Boolean(busy) || loading || loadFailed}>
            {busy === 'test' ? 'Checking…' : 'Test connection'}
          </button>
          <button className="primary" type="submit" disabled={!connection.origin.trim() || Boolean(busy) || loading || loadFailed}>
            {busy === 'save' ? 'Connecting…' : 'Save and start TorWatch'}
          </button>
        </div>
        {hasLegacySetup && !active && <button className="help-link desktop-legacy-link" type="button" disabled={Boolean(busy)} onClick={() => void useBuiltIn()}>Keep using the built-in services set up earlier on this computer</button>}
      </form>
    </main>
  </>;
}
