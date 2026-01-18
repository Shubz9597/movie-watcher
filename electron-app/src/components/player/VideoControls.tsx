import { useEffect, useState, useRef } from 'react';
import { Play, Pause, SkipBack, SkipForward, Volume2, VolumeX, Maximize, X, Settings } from 'lucide-react';
import { formatTime } from '../../lib/player-utils';
import { Button } from '../ui/button';

type Props = {
  title: string;
  time: number;
  duration: number;
  paused: boolean;
  volume: number;
  muted: boolean;
  onPlayPause: () => void;
  onSeek: (seconds: number, relative: boolean) => void;
  onVolumeChange: (volume: number) => void;
  onMuteToggle: () => void;
  onFullscreen: () => void;
  onClose: () => void;
  visible: boolean;
};

export default function VideoControls({
  title,
  time,
  duration,
  paused,
  volume,
  muted,
  onPlayPause,
  onSeek,
  onVolumeChange,
  onMuteToggle,
  onFullscreen,
  onClose,
  visible,
}: Props) {
  const [isDragging, setIsDragging] = useState(false);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const progressBarRef = useRef<HTMLDivElement>(null);
  const volumeBarRef = useRef<HTMLDivElement>(null);

  const progress = duration > 0 ? (time / duration) * 100 : 0;
  const displayTime = hoverTime !== null ? hoverTime : time;

  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!progressBarRef.current || duration === 0) return;
    const rect = progressBarRef.current.getBoundingClientRect();
    const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const targetTime = percent * duration;
    onSeek(targetTime, false);
  };

  const handleVolumeClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!volumeBarRef.current) return;
    const rect = volumeBarRef.current.getBoundingClientRect();
    const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    onVolumeChange(percent);
  };

  const handleProgressMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!progressBarRef.current || duration === 0) return;
    const rect = progressBarRef.current.getBoundingClientRect();
    const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    setHoverTime(percent * duration);
  };

  if (!visible) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-40 flex flex-col justify-between bg-gradient-to-t from-black/80 via-black/40 to-transparent p-6 transition-opacity duration-300">
      {/* Top bar */}
      <div className="pointer-events-auto flex items-center justify-between">
        <h2 className="truncate text-lg font-semibold text-white">{title}</h2>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={onFullscreen}
            className="h-9 w-9 rounded-full border-white/20 bg-white/10 p-0 text-white hover:bg-white/20"
          >
            <Maximize className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="h-9 w-9 rounded-full border-white/20 bg-white/10 p-0 text-white hover:bg-white/20"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Center play button (shown on click) */}
      <div className="pointer-events-auto flex items-center justify-center">
        <Button
          onClick={onPlayPause}
          className="h-16 w-16 rounded-full border-2 border-white/30 bg-white/10 p-0 text-white backdrop-blur-sm hover:bg-white/20"
        >
          {paused ? <Play className="ml-1 h-8 w-8" /> : <Pause className="h-8 w-8" />}
        </Button>
      </div>

      {/* Bottom controls */}
      <div className="pointer-events-auto space-y-4">
        {/* Progress bar */}
        <div
          ref={progressBarRef}
          className="group relative h-2 w-full cursor-pointer rounded-full bg-white/20"
          onClick={handleProgressClick}
          onMouseMove={handleProgressMouseMove}
          onMouseLeave={() => setHoverTime(null)}
        >
          <div
            className="absolute left-0 top-0 h-full rounded-full bg-cyan-500 transition-all duration-100"
            style={{ width: `${progress}%` }}
          />
          <div
            className="absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full bg-white opacity-0 shadow-lg transition-opacity group-hover:opacity-100"
            style={{ left: `calc(${progress}% - 6px)` }}
          />
        </div>

        {/* Control buttons */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={onPlayPause}
              className="h-10 w-10 rounded-full border-white/20 bg-white/10 p-0 text-white hover:bg-white/20"
            >
              {paused ? <Play className="ml-0.5 h-5 w-5" /> : <Pause className="h-5 w-5" />}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onSeek(-10, true)}
              className="h-10 w-10 rounded-full border-white/20 bg-white/10 p-0 text-white hover:bg-white/20"
            >
              <SkipBack className="h-5 w-5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onSeek(10, true)}
              className="h-10 w-10 rounded-full border-white/20 bg-white/10 p-0 text-white hover:bg-white/20"
            >
              <SkipForward className="h-5 w-5" />
            </Button>
            <div className="ml-2 font-mono text-sm text-white tabular-nums">
              {formatTime(displayTime)} / {formatTime(duration)}
            </div>
          </div>

          <div className="flex items-center gap-4">
            {/* Volume control */}
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={onMuteToggle}
                className="h-10 w-10 rounded-full border-white/20 bg-white/10 p-0 text-white hover:bg-white/20"
              >
                {muted ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
              </Button>
              <div
                ref={volumeBarRef}
                className="h-1 w-24 cursor-pointer rounded-full bg-white/20"
                onClick={handleVolumeClick}
              >
                <div
                  className="h-full rounded-full bg-white transition-all duration-100"
                  style={{ width: `${muted ? 0 : volume * 100}%` }}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
