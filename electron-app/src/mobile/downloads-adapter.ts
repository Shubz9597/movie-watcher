// Native downloads adapter (offline-downloads D03/D05). The C-stage stub
// reported unavailable; this version speaks to TorWatchDownloadsPlugin when
// the native bridge exists.
//
// D05 production gate: the Downloads destination is exposed only when the
// native bridge exists. Source actions enqueue through download-queue.ts.
import { registerPlugin } from '@capacitor/core';
import type { DownloadsInventory, DownloadsPort } from '../platform/contracts.ts';
import type { TorWatchDownloadsPluginInterface } from '../platform/native-downloads.ts';

export const DOWNLOADS_UI_ENABLED = true;

let plugin: TorWatchDownloadsPluginInterface | null = null;

// Same explicit detection as native-player.ts — never guessed from user
// agents. The implementation check avoids offering downloads in an older
// native shell that does not contain the plugin yet.
function isNativeDownloadsAvailable(): boolean {
  const capacitor = (window as unknown as {
    Capacitor?: {
      isNativePlatform?: () => boolean;
      isPluginAvailable?: (name: string) => boolean;
    };
  }).Capacitor;
  return typeof capacitor?.isNativePlatform === 'function'
    && capacitor.isNativePlatform() === true
    && typeof capacitor.isPluginAvailable === 'function'
    && capacitor.isPluginAvailable('TorWatchDownloads') === true;
}

function getPlugin(): TorWatchDownloadsPluginInterface | null {
  if (!isNativeDownloadsAvailable()) return null;
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

/** Access to the raw native bridge. Null outside native Capacitor. */
export function getNativeDownloads(): TorWatchDownloadsPluginInterface | null {
  return getPlugin();
}
