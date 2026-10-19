// The connection banner shared by every page (see lib/connection-banner.ts):
// slides in when the server goes away, turns red when it stays away, green
// when it answers again, then slides out. Tap it while offline to ask again.
import { useEffect, useReducer, useRef } from 'react';
import { usePlatform, useConnectionStatus } from '../../platform/PlatformProvider';
import { bannerReduce, CONNECTED_MS, INITIAL_BANNER, RECONNECT_EVENT, type BannerPhase } from '../../lib/connection-banner';

const STYLE: Record<Exclude<BannerPhase, 'hidden'>, { box: string; dot: string }> = {
  reconnecting: { box: 'bg-[#ffc285]/12 text-[#ffc285]', dot: 'bg-[#ffc285] motion-safe:animate-pulse' },
  offline: { box: 'bg-red-500/15 text-red-300', dot: 'bg-red-400' },
  connected: { box: 'bg-emerald-500/15 text-emerald-300', dot: 'bg-emerald-400' },
  update: { box: 'bg-[#ffc285]/12 text-[#ffc285]', dot: 'bg-[#ffc285]' },
};

// `stickTo`: where it stays while the page scrolls (the desktop's sits
// under its window bar and header).
export function ConnectionBanner({ offlineNote, stickTo = 'top-0' }: { offlineNote?: string; stickTo?: string }) {
  const { connection } = usePlatform();
  const compat = useConnectionStatus();
  const [state, dispatch] = useReducer(bannerReduce, INITIAL_BANNER);
  const shown = useRef<Exclude<BannerPhase, 'hidden'>>('reconnecting');

  useEffect(() => {
    dispatch({ type: 'status', status: compat.status });
  }, [compat]);

  useEffect(() => {
    if (state.phase !== 'connected') return;
    const timer = window.setTimeout(() => dispatch({ type: 'settled' }), CONNECTED_MS);
    return () => window.clearTimeout(timer);
  }, [state.phase]);

  // Pull to refresh (any page) and a tap on the banner ask again.
  useEffect(() => {
    const onReconnect = () => {
      dispatch({ type: 'manual' });
      void connection.check().catch(() => {});
    };
    window.addEventListener(RECONNECT_EVENT, onReconnect);
    return () => window.removeEventListener(RECONNECT_EVENT, onReconnect);
  }, [connection]);

  const visible = state.phase !== 'hidden';
  if (visible) shown.current = state.phase as Exclude<BannerPhase, 'hidden'>;
  const phase = shown.current; // keeps its look while sliding out
  const text = phase === 'reconnecting' ? 'Reconnecting…'
    : phase === 'offline' ? `Server offline${offlineNote ? ` · ${offlineNote}` : ''}`
      : phase === 'connected' ? 'Connected'
        : 'Server needs an update';

  return (
    <div
      className={`sticky ${stickTo} z-30 grid transition-[grid-template-rows,opacity] duration-300 ease-out ${visible ? 'grid-rows-[1fr] opacity-100' : 'pointer-events-none grid-rows-[0fr] opacity-0'}`}
      aria-hidden={!visible}
    >
      <div className="overflow-hidden">
        <button
          type="button"
          role="status"
          aria-live="polite"
          tabIndex={visible && phase === 'offline' ? 0 : -1}
          onClick={() => {
            if (phase === 'offline') window.dispatchEvent(new CustomEvent(RECONNECT_EVENT));
          }}
          className={`flex w-full items-center justify-center gap-2 px-4 py-2 text-sm ${STYLE[phase].box}`}
        >
          <span className={`inline-block h-2 w-2 rounded-full ${STYLE[phase].dot}`} aria-hidden="true" />
          {text}
        </button>
      </div>
    </div>
  );
}
