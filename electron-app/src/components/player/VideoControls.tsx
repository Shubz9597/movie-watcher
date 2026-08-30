import { useState, useRef } from 'react';
import { ArrowLeft, Play, Pause, SkipBack, SkipForward, Volume2, VolumeX, Maximize } from 'lucide-react';
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
    <div className="pointer-events-none absolute inset-0 z-40 flex flex-col justify-between bg-[linear-gradient(180deg,rgba(0,0,0,.64),transparent_24%),linear-gradient(0deg,rgba(0,0,0,.78),transparent_30%)] p-6 transition-opacity duration-300 md:p-10">
      {/* Top bar */}
      <div className="pointer-events-auto flex items-center justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label="Stop playback and return to title"
            className="h-10 w-10 shrink-0 rounded-full border border-white/15 bg-black/20 p-0 text-white/70 hover:border-white/30 hover:bg-white/[0.06] hover:text-white"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0">
            <p className="font-label text-white/65">Now playing</p>
            <h2 className="type-panel-title mt-1 truncate text-white">{title}</h2>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={onFullscreen}
            className="h-10 w-10 rounded-full border border-white/15 bg-black/20 p-0 text-white/70 hover:border-white/30 hover:bg-white/[0.06] hover:text-white"
          >
            <Maximize className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Center play button (shown on click) */}
      <div className="pointer-events-auto flex items-center justify-center">
        <Button
          onClick={onPlayPause}
          className="h-14 w-14 rounded-full border border-white bg-white p-0 text-black hover:bg-white/85"
        >
          {paused ? <Play className="ml-1 h-8 w-8" /> : <Pause className="h-8 w-8" />}
        </Button>
      </div>

      {/* Bottom controls */}
      <div className="pointer-events-auto space-y-4">
        {/* Progress bar */}
        <div
          ref={progressBarRef}
          className="group relative h-5 w-full cursor-pointer"
          onClick={handleProgressClick}
          onMouseMove={handleProgressMouseMove}
          onMouseLeave={() => setHoverTime(null)}
        >
          <div
            className="absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-[#ff7a17] transition-all duration-100 before:absolute before:left-full before:top-1/2 before:h-3 before:w-3 before:-translate-x-1/2 before:-translate-y-1/2 before:rounded-full before:bg-white before:opacity-0 before:transition group-hover:before:opacity-100"
            style={{ width: `${progress}%` }}
          />
          <div className="absolute inset-x-0 top-1/2 -z-10 h-1 -translate-y-1/2 rounded-full bg-white/20" />
        </div>

        {/* Control buttons */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={onPlayPause}
              className="h-11 w-11 rounded-full bg-white p-0 text-black hover:bg-white/85"
            >
              {paused ? <Play className="ml-0.5 h-5 w-5" /> : <Pause className="h-5 w-5" />}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onSeek(-10, true)}
              className="h-10 w-10 rounded-full border border-transparent bg-transparent p-0 text-white/70 hover:border-white/20 hover:bg-white/[0.05] hover:text-white"
            >
              <SkipBack className="h-5 w-5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onSeek(10, true)}
              className="h-10 w-10 rounded-full border border-transparent bg-transparent p-0 text-white/70 hover:border-white/20 hover:bg-white/[0.05] hover:text-white"
            >
              <SkipForward className="h-5 w-5" />
            </Button>
            <div className="font-label text-numeric ml-2 text-white/65">
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
                className="h-10 w-10 rounded-full border border-transparent bg-transparent p-0 text-white/70 hover:border-white/20 hover:bg-white/[0.05] hover:text-white"
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
