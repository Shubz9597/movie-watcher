// ConnectionChip (M1.4 UI pass): a small status indicator for the compact
// (mobile) header. Shows a colored dot + the connected server's hostname;
// tapping it opens a small panel with the full origin, the reachability
// state, and a shortcut into Server Settings.
import * as React from 'react';
import { useConnectionStatus } from '../../platform/PlatformProvider';
import { ACTION_SECONDARY_CLASS, FOCUS_RING_CLASS } from '../../lib/design-tokens';

type ConnectionStatusChip = 'checking' | 'ready' | 'unreachable' | 'incompatible';

const DOT_COLOR: Record<ConnectionStatusChip, string> = {
  checking: 'bg-white/40',
  ready: 'bg-emerald-400',
  unreachable: 'bg-red-400',
  incompatible: 'bg-[#ffc285]',
};

const STATUS_LABEL: Record<ConnectionStatusChip, string> = {
  checking: 'Checking server…',
  ready: 'Connected',
  unreachable: 'Not connected',
  incompatible: 'Server incompatible',
};

function hostOf(origin: string | undefined): string {
  if (!origin) return 'not set';
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

export function ConnectionChip({ onOpenSettings }: { onOpenSettings: () => void }) {
  const compat = useConnectionStatus();
  const [panelOpen, setPanelOpen] = React.useState(false);

  const status = compat.status as ConnectionStatusChip;
  const host = hostOf(compat.origin);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setPanelOpen((open) => !open)}
        aria-expanded={panelOpen}
        aria-label={`Connection: ${STATUS_LABEL[status]}, ${host}`}
        className={`-mx-2 inline-flex h-12 w-12 items-center justify-center rounded-lg transition hover:bg-white/[0.08] ${FOCUS_RING_CLASS}`}
      >
        {/* Dot-only (M1.4 UI pass): green = connected, red = not connected.
            Server details are in the tap-through panel. */}
        <span
          aria-hidden="true"
          className={`h-2.5 w-2.5 rounded-full ${DOT_COLOR[status]} ${status === 'checking' ? 'animate-pulse' : ''}`}
        />
      </button>

      {panelOpen ? (
        <>
          {/* Dismiss layer: tap anywhere else to close. */}
          <button
            type="button"
            aria-label="Close connection details"
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setPanelOpen(false)}
          />
          <div
            role="dialog"
            aria-label="Connection details"
            className="absolute left-0 top-[calc(100%+4px)] z-50 w-72 rounded-lg border border-white/10 bg-[var(--surface-raised)] p-4 shadow-xl"
          >
            <div className="flex items-center gap-2">
              <span aria-hidden="true" className={`h-2.5 w-2.5 rounded-full ${DOT_COLOR[status]}`} />
              <p className="text-sm font-medium text-white">{STATUS_LABEL[status]}</p>
            </div>
            <p className="type-secondary mt-2 break-all text-white/70">
              {compat.origin ? compat.origin : 'No server set'}
            </p>
            {status === 'incompatible' ? <p className="type-secondary mt-2 text-[#ffc285]">Server update needed</p> : null}
            <button
              type="button"
              onClick={() => {
                setPanelOpen(false);
                onOpenSettings();
              }}
              className={`mt-3 w-full ${ACTION_SECONDARY_CLASS}`}
            >
              Server settings
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
