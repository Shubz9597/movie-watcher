import { useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { ChevronDown, MonitorPlay, Play } from 'lucide-react';
import { Button } from './ui/button';
import { cn } from '../lib/utils';

type Props = {
  onPlay: () => void;
  playBusy?: boolean;
  externalBusy?: boolean;
  disabled?: boolean;
  onOpenExternal?: () => void;
  externalHref?: string;
  externalDownload?: boolean;
  className?: string;
};

export default function PlaybackSplitButton({
  onPlay,
  playBusy = false,
  externalBusy = false,
  disabled = false,
  onOpenExternal,
  externalHref,
  externalDownload = false,
  className,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const isBusy = playBusy || externalBusy;
  const isDisabled = disabled || isBusy;

  const closeMenu = () => setMenuOpen(false);
  const menuItemClassName = cn(
    'flex min-h-11 w-full items-center gap-3 rounded-md px-3 py-2 text-left text-white/85 outline-none',
    'transition-colors hover:bg-white/[0.08] focus-visible:bg-white/[0.08] focus-visible:ring-2 focus-visible:ring-white/50',
    isDisabled && 'pointer-events-none opacity-50'
  );

  const menuItemContent = (
    <>
      <MonitorPlay className="h-4 w-4 shrink-0 text-white/65" />
      <span className="min-w-0">
        <span className="block text-sm font-medium">
          {externalBusy ? 'Preparing playlist…' : 'Open in external player'}
        </span>
        <span className="type-caption mt-0.5 block text-white/55">Downloads an M3U playlist</span>
      </span>
    </>
  );

  return (
    <div className={cn('inline-flex min-w-0', className)}>
      <Button
        type="button"
        size="sm"
        onClick={onPlay}
        disabled={isDisabled}
        className="min-h-11 min-w-0 flex-1 rounded-r-none rounded-l-full bg-white px-4 text-black hover:bg-white/85 focus-visible:z-10"
      >
        <Play className="h-3.5 w-3.5 fill-current" />
        {playBusy ? 'Opening…' : 'Play'}
      </Button>

      <Popover.Root open={menuOpen} onOpenChange={setMenuOpen}>
        <Popover.Trigger asChild>
          <Button
            type="button"
            size="sm"
            disabled={isDisabled}
            aria-label="More playback options"
            aria-expanded={menuOpen}
            className="min-h-11 w-11 rounded-l-none rounded-r-full border-l border-black/20 bg-white px-0 text-black hover:bg-white/85 focus-visible:z-10"
          >
            <ChevronDown className="h-4 w-4" aria-hidden="true" />
          </Button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            side="bottom"
            align="end"
            sideOffset={8}
            collisionPadding={12}
            className="z-50 w-64 rounded-lg border border-white/[0.12] bg-[#151515] p-1.5 text-white outline-none"
          >
            {externalHref ? (
              <a
                className={menuItemClassName}
                href={externalHref}
                download={externalDownload || undefined}
                onClick={closeMenu}
                aria-disabled={isDisabled}
              >
                {menuItemContent}
              </a>
            ) : (
              <button
                type="button"
                className={menuItemClassName}
                onClick={() => {
                  closeMenu();
                  onOpenExternal?.();
                }}
                disabled={isDisabled}
              >
                {menuItemContent}
              </button>
            )}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
