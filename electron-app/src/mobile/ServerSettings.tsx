// Mobile server settings (feature 002 M1.4.6; repair pass M1.4).
// UI shell only — the deterministic logic lives in origin-config.ts.

import * as React from 'react';
import type { ConnectionConfig } from '../platform/contracts.ts';
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
          setState({ kind: 'unreachable', message: 'The server could not be reached.' });
          setError('The server is unreachable — nothing was saved.');
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
      setError(
        saveError instanceof Error && saveError.message
          ? saveError.message
          : 'The server address could not be applied.',
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="min-h-screen bg-[#0a0a0a] px-5 pb-[max(24px,env(safe-area-inset-bottom))] pt-[max(24px,env(safe-area-inset-top))] text-white">
      <section className="mx-auto w-full max-w-md">
        <h1 className="type-section-title text-white">Server settings</h1>
        <p className="mt-2 text-sm text-white/60">
          Enter the HTTPS address of your private TorWatch server. Only this
          address is stored on the device.
        </p>

        <label className="mt-6 block text-left text-xs font-medium uppercase tracking-wide text-white/50" htmlFor="mobile-origin">
          Server address
        </label>
        <input
          id="mobile-origin"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="https://your-node.your-tailnet.ts.net"
          className="mt-2 w-full min-h-12 rounded-lg border border-white/15 bg-black/30 px-3.5 text-white placeholder:text-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
        />

        <div className="mt-3 min-h-6 text-left text-sm" role="status">
          {state.kind === 'probing' ? <span className="text-white/60">Checking the server...</span> : null}
          {state.kind === 'unreachable' ? <span className="text-red-400">{state.message}</span> : null}
          {state.kind === 'incompatible' ? <span className="text-[#ffc285]">{state.message}</span> : null}
          {state.kind === 'reachable' ? (
            <span className={state.nativePlayback ? 'text-emerald-300' : 'text-[#ffc285]'}>
              Reachable ·{' '}
              {state.nativePlayback
                ? 'native playback ready'
                : 'this server has no native playback (FFmpeg not configured server-side) — browsing and Library work'}
            </span>
          ) : null}
          {savedOrigin ? <span className="text-emerald-300">Saved. Using {savedOrigin}</span> : null}
          {error ? <span className="text-red-400">{error}</span> : null}
        </div>

        <div className="mt-6 flex flex-col gap-3">
          <button
            type="button"
            onClick={() => void probe()}
            disabled={!normalized || state.kind === 'probing'}
            className="min-h-12 w-full rounded-full border border-white/20 px-5 text-sm text-white/85 transition hover:border-white/40 disabled:opacity-50"
          >
            Test connection
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={!normalized || !changed || saving}
            className="min-h-12 w-full rounded-full bg-white px-5 text-sm font-medium text-black transition hover:bg-white/85 disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save and use this server'}
          </button>
          <button
            type="button"
            onClick={props.onDone}
            className="min-h-12 w-full rounded-full px-5 text-sm text-white/60 underline decoration-white/25 underline-offset-4"
          >
            Back
          </button>
        </div>
      </section>
    </main>
  );
}
