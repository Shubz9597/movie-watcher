// DownloadsPage (offline-downloads C04/WF06): the direct route to local
// media, usable with or without a server connection. There is NO global
// server-warning banner here: ready files show ordinary local actions,
// interrupted items show their own short "Waiting for server" state, and a
// failed inventory read surfaces a storage error — never a false "no
// downloads". Local playback actions arrive with milestone D; the C release
// keeps unfinished paths disabled (production adapters report unavailable),
// so this page is reachable with items only via explicit fixture previews.
import { useEffect, useState } from 'react';
import { useConnectionStatus, usePlatform } from '../platform/PlatformProvider';
import type { DownloadsInventory } from '../platform/contracts';
import { FOCUS_RING_CLASS } from '../lib/design-tokens';
type DownloadsPageProps = {
  navigate: (path: string, params?: Record<string, string>) => void;
};

const EMPTY_INVENTORY: DownloadsInventory = { available: false, unreadable: false, items: [] };

function formatSize(bytes?: number): string | null {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return null;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

export default function DownloadsPage({ navigate }: DownloadsPageProps) {
  const { downloads } = usePlatform();
  const onOpenSettings = () => window.dispatchEvent(new CustomEvent('torwatch:open-settings'));
  const compat = useConnectionStatus();
  const [inventory, setInventory] = useState<DownloadsInventory | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    const load = async (): Promise<void> => {
      try {
        const snapshot = downloads ? await downloads.inventory() : EMPTY_INVENTORY;
        if (active) setInventory(snapshot);
      } catch (error) {
        console.error('[Downloads] Inventory read failed:', error);
        // A failed read must never read as zero downloads (spec C2).
        if (active) setInventory({ ...(downloads ? { available: true } : { available: false }), unreadable: true, items: [] });
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [downloads, reloadKey]);

  const online = compat.status === 'ready';

  return (
    <section className="mx-auto max-w-[1600px] px-5 py-6 md:px-8">
      <h1 className="type-section-title text-white">Downloads</h1>

      {loading ? (
        <div className="mt-6 space-y-3" role="status" aria-label="Loading downloads">
          {[0, 1].map((row) => (
            <div key={row} className="h-16 animate-pulse rounded-xl bg-white/[0.06]" />
          ))}
        </div>
      ) : inventory?.unreadable ? (
        // Storage failure: repair/retry, never an empty state (wireframes
        // "Downloads storage failure").
        <div className="mt-6 rounded-xl border border-white/10 bg-[#151619] p-5">
          <p className="text-sm text-white">Couldn-t read your downloads</p>
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => setReloadKey((key) => key + 1)}
              className={`min-h-12 rounded-full bg-white px-5 py-2.5 text-sm text-black transition hover:bg-white/85 ${FOCUS_RING_CLASS}`}
            >
              Retry
            </button>
            <button
              type="button"
              onClick={onOpenSettings}
              className={`min-h-12 rounded-full border border-white/20 px-5 py-2.5 text-sm text-white transition hover:bg-white/10 ${FOCUS_RING_CLASS}`}
            >
              Storage settings
            </button>
          </div>
        </div>
      ) : !inventory || inventory.items.length === 0 ? (
        // Empty: concise, no travel/setup explanation paragraph. The online
        // action finds something; the offline action goes to settings.
        <div className="mt-6 rounded-xl border border-white/10 bg-[#151619] p-5">
          <p className="text-sm text-white">No downloads yet</p>
          <div className="mt-4 flex flex-wrap gap-3">
            {online ? (
              <button
                type="button"
                onClick={() => navigate('search')}
                className={`min-h-12 rounded-full bg-white px-5 py-2.5 text-sm text-black transition hover:bg-white/85 ${FOCUS_RING_CLASS}`}
              >
                Find something
              </button>
            ) : null}
            <button
              type="button"
              onClick={onOpenSettings}
              className={`min-h-12 rounded-full border border-white/20 px-5 py-2.5 text-sm text-white transition hover:bg-white/10 ${FOCUS_RING_CLASS}`}
            >
              Go to settings
            </button>
          </div>
        </div>
      ) : (
        <ul className="mt-6 space-y-3">
          {inventory.items.map((item) => {
            const size = formatSize(item.sizeBytes);
            return (
              <li
                key={item.downloadId}
                className="flex items-center justify-between gap-4 rounded-xl border border-white/10 bg-[#151619] px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm text-white">{item.title}</p>
                  <p className="mt-0.5 truncate text-xs text-white/55">
                    {[item.subtitle, size].filter(Boolean).join(' · ')}
                    {item.state === 'needs-repair' ? ' · Needs repair' : ''}
                  </p>
                </div>
                {item.state === 'needs-repair' ? (
                  <span className="min-h-11 shrink-0 rounded-full border border-white/15 px-4 py-2.5 text-xs text-white/60">
                    Needs repair
                  </span>
                ) : item.waitingForServer ? (
                  <span className="min-h-11 shrink-0 rounded-full border border-white/15 px-4 py-2.5 text-xs text-white/60">
                    Waiting for server
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
