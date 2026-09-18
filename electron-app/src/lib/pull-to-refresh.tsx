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
//
// Performance: the pull distance is applied with DIRECT DOM writes to an
// isolated, memoized spinner — it never enters React state of the hosting
// page. A touchmove stream re-renders nothing; hosting a Library grid or a
// TitlePage through this hook used to re-render the whole page per frame.
import { memo, useEffect, useRef } from 'react';
import type { ReactElement, RefObject } from 'react';
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

type IndicatorHandles = {
  spinner: HTMLSpanElement | null;
  icon: SVGSVGElement | null;
};

// Isolated + memoized: the host page can re-render freely; this subtree only
// reconciles when `handles` identity changes (it never does — one ref per
// hook). All motion is applied imperatively below.
const PullIndicator = memo(function PullIndicator({ handles }: { handles: RefObject<IndicatorHandles> }) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-x-0 top-[max(0.25rem,env(safe-area-inset-top))] z-[80] flex justify-center"
    >
      <span
        ref={(node) => {
          handles.current.spinner = node;
        }}
        className="flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-[#0a0a0a]/90 shadow-lg backdrop-blur"
        style={{ transform: 'translateY(0px)', opacity: 0 }}
      >
        <LoaderCircle
          ref={(node: SVGSVGElement | null) => {
            handles.current.icon = node;
          }}
          className="h-5 w-5 text-[#ffc285]"
          aria-hidden="true"
        />
      </span>
    </div>
  );
});

export function usePullToRefresh(onRefresh: () => Promise<unknown> | unknown, enabled = true): PullToRefreshState {
  const pullRef = useRef(0);
  const refreshingRef = useRef(false);
  const gesture = useRef<{ startY: number; startX: number; engaged: boolean } | null>(null);
  const lock = useRef(false);
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;
  const handles = useRef<IndicatorHandles>({ spinner: null, icon: null });

  useEffect(() => {
    if (!enabled) return;

    // Single paint path: mirrors the previous state-driven markup exactly
    // (translateY from the pull distance, opacity from progress, 270° icon
    // sweep), but written straight to the spinner's DOM nodes.
    const paint = () => {
      const spinner = handles.current.spinner;
      if (!spinner) return;
      const distance = pullRef.current;
      const progress = refreshingRef.current ? 1 : Math.min(1, distance / THRESHOLD_PX);
      spinner.style.transform = `translateY(${Math.round(distance)}px)`;
      spinner.style.opacity = refreshingRef.current ? '1' : String(progress);
      const icon = handles.current.icon;
      if (icon) icon.style.transform = `rotate(${progress * 270}deg)`;
    };

    const setSpinning = (spinning: boolean) => {
      handles.current.icon?.classList.toggle('animate-spin', spinning);
    };

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
          paint();
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
      paint();
    };

    const onTouchEnd = () => {
      const engaged = gesture.current?.engaged === true;
      gesture.current = null;
      if (!engaged || pullRef.current < THRESHOLD_PX) {
        pullRef.current = 0;
        paint();
        return;
      }
      lock.current = true;
      refreshingRef.current = true;
      setSpinning(true);
      pullRef.current = SPINNER_REST_PX;
      paint();
      Promise.resolve(refreshRef.current())
        .catch(() => {})
        .finally(() => {
          refreshingRef.current = false;
          setSpinning(false);
          pullRef.current = 0;
          paint();
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

  return {
    refreshing: refreshingRef.current,
    indicator: enabled ? <PullIndicator handles={handles} /> : null,
  };
}
