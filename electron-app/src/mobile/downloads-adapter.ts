// C-stage native downloads adapter (offline-downloads plan "Migration,
// release and rollback": ship C independently with a downloads adapter
// reporting unavailable until native D exists).
//
// D03/D05 replace inventory() with the real on-device manifest reader and add
// command operations (enqueue/pause/resume/retry/cancel/remove/open) behind
// the finalized D01 contracts. Until then this adapter keeps the mobile entry
// wired so the D milestone flips availability without entry changes, and
// production clients keep the current three-tab navigation.
import type { DownloadsInventory, DownloadsPort } from '../platform/contracts.ts';

export class NativeDownloadsAdapter implements DownloadsPort {
  async inventory(): Promise<DownloadsInventory> {
    // Native downloads capability is not implemented yet: unavailable, zero
    // items, no storage error (there is no inventory store to fail reading).
    return { available: false, unreadable: false, items: [] };
  }
}
