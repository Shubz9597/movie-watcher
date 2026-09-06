// Continue Watching carousel (feature 002 M2.2, WF01): snap-scrolling
// horizontal carousel with a next-card peek, progress on the artwork, and
// SEPARATED resume/detail targets. A drag/swipe release never fires the tap
// handlers, and there is deliberately no full-width resume bar.
// The Electron desktop Home keeps its existing rail by default; this
// component is the compact/alpha presentation selected explicitly.
import { useRef } from 'react';
import { Play } from 'lucide-react';
import { FOCUS_RING_CLASS } from '../../lib/design-tokens';
import type { EnrichedContinueItem } from '../../lib/services/continue-service';

type ContinueCarouselProps = {
  items: EnrichedContinueItem[];
  /** Resume intent (play on artwork). Wired to a real player path in M2.3. */
  onResumeRequest: (item: EnrichedContinueItem) => void;
  /** Detail intent (title text/artwork context) — opens the title page. */
  onOpenTitle: (item: EnrichedContinueItem) => void;
  onDismiss?: (item: EnrichedContinueItem) => void;
};

export function ContinueCarousel({ items, onResumeRequest, onOpenTitle, onDismiss }: ContinueCarouselProps) {
  // Drag detection: any pointer movement beyond the threshold between down
  // and up marks the gesture as a scroll, not a tap, so releasing a swipe on
  // a card cannot start playback or navigation.
  const pointerStart = useRef<{ x: number; y: number; dragged: boolean } | null>(null);

  const beginPointer = (event: React.PointerEvent) => {
    pointerStart.current = { x: event.clientX, y: event.clientY, dragged: false };
  };
  const movePointer = (event: React.PointerEvent) => {
    const start = pointerStart.current;
    if (!start) return;
    if (Math.abs(event.clientX - start.x) > 8 || Math.abs(event.clientY - start.y) > 8) {
      start.dragged = true;
    }
  };
  const wasDragged = () => pointerStart.current?.dragged === true;

  return (
    <div
      className="hide-scrollbar -mx-5 flex snap-x snap-mandatory gap-4 overflow-x-auto px-5 pb-2 md:mx-0 md:px-0"
      onPointerDown={beginPointer}
      onPointerMove={movePointer}
    >
      {items.map((item) => {
        const pct = Math.max(0, Math.min(100, Math.round(Number(item.percent) || 0)));
        const displayTitle = item.title || item.seriesId;
        const episodeBadge = item.kind !== 'movie'
          ? `S${String(item.season).padStart(2, '0')}E${String(item.episode).padStart(2, '0')}`
          : `${pct}%`;
        return (
          <article
            key={`${item.seriesId}-${item.season}-${item.episode}`}
            className="w-[240px] shrink-0 snap-start sm:w-[260px]"
          >
            <div className="relative aspect-video overflow-hidden rounded-xl border border-white/10 bg-[#151515]">
              {item.posterPath ? (
                <img
                  src={item.posterPath}
                  alt=""
                  width="342"
                  height="193"
                  loading="lazy"
                  decoding="async"
                  className="absolute inset-0 h-full w-full object-cover"
                />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-white/[0.08] to-white/[0.025]">
                  <span className="text-3xl opacity-30" aria-hidden="true">🎬</span>
                </div>
              )}
              <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" aria-hidden="true" />

              {/* Resume target: a real button with an accessible name. The
                      pointer handlers on the scroller suppress taps after drags. */}
              <button
                type="button"
                aria-label={`Resume ${displayTitle}`}
                onClick={() => { if (!wasDragged()) onResumeRequest(item); }}
                className={`absolute left-1/2 top-1/2 flex h-12 w-12 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white/95 text-black shadow-lg transition hover:scale-105 ${FOCUS_RING_CLASS}`}
              >
                <Play className="ml-0.5 h-5 w-5 fill-current" aria-hidden="true" />
              </button>

              <div className="absolute left-3 top-3">
                <span className="font-label text-numeric rounded-md bg-black/70 px-2 py-1 text-xs text-white/90">
                  {episodeBadge}
                </span>
              </div>

              {/* Progress lives on the artwork (accepted alpha design). */}
              <div className="absolute inset-x-0 bottom-0 h-1.5 bg-white/10">
                <div className="h-full bg-[#ff7a17]" style={{ width: `${pct}%` }} />
              </div>
            </div>

            <div className="mt-2 flex items-center justify-between gap-2">
              {/* Detail target: the title opens the page; it never plays. */}
              <button
                type="button"
                onClick={() => { if (!wasDragged()) onOpenTitle(item); }}
                className={`min-h-11 flex-1 text-left text-sm font-medium leading-5 text-white line-clamp-2 rounded-lg px-1 hover:text-white/85 ${FOCUS_RING_CLASS}`}
              >
                {displayTitle}
                <span className="block text-xs font-normal text-white/55">
                  {item.upNext ? 'Up next' : item.year ?? ''}
                </span>
              </button>
              {onDismiss ? (
                <button
                  type="button"
                  aria-label={`Remove ${displayTitle} from Continue watching`}
                  onClick={() => { if (!wasDragged()) onDismiss(item); }}
                  className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white/50 hover:bg-white/[0.08] hover:text-white ${FOCUS_RING_CLASS}`}
                >
                  ✕
                </button>
              ) : null}
            </div>
          </article>
        );
      })}
    </div>
  );
}
