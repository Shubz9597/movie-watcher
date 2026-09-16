// Mobile server settings (feature 002 M1.4.6; repair pass M1.4).
// UI shell only — the deterministic logic lives in origin-config.ts.

import * as React from 'react';
import { ChevronLeft } from 'lucide-react';
import type { ConnectionConfig } from '../platform/contracts.ts';
import { FOCUS_RING_CLASS } from '../lib/design-tokens';
import {
  applyServerOrigin,
  normalizeOrigin,
  probeOrigin,
  type ProbeState,
} from './origin-config.ts';
export function ServerSettings(props: {
  connection: ConnectionConfig;
  storage: { getPreference(key: string): string | null };
  onDone: () => void;
  fetchImpl?: typeof fetch;
}) {
  const fetchImpl = props.fetchImpl ?? fetch.bind(globalThis);
  const current = props.storage.getPreference('mw_server_origin') ?? '';
  const [value, setValue] = React.useState(current);
  const [state, setState] = React.useState<ProbeState>({ kind: 'idle' });
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [savedOrigin, setSavedOrigin] = React.useState<string | null>(null);

  const normalized = normalizeOrigin(value);
  const changed = normalized !== null && normalized !== current;

  const probe = async (): Promise<ProbeState | null> => {
    setError(null);
    if (!normalized) {
      setState({ kind: 'unreachable', message: 'Enter a valid http(s) origin, for example https://your-node.ts.net.' });
      return null;
    }
    setState({ kind: 'probing' });
    const probed = await probeOrigin(fetchImpl, normalized);
    setState(probed);
    return probed;
  };

  const save = async (): Promise<void> => {
    setError(null);
    if (!normalized) return;
    setSaving(true);
    try {
      const outcome = await applyServerOrigin({
        connection: props.connection,
        storage: props.storage,
        fetchImpl,
        origin: normalized,
      });
      switch (outcome.result) {
        case 'saved':
          setSavedOrigin(normalized);
          props.onDone();
          return;
        case 'saved-without-playback':
          // Reachable WITHOUT native playback is a separate, truthful state:
          // saved, limitation displayed (not silently ignored).
          setSavedOrigin(normalized);
          setState(await probeOrigin(fetchImpl, normalized));
          return;
        case 'blocked-unreachable':
          setState({
            kind: 'unreachable',
            message: 'Connection failed. Check your server and try again.',
          });
          setError('Nothing was saved. Correct the address or server connection, then retry.');
          return;
        case 'blocked-incompatible':
          setState({ kind: 'incompatible', message: 'The server is incompatible with TorWatch.' });
          setError('The server is incompatible — nothing was saved.');
          return;
        case 'blocked-persist-failed':
          setError('The server address could not be stored on this device. Retry or free up storage.');
          return;
        default:
          setError(outcome.message);
      }
    } catch (saveError) {
      console.error('[Settings] Server address could not be applied:', saveError);
      setError('The server address could not be applied. Check the connection and retry.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="min-h-screen bg-[#0a0a0a] text-white">
      {/* Nav-style header: chevron beside the title, safe-area aware. */}
      <header className="sticky top-0 z-10 flex items-center gap-1 border-b border-white/[0.08] bg-[#0a0a0a]/95 px-2 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))] backdrop-blur">
        <button
          type="button"
          onClick={props.onDone}
          aria-label="Back"
          className={`inline-flex h-12 w-12 items-center justify-center rounded-full text-white/85 transition hover:bg-white/[0.08] ${FOCUS_RING_CLASS}`}
        >
          <ChevronLeft className="h-6 w-6" strokeWidth={1.7} aria-hidden="true" />
        </button>
        <h1 className="text-lg font-semibold tracking-tight text-white">Server settings</h1>
      </header>

      <section className="mx-auto w-full max-w-md px-5 pb-[max(32px,env(safe-area-inset-bottom))] pt-6">
        <p className="text-sm leading-6 text-white/60">
          Enter the HTTP or HTTPS address of your private TorWatch server.
          Only this address is stored on the device.
        </p>

        <label className="mt-7 block text-left text-xs font-medium uppercase tracking-wide text-white/50" htmlFor="mobile-origin">
          Server address
        </label>
        <input
          id="mobile-origin"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={value}
          disabled={saving || state.kind === 'probing'}
          onChange={(event) => { setValue(event.target.value); if (error) setError(null); }}
          placeholder="https://your-node.your-tailnet.ts.net"
          // text-base (16px): iOS auto-zooms the viewport when focusing any
          // input below 16px — 16px is the mobile-correct size, not a style
          // preference.
          className="mt-2 w-full min-h-12 rounded-lg border border-white/15 bg-black/30 px-3.5 text-base text-white placeholder:text-base placeholder:text-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
        />

        {(state.kind !== 'idle' || savedOrigin || error) ? (
          <div className="mt-4 space-y-2 rounded-lg border border-white/[0.08] bg-white/[0.03] p-3.5 text-left text-sm" role="status">
            {state.kind === 'probing' ? <p className="text-white/60">Checking the server…</p> : null}
            {state.kind === 'unreachable' ? <p className="text-red-400">{state.message}</p> : null}
            {state.kind === 'incompatible' ? <p className="text-[#ffc285]">{state.message}</p> : null}
            {state.kind === 'reachable' ? (
              <p className={state.nativePlayback ? 'text-emerald-300' : 'text-[#ffc285]'}>
                Reachable ·{' '}
                {state.nativePlayback
                  ? 'native playback ready'
                  : 'no native playback on this server (FFmpeg not configured server-side) — browsing and Library work'}
              </p>
            ) : null}
            {savedOrigin ? <p className="text-emerald-300">Saved — using {savedOrigin}</p> : null}
            {error ? <p className="text-red-400">{error}</p> : null}
          </div>
        ) : null}

        <div className="mt-8 flex flex-col gap-3">
          <button
            type="button"
            onClick={() => void save()}
            disabled={!normalized || !changed || saving}
            className="flex min-h-12 w-full items-center justify-center rounded-full bg-white px-5 text-sm font-medium text-black transition hover:bg-white/85 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            onClick={() => void probe()}
            disabled={!normalized || saving || state.kind === 'probing'}
            className="flex min-h-12 w-full items-center justify-center rounded-full border border-white/20 px-5 text-sm text-white/85 transition hover:border-white/40 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {state.kind === 'probing' ? 'Testing…' : 'Test connection'}
          </button>
        </div>
      </section>
    </main>
  );
}
