// Press-and-hold for lists (touch and mouse). One controller serves every
// row: bind(onLongPress) returns the handlers for one row. A hold fires
// after `delay` ms unless the pointer moves (a scroll) or lifts first. The
// click that ends a hold is swallowed so the row's tap action does not also
// run; a hold usually changes the row's handlers (it starts selecting), so
// those handlers ask consumeHold() before treating a click as a tap.
import { useRef } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';

const MOVE_TOLERANCE_PX = 10;

export function useLongPress(delay = 450) {
  const timer = useRef<number | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);

  const cancel = () => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
    origin.current = null;
  };

  /** True once for the click that ends a hold (then cleared). */
  const consumeHold = (): boolean => {
    if (!fired.current) return false;
    fired.current = false;
    return true;
  };

  const bind = (onLongPress: () => void) => ({
    onPointerDown: (event: ReactPointerEvent) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      cancel();
      fired.current = false;
      origin.current = { x: event.clientX, y: event.clientY };
      timer.current = window.setTimeout(() => {
        timer.current = null;
        fired.current = true;
        // The lift ends the hold. A click, if the platform sends one (iOS
        // usually does not after a hold), follows in the same task; clear
        // the flag after it so the next real tap is not swallowed. The row's
        // own handlers have usually changed by then, hence the window.
        const clearAfterLift = () => window.setTimeout(() => { fired.current = false; }, 0);
        window.addEventListener('pointerup', clearAfterLift, { once: true, capture: true });
        window.addEventListener('pointercancel', clearAfterLift, { once: true, capture: true });
        onLongPress();
      }, delay);
    },
    onPointerMove: (event: ReactPointerEvent) => {
      const start = origin.current;
      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > MOVE_TOLERANCE_PX) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onPointerLeave: cancel,
    onClickCapture: (event: ReactMouseEvent) => {
      if (!fired.current) return;
      fired.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
    // iOS/desktop context menus would otherwise open on the same hold.
    onContextMenu: (event: ReactMouseEvent) => event.preventDefault(),
  });

  return { bind, consumeHold };
}
