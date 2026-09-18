// LibraryToggle (feature 002 M3.3, design-system §Shared component
// inventory): one shared accessible icon toggle for Watch Later (bookmark)
// and Favourite (heart). Bare icon, 48px target, aria-pressed — never
// color alone. States: inactive, active, pending (busy), success (transient
// live announcement), error (truthful copy + retry by activation).
// The flags are independent: one toggle never overwrites the other, and the
// canonical id is used opaquely end to end.
import { useEffect, useRef, useState } from 'react';
import { Bookmark, Heart } from 'lucide-react';
import { FOCUS_RING_CLASS, TOUCH_TARGET_CLASS } from '../../lib/design-tokens';
import { useLibrary, useLibraryState } from '../../lib/library-react';
import { flagKey } from '../../lib/library-store.ts';
import type { LibraryCollection } from '../../lib/services/library-service';

const FIELD_META = {
  'watch-later': {
    icon: Bookmark,
    onLabel: 'Remove from Watch Later',
    offLabel: 'Save to Watch Later',
    removingLabel: 'Removing from Watch Later…',
    savingLabel: 'Saving to Watch Later…',
    errorLabel: 'Watch Later save failed',
    successLabel: 'Saved to Watch Later',
    removedLabel: 'Removed from Watch Later',
  },
  favourites: {
    icon: Heart,
    onLabel: 'Remove from Favourites',
    offLabel: 'Mark as Favourite',
    removingLabel: 'Removing from Favourites…',
    savingLabel: 'Adding to Favourites…',
    errorLabel: 'Favourite failed',
    successLabel: 'Added to Favourites',
    removedLabel: 'Removed from Favourites',
  },
} as const;

export function LibraryToggle({ canonicalId, field, variant = 'icon' }: { canonicalId: string; field: LibraryCollection; variant?: 'icon' | 'overlay' | 'label' }) {
  const state = useLibraryState();
  const store = useLibrary();
  const meta = FIELD_META[field];
  const Icon = meta.icon;

  const membership = state?.memberships[canonicalId];
  const pendingKey = flagKey(field, canonicalId);
  const pending = Boolean(state?.pending[pendingKey]);
  const error = state?.errors[pendingKey] ?? null;
  const active = field === 'watch-later' ? membership?.watchLater ?? false : membership?.favourite ?? false;
  const queuedTarget = store?.lastTargetFor(canonicalId, field);
  // While PENDING, the icon shows the in-flight intent; on ERROR the
  // confirmed server state is restored (requirement 10) and the failure is
  // signalled separately by the error ring, label, and live region.
  const shownTarget = pending && queuedTarget !== undefined ? queuedTarget : active;

  // Success feedback: announce the confirmed transition once (truthful —
  // driven by the reconciled server response, not the click).
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const wasPending = useRef(false);
  useEffect(() => {
    if (wasPending.current && !pending && !error) {
      setAnnouncement(shownTarget ? meta.successLabel : meta.removedLabel);
    }
    wasPending.current = pending;
  });

  useEffect(() => {
    if (!announcement) return;
    const timer = window.setTimeout(() => setAnnouncement(null), 4000);
    return () => window.clearTimeout(timer);
  }, [announcement]);

  if (!store) return null;

  const label = error
    ? `${meta.errorLabel} — activate to retry`
    : pending
      ? (shownTarget ? meta.savingLabel : meta.removingLabel)
      : active
        ? meta.onLabel
        : meta.offLabel;

  const onClick = () => {
    if (error) {
      store.retry(canonicalId, field);
    } else {
      store.toggle(canonicalId, field);
    }
  };

  return (
    <>
      <button
        type="button"
        aria-label={label}
        aria-pressed={shownTarget}
        aria-busy={pending || undefined}
        title={label}
        onClick={onClick}
        className={`relative inline-flex ${variant === 'label' ? 'min-h-12 gap-2 border border-white/20 bg-[#202020] px-4 text-sm font-medium hover:bg-[#2b2b2b]' : variant === 'overlay' ? 'h-11 w-11 border border-white/15 bg-black/60' : TOUCH_TARGET_CLASS} items-center justify-center rounded-full transition ${FOCUS_RING_CLASS} ${
          error
            ? 'text-red-300 after:absolute after:inset-0 after:rounded-full after:ring-2 after:ring-red-400/70'
            : active
              ? 'text-white'
              : 'text-white/75 hover:text-white'
        }`}
      >
        <Icon
          className={`h-5 w-5 transition-transform ${pending ? 'animate-pulse' : ''} ${shownTarget ? 'fill-current' : ''}`}
          strokeWidth={1.7}
          aria-hidden="true"
        />
        {variant === 'label' ? <span>{shownTarget ? 'Saved' : 'Watch Later'}</span> : null}
      </button>
      {/* Truthful state feedback in text: pending, success, and failure are
          announced, never color-only. */}
      <span className="sr-only" role="status" aria-live="polite">
        {pending
          ? (shownTarget ? meta.savingLabel : meta.removingLabel)
          : announcement ?? (error ? `${meta.errorLabel}. ${error} Activate the control to retry.` : '')}
      </span>
    </>
  );
}
