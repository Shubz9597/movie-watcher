import type { PointerEvent } from 'react';
import { X } from 'lucide-react';
import type { PlaybackIdentity } from '../types';

type Props = {
  identity: PlaybackIdentity;
  failed: boolean;
  percentage: number;
  playbackStarted: boolean;
  status: string;
  onClose: () => void;
  onDragStart: (event: PointerEvent<HTMLElement>) => void;
  onDragMove: (event: PointerEvent<HTMLElement>) => void;
  onDragEnd: (event: PointerEvent<HTMLElement>) => void;
};

export function LoadingOverlay({
  identity,
  failed,
  percentage,
  playbackStarted,
  status,
  onClose,
  onDragStart,
  onDragMove,
  onDragEnd,
}: Props) {
  const posterUrl = identity.posterUrl || '';
  const progress = Math.max(0, Math.min(100, percentage));
  const posterStyle = posterUrl ? { backgroundImage: `url("${posterUrl.replace(/"/g, '\\"')}")` } : undefined;
  return (
    <section
      className={`loading-screen${playbackStarted ? ' hidden' : ''}`}
      id="loadingScreen"
      role={failed ? 'alert' : 'status'}
      aria-live="polite"
      aria-atomic="false"
      aria-busy={!playbackStarted && !failed}
    >
      <div
        className="loading-backdrop"
        id="loadingBackdrop"
        style={posterUrl ? { backgroundImage: `url("${posterUrl.replace(/"/g, '\\"')}")` } : undefined}
      />
      <div className="loading-vignette" />
      <div
        className="window-drag-surface"
        id="loadingWindowDrag"
        title="Drag player window"
        aria-hidden="true"
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
        onLostPointerCapture={onDragEnd}
      >
        <span className="window-drag-grip" />
      </div>
      <button className="icon-btn loading-close tooltip" id="loadingCloseBtn" data-tooltip="Close" aria-label="Close player" onClick={onClose}>
        <X aria-hidden="true" />
      </button>
      <div className="loader-content">
        <div className="poster-loader">
          <div
            className="poster-layer poster-base poster-background"
            id="posterBase"
            style={posterStyle}
          />
          <div
            className="poster-layer poster-base poster-foreground"
            style={{
              ...posterStyle,
              clipPath: `inset(0 ${100 - progress}% 0 0)`,
            }}
          />
          <div className="poster-shade" />
        </div>
        <div className="loader-copy">
          <div className="loader-eyebrow">Preparing playback</div>
          <div className="loader-title">
            <span id="loadingTitle">{identity.title || 'Preparing video'}</span>
            <span className="loader-year" id="loadingYear">{identity.year ? ` ${identity.year}` : ''}</span>
          </div>
          <div className={`loader-status${failed ? ' failed' : ''}`} id="loadingStatus">{status}</div>
          {failed ? (
            <button type="button" className="loader-back-button" onClick={onClose}>Choose another source</button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
