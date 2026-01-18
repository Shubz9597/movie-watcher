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

  // Calculate stroke-dasharray for progress ring
  const radius = 40;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (displayPercentage / 100) * circumference;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#0a0a0a]">
      {/* Blurred poster background */}
      {fullPosterUrl && (
        <div
          className="absolute inset-0 bg-cover bg-center"
          style={{
            backgroundImage: `url(${fullPosterUrl})`,
            filter: 'blur(40px) brightness(0.3)',
            transform: 'scale(1.1)', // Slight zoom to avoid edges
          }}
        />
      )}

      {/* Dark overlay */}
      <div className="absolute inset-0 bg-black/60" />

      {/* Content */}
      <div className="relative z-10 flex flex-col items-center gap-8 text-center">
        {/* Poster */}
        {fullPosterUrl && (
          <div className="relative">
            <img
              src={fullPosterUrl}
              alt={title}
              className="h-64 w-44 rounded-lg object-cover shadow-2xl"
            />
            {/* Progress ring overlay */}
            <svg
              className="absolute inset-0 -rotate-90"
              width="176"
              height="256"
              viewBox="0 0 176 256"
            >
              <circle
                cx="88"
                cy="128"
                r={radius}
                fill="none"
                stroke="rgba(255,255,255,0.1)"
                strokeWidth="3"
              />
              <circle
                cx="88"
                cy="128"
                r={radius}
                fill="none"
                stroke="#06b6d4"
                strokeWidth="3"
                strokeDasharray={circumference}
                strokeDashoffset={offset}
                strokeLinecap="round"
                className="transition-all duration-300"
              />
            </svg>
          </div>
        )}

        {/* Title and year */}
        <div className="space-y-2">
          <h1 className="text-3xl font-bold text-white">{title}</h1>
          {year && <p className="text-lg text-slate-400">{year}</p>}
        </div>

        {/* Status and percentage */}
        <div className="space-y-3">
          <p className="text-sm font-medium text-slate-300">{statusText}</p>
          <div className="flex items-center gap-2">
            <div className="h-1 w-32 overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full bg-cyan-500 transition-all duration-300"
                style={{ width: `${displayPercentage}%` }}
              />
            </div>
            <span className="text-sm font-mono text-cyan-400 tabular-nums">
              {Math.round(displayPercentage)}%
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
