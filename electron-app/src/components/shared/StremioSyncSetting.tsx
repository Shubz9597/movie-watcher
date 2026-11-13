// "Stremio" (Settings): link this profile's Stremio account so what it
// watches in Stremio (a TV, another phone) joins Continue Watching. Hidden
// when the server has no Stremio sync.
//
// Linking is per profile, on the server: link once and every device using
// the profile shows it. The usual way is a code approved on Stremio's own
// site (no password in TorWatch); email and password stay as a fallback.
import { useCallback, useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { FOCUS_RING_CLASS } from '../../lib/design-tokens';
import {
  STREMIO_SESSION_ENDED,
  cancelStremioLink,
  linkStremio,
  loadStremioStatus,
  startStremioLink,
  stremioSyncNote,
  syncStremio,
  unlinkStremio,
  type StremioStatus,
} from '../../lib/services/stremio-service';

const INPUT_CLASS = 'mt-1.5 w-full min-h-12 rounded-lg border border-white/15 bg-black/30 px-3.5 text-base text-white placeholder:text-white/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60';
const PRIMARY_CLASS = 'cinema-primary flex min-h-12 w-full items-center justify-center rounded-lg bg-white px-5 text-sm font-medium text-black transition hover:bg-white/85 disabled:cursor-not-allowed disabled:opacity-40';
const SECONDARY_CLASS = `flex min-h-11 flex-1 items-center justify-center rounded-lg border border-white/20 px-4 text-sm text-white/85 transition hover:border-white/40 disabled:opacity-40 ${FOCUS_RING_CLASS}`;
const QUIET_CLASS = `min-h-11 rounded-lg px-1 text-sm text-white/65 underline decoration-white/25 underline-offset-4 hover:text-white ${FOCUS_RING_CLASS}`;

type Busy = 'start' | 'link' | 'sync' | 'unlink' | 'cancel' | null;

export function StremioSyncSetting() {
  const [status, setStatus] = useState<StremioStatus | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [useEmail, setUseEmail] = useState(false);

  const refresh = useCallback(async () => {
    const next = await loadStremioStatus();
    if (next) setStatus(next);
  }, []);

  useEffect(() => {
    let active = true;
    void loadStremioStatus().then((next) => { if (active) setStatus(next); });
    return () => { active = false; };
  }, []);

  // While a code waits for approval, check every few seconds and as soon as
  // the app comes back from the browser.
  const waiting = Boolean(status?.pending && !status.pending.expired);
  useEffect(() => {
    if (!waiting) return undefined;
    const timer = setInterval(() => void refresh(), 3000);
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [waiting, refresh]);

  if (!status) return null;
  const account = status.linked ? status.account : undefined;
  const relink = account?.lastError === STREMIO_SESSION_ENDED;
  const pending = status.pending;
  const needsLink = !account || relink;

  const run = async (kind: Exclude<Busy, null>, action: () => Promise<StremioStatus>, failure?: string) => {
    setBusy(kind);
    setError(null);
    try {
      const next = await action();
      setStatus(next);
      if (kind === 'link') {
        setPassword('');
        setUseEmail(false);
      }
    } catch (cause) {
      setError(failure ?? (cause instanceof Error ? cause.message : 'Something went wrong.'));
    } finally {
      setBusy(null);
    }
  };
  const startCode = () => void run('start', startStremioLink, 'Couldn’t get a code from Stremio. Try again, or use your email and password.');
  const note = account ? stremioSyncNote(account) : null;
  // Linking again after Stremio signed TorWatch out keeps the email.
  const typedEmail = (email || (relink ? account?.email ?? '' : '')).trim();

  return (
    <section className="mt-10" aria-label="Stremio">
      <h2 className="type-secondary mb-2 text-left font-medium text-white/70">Stremio</h2>
      <div className="rounded-lg border border-white/[0.08] bg-white/[0.03] p-3.5 text-left">
        {account ? (
          <div role="status">
            <p className="text-sm font-medium text-white">{account.email ? `Linked as ${account.email}` : 'Stremio is linked'}</p>
            {note ? <p className={`type-secondary mt-0.5 ${note.problem ? 'text-[#ffc285]' : 'text-white/60'}`}>{note.text}</p> : null}
          </div>
        ) : (
          <p className="type-secondary text-white/70">
            Watch something in Stremio on your TV or another device, and it shows up in Continue watching here.
          </p>
        )}

        {needsLink && pending && !pending.expired && !useEmail ? (
          <div className="mt-3" aria-live="polite">
            <p className="text-sm text-white">Approve TorWatch in Stremio, then come back here.</p>
            <a
              href={pending.link}
              target="_blank"
              rel="noreferrer"
              className={`${PRIMARY_CLASS} mt-3 ${FOCUS_RING_CLASS}`}
            >
              Open Stremio to approve
            </a>
            <p className="type-secondary mt-3 text-white/60">
              Or on any device, go to <span className="text-white/85">link.stremio.com</span> and enter
              {' '}<span className="text-numeric font-semibold tracking-[0.2em] text-white">{pending.code}</span>
            </p>
            <div className="mt-3 flex items-center justify-between gap-3">
              <p className="type-secondary inline-flex items-center gap-2 text-white/60" role="status">
                <LoaderCircle className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" /> Waiting for approval…
              </p>
              <button type="button" onClick={() => void run('cancel', cancelStremioLink)} disabled={busy !== null} className={QUIET_CLASS}>
                Cancel
              </button>
            </div>
          </div>
        ) : needsLink && !useEmail ? (
          <div className="mt-3">
            {pending?.expired ? <p className="type-secondary mb-2 text-[#ffc285]" role="status">That code expired before it was approved.</p> : null}
            <button type="button" onClick={startCode} disabled={busy !== null} className={`${PRIMARY_CLASS} ${FOCUS_RING_CLASS}`}>
              {busy === 'start' ? 'Getting a code…' : pending?.expired ? 'Get a new code' : relink ? 'Link again' : 'Link Stremio account'}
            </button>
            <p className="type-secondary mt-2 text-white/50">
              You approve it on Stremio’s own site. Your password never goes through TorWatch.
            </p>
            <button type="button" onClick={() => { setUseEmail(true); setError(null); }} className={`mt-1 ${QUIET_CLASS}`}>
              Use email and password instead
            </button>
          </div>
        ) : null}

        {needsLink && useEmail ? (
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
            <button type="submit" disabled={!typedEmail || !password || busy !== null} className={`${PRIMARY_CLASS} mt-3`}>
              {busy === 'link' ? 'Linking…' : relink ? 'Link again' : 'Link Stremio'}
            </button>
            <button type="button" onClick={() => { setUseEmail(false); setError(null); }} className={`mt-1 ${QUIET_CLASS}`}>
              Link with a code instead
            </button>
          </form>
        ) : null}

        {account ? (
          <div className="mt-3 flex gap-3">
            {!relink ? (
              <button type="button" onClick={() => void run('sync', syncStremio)} disabled={busy !== null} className={SECONDARY_CLASS}>
                {busy === 'sync' ? 'Syncing…' : 'Sync now'}
              </button>
            ) : null}
            <button type="button" onClick={() => void run('unlink', unlinkStremio)} disabled={busy !== null} className={`${SECONDARY_CLASS} text-white/70`}>
              {busy === 'unlink' ? 'Unlinking…' : 'Unlink'}
            </button>
          </div>
        ) : null}

        {account && !relink ? (
          <p className="type-secondary mt-3 text-white/45">Linked for this profile on every device.</p>
        ) : null}

        {error ? <p className="mt-3 text-sm text-red-400" role="alert">{error}</p> : null}
      </div>
    </section>
  );
}
