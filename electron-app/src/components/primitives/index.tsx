// Accessible shared primitives (feature 002 M2.1): bare icon controls with
// guaranteed accessible names and 48px touch targets, underline tabs for
// Library collections, and a bottom selection sheet for compact filters.
// All styling comes from the shared token source (globals.css vars).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { FOCUS_RING_CLASS, TOUCH_TARGET_CLASS } from '../../lib/design-tokens';

type IconButtonProps = {
  /** Required accessible name — IconButtons must never be icon-only-silent. */
  label: string;
  icon: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: 'ghost' | 'outline';
  className?: string;
};

export function IconButton({ label, icon, onClick, disabled, variant = 'ghost', className = '' }: IconButtonProps) {
  const variantClass = variant === 'outline'
    ? 'border border-white/15 text-white/75 hover:border-white/30 hover:text-white'
    : 'text-white/75 hover:bg-white/[0.08] hover:text-white';
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex ${TOUCH_TARGET_CLASS} items-center justify-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-50 ${variantClass} ${FOCUS_RING_CLASS} ${className}`}
    >
      {icon}
    </button>
  );
}

export type TabItem = { id: string; label: string };

type UnderlineTabsProps = {
  tabs: TabItem[];
  active: string;
  onChange: (id: string) => void;
  ariaLabel: string;
  /** Optional id of the controlled tabpanel (aria-controls association). */
  controlsId?: string;
};

// UnderlineTabs implement the full tab keyboard contract: the active tab is
// the only tab stop (roving tabindex), ArrowLeft/ArrowRight/Home/End move
// selection (automatic activation), and each tab declares its panel via
// aria-controls when the consumer supplies one.
export function UnderlineTabs({ tabs, active, onChange, ariaLabel, controlsId }: UnderlineTabsProps) {
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const activeIndex = Math.max(0, tabs.findIndex((tab) => tab.id === active));

  const moveSelection = (nextIndex: number) => {
    const next = tabs[(nextIndex + tabs.length) % tabs.length];
    if (!next) return;
    onChange(next.id);
    refs.current.get(next.id)?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        moveSelection(activeIndex + 1);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        moveSelection(activeIndex - 1);
        break;
      case 'Home':
        event.preventDefault();
        moveSelection(0);
        break;
      case 'End':
        event.preventDefault();
        moveSelection(tabs.length - 1);
        break;
      default:
        break;
    }
  };

  return (
    <div role="tablist" aria-label={ariaLabel} className="flex gap-1 border-b border-white/10">
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            ref={(element) => {
              if (element) refs.current.set(tab.id, element);
              else refs.current.delete(tab.id);
            }}
            role="tab"
            type="button"
            aria-selected={selected}
            aria-controls={controlsId}
            tabIndex={selected ? 0 : -1}
            onKeyDown={onKeyDown}
            onClick={() => onChange(tab.id)}
            className={`relative ${TOUCH_TARGET_CLASS} inline-flex items-center justify-center px-4 text-sm font-medium transition ${FOCUS_RING_CLASS} ${
              selected ? 'text-white' : 'text-white/55 hover:text-white/85'
            }`}
          >
            {tab.label}
            <span
              aria-hidden="true"
              className={`absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-white transition-opacity ${
                selected ? 'opacity-100' : 'opacity-0'
              }`}
            />
          </button>
        );
      })}
    </div>
  );
}

type SelectionSurfaceProps = {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
};

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// SelectionSurface: a modal bottom sheet for compact screens. Modal
// behavior: focus is contained inside the sheet while open (Tab wraps),
// focus returns to the opener on close, background scroll is locked, and
// the sheet content is height-bounded with internal scrolling. Enter uses
// the shared sheet motion tokens; prefers-reduced-motion collapses the
// animation via the CSS variables.
// Lifecycle: the open-state effect runs only when `open` flips — a parent
// rerender or a new `onClose` identity (inline callback) does NOT re-run it,
// so user focus inside the sheet is never reset mid-interaction. The latest
// onClose is always honored through a ref.
export function SelectionSurface({ open, title, onClose, children }: SelectionSurfaceProps) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const cleanupRef = useRef<(() => void) | null>(null);
  // Exit motion (M2.4): the sheet plays its out-animation before the close
  // actually happens. Reduced motion collapses the duration (read from the
  // shared CSS token) so the sheet closes immediately.
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const closeTimer = useRef<number | null>(null);

  const requestClose = () => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    let duration = 240;
    try {
      const raw = getComputedStyle(document.documentElement).getPropertyValue('--motion-sheet');
      const parsed = Number.parseInt(raw, 10);
      if (Number.isFinite(parsed) && parsed >= 0) duration = parsed;
    } catch {
      // keep the token default
    }
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      closingRef.current = false;
      setClosing(false);
      onCloseRef.current();
    }, duration);
  };

  useEffect(() => () => {
    if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
  }, []);

  useEffect(() => {
    if (!open) {
      // Run and drop the teardown exactly once per open→close transition.
      cleanupRef.current?.();
      cleanupRef.current = null;
      return;
    }
    if (cleanupRef.current) return; // already open; do not reset anything

    previouslyFocused.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        requestClose();
        return;
      }
      if (event.key !== 'Tab') return;
      // Focus containment: cycle Tab/Shift+Tab within the sheet.
      const sheet = sheetRef.current;
      if (!sheet) return;
      const focusable = Array.from(sheet.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        .filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const current = document.activeElement;
      if (event.shiftKey && (current === first || !sheet.contains(current))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (current === last || !sheet.contains(current))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    cleanupRef.current = () => {
      window.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      previouslyFocused.current?.focus?.();
      previouslyFocused.current = null;
    };
  }, [open]);
  // Unmount safety: if the sheet unmounts while open (e.g. route change),
  // the teardown still restores scroll.
  useEffect(() => () => {
    cleanupRef.current?.();
    cleanupRef.current = null;
  }, []);
  // Note: the open→close transition performs the teardown in the close
  // branch so focus restoration happens exactly once, after React has
  // removed the sheet from the DOM.

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center" role="presentation">
      <button
        type="button"
        aria-label="Close filters"
        tabIndex={-1}
        onClick={requestClose}
        className="absolute inset-0 bg-black/60"
        style={{
          animation: `${closing ? 'torwatch-backdrop-out' : 'torwatch-backdrop-in'} var(--motion-fast) var(--ease-standard) forwards`,
        }}
      />
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative w-full max-w-md rounded-t-2xl border border-white/10 bg-[#111] shadow-2xl"
        style={{
          animation: `${closing ? 'torwatch-sheet-out' : 'torwatch-sheet-in'} var(--motion-sheet) var(--ease-standard) forwards`,
        }}
      >
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <h2 className="text-sm font-semibold text-white">{title}</h2>
          <button
            ref={closeRef}
            type="button"
            aria-label={`Close ${title}`}
            onClick={requestClose}
            className={`inline-flex ${TOUCH_TARGET_CLASS} items-center justify-center rounded-full text-white/70 hover:text-white ${FOCUS_RING_CLASS}`}
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
        <div
          className="max-h-[60dvh] overflow-y-auto overscroll-contain px-4 py-3 pb-[calc(1rem+env(safe-area-inset-bottom))]"
        >
          {children}
        </div>
      </div>
    </div>
  );
}
