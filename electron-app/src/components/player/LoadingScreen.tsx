import { useEffect, useState } from 'react';
import { getPosterUrl } from '../../lib/player-utils';

type Props = {
  title: string;
  year?: number;
  posterUrl?: string | null;
  bufferPercentage: number;
  status: 'connecting' | 'buffering' | 'ready';
};

export default function LoadingScreen({ title, year, posterUrl, bufferPercentage, status }: Props) {
  const [displayPercentage, setDisplayPercentage] = useState(0);

  // Smooth percentage animation
  useEffect(() => {
    const target = Math.min(100, Math.max(0, bufferPercentage));
    const duration = 300; // ms
    const start = displayPercentage;
    const startTime = Date.now();

    const animate = () => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(1, elapsed / duration);
      const current = start + (target - start) * progress;
      setDisplayPercentage(current);

      if (progress < 1) {
        requestAnimationFrame(animate);
      } else {
        setDisplayPercentage(target);
      }
    };

    const timeout = setTimeout(() => {
      requestAnimationFrame(animate);
    }, 16);

    return () => clearTimeout(timeout);
  }, [bufferPercentage]);

  const fullPosterUrl = getPosterUrl(posterUrl, 'w780');
  const statusText = status === 'connecting' ? 'Connecting...' : status === 'buffering' ? 'Buffering...' : 'Ready';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#0a0a0a]">
      {/* Blurred poster background */}
      {fullPosterUrl && (
        <div
          className="absolute inset-0 bg-cover bg-center"
          style={{
            backgroundImage: `url(${fullPosterUrl})`,
            filter: 'blur(40px) brightness(0.18) saturate(0.7)',
            transform: 'scale(1.1)',
          }}
        />
      )}

      {/* Dark overlay */}
      <div className="absolute inset-0 bg-gradient-to-r from-[#0a0a0a]/95 via-[#0a0a0a]/70 to-[#0a0a0a]/80" />

      {/* Content */}
      <div className="relative z-10 flex w-full max-w-4xl flex-col items-center gap-8 px-8 text-center md:flex-row md:gap-14 md:text-left">
        {/* Poster */}
        {fullPosterUrl && (
          <div className="relative shrink-0 overflow-hidden rounded-lg border border-white/10 bg-[#171717]">
            <img
              src={fullPosterUrl}
              alt={title}
              className="h-[360px] w-60 object-cover"
            />
            <div className="absolute inset-x-0 bottom-0 h-1 bg-white/15">
              <div className="h-full bg-[#ff7a17] transition-all duration-300" style={{ width: `${displayPercentage}%` }} />
            </div>
          </div>
        )}

        {/* Title and year */}
        <div className="min-w-0">
          <p className="font-label text-white/65">Preparing playback</p>
          <div className="mt-5">
            <h1 className="type-page-title text-white">{title}</h1>
            {year ? <p className="type-secondary text-numeric mt-3 text-white/65">{year}</p> : null}
          </div>

          <div className="mt-8 flex items-center gap-3">
            <span className="h-1.5 w-1.5 rounded-full bg-[#ff7a17] shadow-[0_0_12px_rgba(255,122,23,.55)]" />
            <p className="font-label text-[#ffc285]">{statusText}</p>
            <span className="font-label text-numeric text-white/65">
              {Math.round(displayPercentage)}%
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
