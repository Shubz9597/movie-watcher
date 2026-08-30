import { FormEvent, useState } from 'react';
import appIcon from '../assets/torwatch-app-icon.png';
import type { CatalogState } from '../types/electron';

type TmdbConnectionGateProps = {
  state: CatalogState;
};

export default function TmdbConnectionGate({ state }: TmdbConnectionGateProps) {
  const [credential, setCredential] = useState('');
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!window.electronAPI?.repairTmdb) {
      setLocalError('Secure settings are unavailable. Restart TorWatch and try again.');
      return;
    }

    setBusy(true);
    setLocalError('');
    try {
      const result = await window.electronAPI.repairTmdb(credential);
      if (!result.ok) setLocalError(result.error || 'TMDb could not be verified.');
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : 'TMDb could not be verified.');
    } finally {
      setBusy(false);
    }
  }

  const message = localError || state.issue;
  const actionLabel = busy
    ? 'Checking…'
    : credential
      ? 'Save and continue'
      : state.hasSavedCredential
        ? 'Retry saved credential'
        : 'Connect TMDb';

  return (
    <main className="flex min-h-[calc(100vh-40px)] items-center justify-center px-5 py-12">
      <section className="w-full max-w-[560px] overflow-hidden rounded-xl border border-white/10 bg-[#171717]">
        <header className="flex items-center gap-4 border-b border-white/10 px-6 py-6 sm:px-8">
          <img className="h-12 w-12 rounded-lg" src={appIcon} alt="" />
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-white/45">Catalog connection</p>
            <h1 className="mt-1 text-3xl font-normal tracking-tight text-white">Connect TMDb</h1>
          </div>
        </header>

        <form className="space-y-6 px-6 py-7 sm:px-8" onSubmit={(event) => void submit(event)}>
          <p className="text-sm leading-6 text-white/65">
            TorWatch will open your library after TMDb accepts the credential.
          </p>

          {message ? (
            <div className="rounded-lg border border-[#ffb4ab]/25 bg-[#ffb4ab]/[0.06] px-4 py-3 text-sm leading-5 text-[#ffb4ab]" role="alert">
              {message}
            </div>
          ) : null}

          <label className="block text-sm text-white/80">
            <span>TMDb API key or read access token</span>
            <input
              className="mt-2 min-h-12 w-full rounded-lg border border-white/15 bg-black/25 px-3.5 text-white outline-none transition placeholder:text-white/30 focus:border-white/45 focus:ring-2 focus:ring-white/10"
              type="password"
              value={credential}
              required={!state.hasSavedCredential}
              autoComplete="off"
              spellCheck={false}
              autoFocus={!state.hasSavedCredential}
              placeholder={state.hasSavedCredential ? 'Saved — enter a replacement to change it' : 'Paste your credential'}
              onChange={(event) => setCredential(event.target.value)}
              disabled={busy}
            />
          </label>

          <p className="text-xs leading-5 text-white/45">
            A TMDb API key (v3) is recommended. TMDb read access tokens (v4) are also supported.
          </p>

          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
            <button
              className="min-h-11 text-left text-sm text-white/60 underline decoration-white/25 underline-offset-4 transition hover:text-white disabled:opacity-50"
              type="button"
              onClick={() => void window.electronAPI?.openTmdbGuide?.()}
              disabled={busy}
            >
              Get a TMDb credential
            </button>
            <button
              className="min-h-11 rounded-full bg-white px-6 text-sm font-medium text-black transition hover:bg-white/85 disabled:cursor-wait disabled:opacity-55"
              type="submit"
              disabled={busy}
            >
              {actionLabel}
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}
