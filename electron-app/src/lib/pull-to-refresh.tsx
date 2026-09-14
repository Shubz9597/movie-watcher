// Pull-to-refresh (device pass): application-wide manual refresh for the
// window-scrolled pages (home, browse/see-all, title detail, library).
//
// Design:
//  - Touch-only, engaged ONLY when the page is at scroll top and the gesture
//    is predominantly downward — normal scrolling, horizontal rails and
//    carousels are never hijacked. Elements can opt out with
//    `data-pull-to-refresh="ignore"`.
//  - Rubber-banded indicator: a small spinner that stretches down with the
//    pull and spins while the refresh promise runs. Failures surface through
//    the page's own error states — the indicator just ends.
//  - Bounded: one refresh at a time (re-pulls during a refresh are dropped).
import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { LoaderCircle } from 'lucide-react';

const THRESHOLD_PX = 70;
const MAX_PULL_PX = 130;
const SPINNER_REST_PX = 44;
const ENGAGE_PX = 10;

export type PullToRefreshState = {
  /** Render this next to the page root — it is null unless pulling/refreshing. */
  indicator: ReactElement | null;
  refreshing: boolean;
};

export function usePullToRefresh(onRefresh: () => Promise<unknown> | unknown, enabled = true): PullToRefreshState {
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const pullRef = useRef(0);
  const refreshingRef = useRef(false);
  const gesture = useRef<{ startY: number; startX: number; engaged: boolean } | null>(null);
  const lock = useRef(false);
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;

  useEffect(() => {
    if (!enabled) return;

    const ignoresPull = (target: EventTarget | null): boolean => {
      let node = target instanceof Element ? target : null;
      while (node) {
        if (node.getAttribute('data-pull-to-refresh') === 'ignore') return true;
        node = node.parentElement;
      }
      return false;
    };

    const onTouchStart = (event: TouchEvent) => {
      if (lock.current || refreshingRef.current) return;
      if (window.scrollY > 0) return;
      const touch = event.touches[0];
      gesture.current = { startY: touch.clientY, startX: touch.clientX, engaged: false };
    };

    const onTouchMove = (event: TouchEvent) => {
      const current = gesture.current;
      if (!current || lock.current || refreshingRef.current) return;
      if (window.scrollY > 0) {
        gesture.current = null;
        if (pullRef.current !== 0) {
          pullRef.current = 0;
          setPull(0);
        }
        return;
      }
      const touch = event.touches[0];
      const dy = touch.clientY - current.startY;
      const dx = touch.clientX - current.startX;
      if (!current.engaged) {
        if (dy <= ENGAGE_PX || Math.abs(dx) > Math.abs(dy)) {
          if (dy < -ENGAGE_PX) gesture.current = null; // scrolling up/away
          return;
        }
        if (ignoresPull(event.target)) return;
        current.engaged = true;
      }
      // Own the gesture while the rubber band is engaged.
      event.preventDefault();
      const distance = Math.min(MAX_PULL_PX, dy * 0.5);
      pullRef.current = distance;
      setPull(distance);
    };

    const onTouchEnd = () => {
      const engaged = gesture.current?.engaged === true;
      gesture.current = null;
      if (!engaged || pullRef.current < THRESHOLD_PX) {
        pullRef.current = 0;
        setPull(0);
        return;
      }
      lock.current = true;
      refreshingRef.current = true;
      setRefreshing(true);
      pullRef.current = SPINNER_REST_PX;
      setPull(SPINNER_REST_PX);
      Promise.resolve(refreshRef.current())
        .catch(() => {})
        .finally(() => {
          setRefreshing(false);
          setPull(0);
          pullRef.current = 0;
          lock.current = false;
        });
    };

    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd);
    window.addEventListener('touchcancel', onTouchEnd);
    return () => {
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
      window.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [enabled]);

  if (!enabled || (pull <= 0 && !refreshing)) return { indicator: null, refreshing: false };
  const progress = refreshing ? 1 : Math.min(1, pull / THRESHOLD_PX);
  return {
    refreshing,
    indicator: (
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-x-0 top-[max(0.25rem,env(safe-area-inset-top))] z-[80] flex justify-center"
      >
        <span
          className="flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-[#0a0a0a]/90 shadow-lg backdrop-blur"
          style={{ transform: `translateY(${Math.round(pull)}px)`, opacity: refreshing ? 1 : progress }}
        >
          <LoaderCircle
            className={`h-5 w-5 text-[#ffc285] ${refreshing ? 'animate-spin' : ''}`}
            style={{ transform: `rotate(${progress * 270}deg)` }}
            aria-hidden="true"
          />
        </span>
      </div>
    ),
  };
}
