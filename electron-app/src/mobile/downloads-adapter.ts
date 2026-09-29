// Native downloads adapter (offline-downloads D03/D05). The C-stage stub
// reported unavailable; this version speaks to TorWatchDownloadsPlugin when
// the native bridge exists.
//
// PRODUCTION GATE (D05): the Downloads destination and the enqueue flow
// connect in D05. Until then DOWNLOADS_UI_ENABLED stays false — the adapter
// resolves truthful data but reports `available: false`, so production
// clients keep the three-tab navigation and no empty scaffolding ships
// (constitution: partial implementations stay isolated). D05 flips this one
// constant and adds the WF04 enqueue sheet.
import { registerPlugin } from '@capacitor/core';
import type { DownloadsInventory, DownloadsPort } from '../platform/contracts.ts';
import type { TorWatchDownloadsPluginInterface } from '../platform/native-downloads.ts';

export const DOWNLOADS_UI_ENABLED = false;

let plugin: TorWatchDownloadsPluginInterface | null = null;

// Same explicit detection as native-player.ts — never guessed from user agents.
function isNativeCapacitor(): boolean {
  const capacitor = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return typeof capacitor?.isNativePlatform === 'function' && capacitor.isNativePlatform() === true;
}

function getPlugin(): TorWatchDownloadsPluginInterface | null {
  if (!isNativeCapacitor()) return null;
  if (!plugin) {
    plugin = registerPlugin<TorWatchDownloadsPluginInterface>('TorWatchDownloads');
  }
  return plugin;
}

export class NativeDownloadsAdapter implements DownloadsPort {
  async inventory(): Promise<DownloadsInventory> {
    const native = getPlugin();
    if (!native) {
      return { available: false, unreadable: false, items: [] };
    }
    try {
      const { items } = await native.list();
      return {
        // D05 flips DOWNLOADS_UI_ENABLED together with the enqueue sheet.
        available: DOWNLOADS_UI_ENABLED,
        unreadable: false,
        items: items.map((item) => ({
          downloadId: item.downloadId,
          title: item.title,
          subtitle: [item.subtitleLabel, item.season > 0 ? `S${item.season} E${item.episode}` : null]
            .filter(Boolean)
            .join(' · '),
          state: item.state === 'ready' ? 'ready' : 'needs-repair',
          sizeBytes: item.totalBytes > 0 ? item.totalBytes : undefined,
          waitingForServer: item.state === 'queued' || item.state === 'downloading' || item.state === 'paused',
        })),
      };
    } catch (error) {
      // A failed inventory read is a storage error — never "zero downloads"
      // (spec C2). The Downloads surface renders its repair/retry state.
      console.error('[Downloads/Native] inventory read failed:', error);
      return { available: DOWNLOADS_UI_ENABLED, unreadable: true, items: [] };
    }
  }
}

/** D03 device-test access to the raw native bridge (test hooks only; the
 *  production enqueue UI arrives with D05). Null outside native Capacitor. */
export function getNativeDownloads(): TorWatchDownloadsPluginInterface | null {
  return getPlugin();
}
