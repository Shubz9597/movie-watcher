// ConnectionChip (M1.4 UI pass): a small status indicator for the compact
// (mobile) header. Shows a colored dot + the connected server's hostname;
// tapping it opens a small panel with the full origin, the reachability
// state, and a shortcut into Server Settings.
import * as React from 'react';
import { ChevronDown } from 'lucide-react';
import { useConnectionStatus } from '../../platform/PlatformProvider';
import { FOCUS_RING_CLASS } from '../../lib/design-tokens';

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
        aria-label={`Connection: ${STATUS_LABEL[status]} ${host}. Open details`}
        className={`flex min-h-9 max-w-[9.5rem] items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.04] py-1 pl-2.5 pr-2 transition hover:bg-white/[0.08] ${FOCUS_RING_CLASS}`}
      >
        <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${DOT_COLOR[status]} ${status === 'checking' ? 'animate-pulse' : ''}`} />
        <span className="truncate text-xs text-white/75">{host}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-white/50" aria-hidden="true" />
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
            className="absolute left-0 top-[calc(100%+8px)] z-50 w-72 rounded-xl border border-white/10 bg-[#151619] p-4 shadow-xl"
          >
            <div className="flex items-center gap-2">
              <span aria-hidden="true" className={`h-2.5 w-2.5 rounded-full ${DOT_COLOR[status]}`} />
              <p className="text-sm font-medium text-white">{STATUS_LABEL[status]}</p>
            </div>
            <p className="mt-2 break-all text-xs leading-5 text-white/60">
              {compat.origin ? compat.origin : 'No server address configured yet.'}
            </p>
            {status === 'incompatible' ? (
              <p className="mt-2 text-xs leading-5 text-[#ffc285]">
                This server runs an incompatible TorWatch version. Update the server.
              </p>
            ) : null}
            {status === 'unreachable' ? (
              <p className="mt-2 text-xs leading-5 text-white/50">
                Check that the server is running, the address is correct, and both
                devices are on the same network.
              </p>
            ) : null}
            <button
              type="button"
              onClick={() => {
                setPanelOpen(false);
                onOpenSettings();
              }}
              className={`mt-3 flex min-h-11 w-full items-center justify-center rounded-full border border-white/20 text-sm text-white/85 transition hover:border-white/40 ${FOCUS_RING_CLASS}`}
            >
              Server settings
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
