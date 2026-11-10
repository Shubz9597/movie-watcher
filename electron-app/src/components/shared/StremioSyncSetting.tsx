// "Stremio" (Settings): link this profile's Stremio account so what it
// watches in Stremio (a TV, another phone) joins Continue Watching. Hidden
// when the server has no Stremio sync.
import { useEffect, useState } from 'react';
import { FOCUS_RING_CLASS } from '../../lib/design-tokens';
import {
  STREMIO_SESSION_ENDED,
  linkStremio,
  loadStremioStatus,
  stremioSyncNote,
  syncStremio,
  unlinkStremio,
  type StremioStatus,
} from '../../lib/services/stremio-service';

const INPUT_CLASS = 'mt-1.5 w-full min-h-12 rounded-lg border border-white/15 bg-black/30 px-3.5 text-base text-white placeholder:text-white/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60';

export function StremioSyncSetting() {
  const [status, setStatus] = useState<StremioStatus | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<'link' | 'sync' | 'unlink' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void loadStremioStatus().then((next) => { if (active) setStatus(next); });
    return () => { active = false; };
  }, []);

  if (!status) return null;
  const account = status.linked ? status.account : undefined;
  const relink = account?.lastError === STREMIO_SESSION_ENDED;
  const showForm = !account || relink;

  const run = async (kind: 'link' | 'sync' | 'unlink', action: () => Promise<StremioStatus>) => {
    setBusy(kind);
    setError(null);
    try {
      setStatus(await action());
      if (kind === 'link') setPassword('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong.');
    } finally {
      setBusy(null);
    }
  };
  const note = account ? stremioSyncNote(account) : null;
  // Linking again after Stremio signed TorWatch out keeps the email.
  const typedEmail = (email || (relink ? account?.email ?? '' : '')).trim();

  return (
    <section className="mt-10" aria-label="Stremio">
      <h2 className="type-secondary mb-2 text-left font-medium text-white/70">Stremio</h2>
      <div className="rounded-lg border border-white/[0.08] bg-white/[0.03] p-3.5 text-left">
        {account ? (
          <div role="status">
            <p className="text-sm font-medium text-white">Linked as {account.email}</p>
            {note ? <p className={`type-secondary mt-0.5 ${note.problem ? 'text-[#ffc285]' : 'text-white/60'}`}>{note.text}</p> : null}
          </div>
        ) : (
          <p className="type-secondary text-white/70">
            Watch something in Stremio on your TV or another device, and it shows up in Continue watching here.
          </p>
        )}

        {showForm ? (
          <form
            className="mt-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (typedEmail && password) void run('link', () => linkStremio(typedEmail, password));
            }}
          >
            <label className="type-secondary block font-medium text-white/70" htmlFor="stremio-email">Stremio email</label>
            <input
              id="stremio-email"
              type="email"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={email || (relink ? account?.email ?? '' : '')}
              onChange={(event) => setEmail(event.target.value)}
              className={INPUT_CLASS}
            />
            <label className="type-secondary mt-3 block font-medium text-white/70" htmlFor="stremio-password">Password</label>
            <input
              id="stremio-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className={INPUT_CLASS}
            />
            <p className="type-secondary mt-2 text-white/50">
              Your password goes to Stremio once. TorWatch keeps only Stremio’s sign-in.
            </p>
            <button
              type="submit"
              disabled={!typedEmail || !password || busy !== null}
              className="cinema-primary mt-3 flex min-h-12 w-full items-center justify-center rounded-lg bg-white px-5 text-sm font-medium text-black transition hover:bg-white/85 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy === 'link' ? 'Linking…' : relink ? 'Link again' : 'Link Stremio'}
            </button>
          </form>
        ) : null}

        {account ? (
          <div className="mt-3 flex gap-3">
            {!relink ? (
              <button
                type="button"
                onClick={() => void run('sync', syncStremio)}
                disabled={busy !== null}
                className={`flex min-h-11 flex-1 items-center justify-center rounded-lg border border-white/20 px-4 text-sm text-white/85 transition hover:border-white/40 disabled:opacity-40 ${FOCUS_RING_CLASS}`}
              >
                {busy === 'sync' ? 'Syncing…' : 'Sync now'}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => void run('unlink', unlinkStremio)}
              disabled={busy !== null}
              className={`flex min-h-11 flex-1 items-center justify-center rounded-lg border border-white/20 px-4 text-sm text-white/70 transition hover:border-white/40 disabled:opacity-40 ${FOCUS_RING_CLASS}`}
            >
              {busy === 'unlink' ? 'Unlinking…' : 'Unlink'}
            </button>
          </div>
        ) : null}

        {error ? <p className="mt-3 text-sm text-red-400" role="alert">{error}</p> : null}
      </div>
    </section>
  );
}
