// The connection banner every page shares: what it says follows the server
// connection, not a single check.
//   Reconnecting… (amber)  the server just went away, or a pull to refresh
//                          is asking again;
//   Server offline (red)   it still did not answer on the next try;
//   Connected (green)      it answers again (it came back, a pull to
//                          refresh, a new address in Server settings), then
//                          the banner slides away;
//   Server needs an update (amber).
// Background retries while offline do not flash "Reconnecting…".

export type BannerPhase = 'hidden' | 'reconnecting' | 'offline' | 'connected' | 'update';
export type BannerState = { phase: BannerPhase; failures: number };
export type BannerEvent =
  | { type: 'status'; status: string }
  | { type: 'manual' }
  | { type: 'settled' };

export const INITIAL_BANNER: BannerState = { phase: 'hidden', failures: 0 };
/** How long "Connected" shows before the banner slides away. */
export const CONNECTED_MS = 1800;

const DOWN: ReadonlySet<BannerPhase> = new Set(['reconnecting', 'offline', 'update']);

export function bannerReduce(state: BannerState, event: BannerEvent): BannerState {
  switch (event.type) {
    case 'manual':
      // A pull to refresh while the server is away asks again, visibly.
      return DOWN.has(state.phase) ? { phase: 'reconnecting', failures: 1 } : state;
    case 'settled':
      return state.phase === 'connected' ? INITIAL_BANNER : state;
    case 'status':
      switch (event.status) {
        case 'ready':
          return DOWN.has(state.phase) ? { phase: 'connected', failures: 0 } : { phase: state.phase === 'connected' ? 'connected' : 'hidden', failures: 0 };
        case 'unreachable': {
          const failures = state.failures + 1;
          return { phase: failures >= 2 ? 'offline' : 'reconnecting', failures };
        }
        case 'incompatible':
          return { phase: 'update', failures: 0 };
        case 'checking':
          // A new address being tried (Server settings), or a check while away.
          return DOWN.has(state.phase) ? { phase: 'reconnecting', failures: Math.min(state.failures, 1) } : state;
        default:
          return state;
      }
  }
}

/** Ask every page's connection banner to re-check the server now. */
export const RECONNECT_EVENT = 'torwatch:reconnect';
export function requestReconnect(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(RECONNECT_EVENT));
}
