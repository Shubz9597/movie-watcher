// A title shown the way streaming apps do: the film's own logo artwork
// (catalog artwork.logo) instead of typed text. The text heading stays in
// the page for screen readers and is shown whenever there is no logo, it
// fails to load, or it is too dark to read on the dark canvas.
import { useEffect, useState, type ReactNode } from 'react';

// Logos measured once per URL (they repeat across hero, title page, shelves).
const verdicts = new Map<string, boolean>();

/** Whether the logo has enough light pixels to read on a dark background. */
function readableOnDark(image: HTMLImageElement): boolean {
  try {
    const canvas = document.createElement('canvas');
    const width = 64;
    const height = Math.max(1, Math.round((image.naturalHeight / Math.max(1, image.naturalWidth)) * width));
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return true;
    context.drawImage(image, 0, 0, width, height);
    const { data } = context.getImageData(0, 0, width, height);
    let visible = 0;
    let light = 0;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index + 3] < 128) continue;
      visible += 1;
      const luminance = 0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2];
      if (luminance > 96) light += 1;
    }
    return visible === 0 || light / visible > 0.35;
  } catch {
    return true; // can't measure (no CORS): show it
  }
}

export function TitleWordmark({ logoUrl, title, className = '', children }: {
  logoUrl?: string | null;
  title: string;
  /** Classes for the logo image (size limits per placement). */
  className?: string;
  /** The text heading, rendered when there is no usable logo. */
  children: ReactNode;
}) {
  const [state, setState] = useState<'pending' | 'shown' | 'text'>(() => {
    if (!logoUrl) return 'text';
    const known = verdicts.get(logoUrl);
    return known === undefined ? 'pending' : known ? 'shown' : 'text';
  });

  useEffect(() => {
    if (!logoUrl) { setState('text'); return; }
    const known = verdicts.get(logoUrl);
    setState(known === undefined ? 'pending' : known ? 'shown' : 'text');
  }, [logoUrl]);

  return (
    <>
      {logoUrl && state !== 'text' ? (
        <img
          key={logoUrl}
          src={logoUrl}
          alt=""
          aria-hidden="true"
          title={title}
          crossOrigin="anonymous"
          decoding="async"
          onLoad={(event) => {
            const ok = readableOnDark(event.currentTarget);
            verdicts.set(logoUrl, ok);
            setState(ok ? 'shown' : 'text');
          }}
          onError={() => { verdicts.set(logoUrl, false); setState('text'); }}
          className={`title-wordmark block h-auto w-auto object-contain object-left-bottom transition-opacity duration-300 ${state === 'shown' ? 'opacity-100' : 'opacity-0'} ${className}`}
        />
      ) : null}
      {/* The heading itself: visible text without a logo, screen-reader only with one. */}
      <div className={logoUrl && state !== 'text' ? 'sr-only' : ''}>{children}</div>
    </>
  );
}
