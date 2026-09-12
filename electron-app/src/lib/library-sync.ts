// LibrarySync (feature 002 M3.4): bounded background synchronization for the
// server-backed library — shared by the phone/browser and desktop entries.
//
// Rules (spec FR05, tasks M3.4):
//   - While the document is visible and the capability is available, poll at
//     most every POLL_INTERVAL_MS (15s); never while hidden.
//   - Refocus / visibility resume / network reconnect trigger a bounded
//     immediate refresh (REFRESH_MIN_GAP_MS guard against thrash).
//   - Polls never overlap (the store's refreshAll guards, and the interval
//     respects the last poll time).
//   - An origin switch is handled by the store (state cleared, capability
//     re-checked once); the sync loop never re-probes an older server on a
//     timer — availability must already be 'available' to poll.
//   - No offline write queue exists anywhere; failed writes surface Retry.
export const POLL_INTERVAL_MS = 15_000;
const REFRESH_MIN_GAP_MS = 5_000;
// A real timer can fire its tick a few milliseconds before the monotonic
// bookkeeping considers the interval elapsed. Dropping such a tick waits a
// FULL second interval (~30s effective), which violates the documented ≤20s
// cross-client visibility bound. A tick that lands just inside the window
// schedules a short catch-up for the remaining milliseconds instead.
const TICK_CATCHUP_MS = 2_000;

export type LibrarySync = {
  /** Run one bounded poll decision immediately (used by tests and by the
      visibility/online handlers). now defaults to Date.now(). */
  tick(now?: number): void;
  /** Force a refresh right now (bounded by the store's overlap guard). */
  pollNow(): void;
  detach(): void;
};

export function attachLibrarySync(
  store: import('./library-store.ts').LibraryController,
  deps: {
    documentRef?: { visibilityState: string; addEventListener(type: string, listener: () => void): void; removeEventListener(type: string, listener: () => void): void };
    windowRef?: { addEventListener(type: string, listener: () => void): void; removeEventListener(type: string, listener: () => void): void };
    setInterval?: typeof setInterval;
    clearInterval?: typeof clearInterval;
    setTimeout?: typeof setTimeout;
    clearTimeout?: typeof clearTimeout;
    now?: () => number;
  } = {},
): LibrarySync {
  const doc = deps.documentRef ?? (typeof document !== 'undefined' ? document : undefined);
  const win = deps.windowRef ?? (typeof window !== 'undefined' ? window : undefined);
  const setIntervalImpl = deps.setInterval ?? setInterval.bind(globalThis);
  const clearIntervalImpl = deps.clearInterval ?? clearInterval.bind(globalThis);
  const setTimeoutImpl = deps.setTimeout ?? setTimeout.bind(globalThis);
  const clearTimeoutImpl = deps.clearTimeout ?? clearTimeout.bind(globalThis);
  const now = deps.now ?? (() => Date.now());

  let lastPoll = 0;
  let interval: ReturnType<typeof setInterval> | null = null;
  let catchup: ReturnType<typeof setTimeout> | null = null;
  let detached = false;

  const tick = (nowOverride?: number) => {
    if (detached) return;
    const at = nowOverride ?? now();
    if (doc && doc.visibilityState !== 'visible') return; // paused while hidden
    if (store.getSnapshot().availability !== 'available') return; // never probe older/unreachable servers on a timer
    const elapsed = at - lastPoll;
    if (elapsed < POLL_INTERVAL_MS) { // bounded 15s polling
      const remaining = POLL_INTERVAL_MS - elapsed;
      // Timer jitter must not double the effective interval: re-check after
      // exactly the remaining time instead of the next full 15s tick.
      if (remaining <= TICK_CATCHUP_MS && catchup == null) {
        catchup = setTimeoutImpl(() => {
          catchup = null;
          tick();
        }, remaining);
      }
      return;
    }
    lastPoll = at;
    void store.refreshAll(); // overlap-guarded inside the store
  };

  const onVisible = () => {
    if (detached) return;
    // Visibility resume: refresh when the last poll is older than the
    // bounded gap (a long-hidden tab always refreshes here).
    if (now() - lastPoll >= REFRESH_MIN_GAP_MS) tick(now());
  };
  const onOnline = () => {
    if (detached) return;
    // Reconnect: re-check the capability once and refresh; event-driven, so
    // an older server is probed only when the network actually changes.
    void store.refreshCapability();
    onVisible();
  };

  if (doc) doc.addEventListener('visibilitychange', onVisible);
  if (win) win.addEventListener('online', onOnline);
  interval = setIntervalImpl(() => tick(), POLL_INTERVAL_MS);

  return {
    tick,
    pollNow: () => {
      if (detached) return;
      lastPoll = now();
      void store.refreshAll();
    },
    detach: () => {
      detached = true;
      if (doc) doc.removeEventListener('visibilitychange', onVisible);
      if (win) win.removeEventListener('online', onOnline);
      if (interval != null) clearIntervalImpl(interval);
      if (catchup != null) clearTimeoutImpl(catchup);
      interval = null;
      catchup = null;
    },
  };
}
