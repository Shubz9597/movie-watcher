// Keep one logo in place from the centered splash through the form reveal.
import * as React from 'react';
import type { ServerCompatibility } from '../../platform/contracts';
import { FOCUS_RING_CLASS } from '../../lib/design-tokens';
import torWatchLogo from '../../assets/torwatch-symbol.png';

type LaunchScreenProps = {
  compat: ServerCompatibility;
  onConnect: (origin: string) => Promise<string>;
};

function connectionFailureMessage(err: unknown, candidate: string): string {
  const message = err instanceof Error ? err.message : '';
  if (/unreachable|network|fetch/i.test(message)) {
    return `Could not reach ${candidate}. Check that the server is running and that both devices are on the same network.`;
  }
  if (/incompatible/i.test(message)) {
    return `${candidate} is running an incompatible TorWatch version. Update the server.`;
  }
  return message || 'The server address could not be applied. Check it and retry.';
}

function normalizedServerOrigin(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/u, '');
  try {
    const parsed = new URL(trimmed);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
        !parsed.hostname || parsed.username || parsed.password || parsed.search ||
        parsed.hash || (parsed.pathname && parsed.pathname !== '/')) {
      return null;
    }
    return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${parsed.port ? `:${parsed.port}` : ''}`;
  } catch {
    return null;
  }
}

export function LaunchScreen({ compat, onConnect }: LaunchScreenProps) {
  const probing = compat.status === 'checking';
  const [introReady, setIntroReady] = React.useState(false);
  const [revealed, setRevealed] = React.useState(false);

  React.useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const finish = () => setIntroReady(true);
    const timer = window.setTimeout(finish, motion.matches ? 0 : 240);
    const onMotionChange = () => { if (motion.matches) finish(); };
    motion.addEventListener('change', onMotionChange);
    return () => {
      window.clearTimeout(timer);
      motion.removeEventListener('change', onMotionChange);
    };
  }, []);

  React.useEffect(() => {
    // Latch the reveal: retries must preserve the field, error, and focus.
    if (introReady && !probing) setRevealed(true);
  }, [introReady, probing]);

  return (
    <main
      data-stage={revealed ? 'form' : 'splash'}
      className="tw-launch-screen flex flex-col items-center px-6 text-center"
    >
      <img
        src={torWatchLogo}
        alt=""
        aria-hidden="true"
        width={128}
        height={80}
        className="tw-launch-logo h-20 w-32 shrink-0 object-contain opacity-90 invert"
      />

      {!revealed ? <p className="sr-only" role="status">Finding your TorWatch server…</p> : null}
      {revealed ? (
        <div className="w-full max-w-md">
          <h1
            className="tw-launch-fade tw-launch-delay-1 mt-10 text-2xl font-semibold tracking-tight text-white"
            role="heading"
            aria-level={1}
          >
            {compat.status === 'incompatible' ? 'This server is not compatible' : 'Connect to your server'}
          </h1>
          <p className="tw-launch-fade tw-launch-delay-2 mx-auto mt-3 max-w-sm text-sm leading-6 text-white/60">
            {compat.message || 'Enter the address of your private TorWatch server to sync your library and start watching.'}
          </p>

          <div className="tw-launch-fade tw-launch-delay-3 mt-8">
            <LaunchOriginField compat={compat} onConnect={onConnect} />
          </div>
        </div>
      ) : null}
    </main>
  );
}

function LaunchOriginField({ compat, onConnect }: { compat: ServerCompatibility; onConnect: (origin: string) => Promise<string> }) {
  const [origin, setOrigin] = React.useState(compat.origin);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async (): Promise<void> => {
    if (pending) return;
    const candidate = normalizedServerOrigin(origin);
    if (!candidate) {
      setError('Enter a complete server address, such as http://192.168.1.50:4001.');
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onConnect(candidate);
    } catch (err) {
      console.error('[Connection] Server address could not be applied:', err);
      setError(connectionFailureMessage(err, candidate));
    } finally {
      setPending(false);
    }
  };

  const inputId = 'server-origin';

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      className="text-left"
    >
      <label className="block text-xs font-medium uppercase tracking-wide text-white/45" htmlFor={inputId}>
        Server address
      </label>
      <input
        id={inputId}
        value={origin}
        onChange={(event) => setOrigin(event.target.value)}
        placeholder="http://192.168.1.10:4001"
        inputMode="url"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        // 16px: iOS auto-zoom guard.
        className="mt-2 min-h-12 w-full rounded-xl border border-white/15 bg-white/[0.06] px-3.5 text-base text-white placeholder:text-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
      />

      {/* Error panel: polished, actionable, role=alert. */}
      {error ? (
        <div
          role="alert"
          className="mt-3 rounded-xl border border-red-300/25 bg-red-500/[0.08] px-4 py-3 text-sm leading-6 text-red-200"
        >
          {error}
        </div>
      ) : null}

      <button
        type="submit"
        disabled={pending || !origin.trim()}
        className={`mt-5 min-h-12 w-full rounded-full bg-white text-sm font-medium text-black transition hover:bg-white/85 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black ${FOCUS_RING_CLASS}`}
      >
        {pending ? (
          <span className="inline-flex items-center gap-2">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-black/70" aria-hidden="true" />
            Connecting…
          </span>
        ) : (
          'Connect'
        )}
      </button>
    </form>
  );
}
