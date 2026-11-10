// What a linked Stremio account's status means for the viewer
// (lib/services/stremio-service.ts, Settings).

export type StremioAccount = {
  email: string;
  linkedAt: string;
  lastSyncAt: string | null;
  lastError: string;
  /** Positions brought in from Stremio in total. */
  imported: number;
};

/** The server's error when Stremio ended its session (link again). */
export const STREMIO_SESSION_ENDED = 'stremio session ended';

/** What the account's last sync means for the viewer. */
export function stremioSyncNote(account: StremioAccount, now = Date.now()): { text: string; problem: boolean } {
  if (account.lastError === STREMIO_SESSION_ENDED) {
    return { text: 'Stremio signed TorWatch out. Link it again.', problem: true };
  }
  if (account.lastError) {
    return { text: 'Couldn’t reach Stremio on the last try. It tries again every few minutes.', problem: true };
  }
  if (!account.lastSyncAt) return { text: 'Not synced yet', problem: false };
  const minutes = Math.max(0, Math.round((now - Date.parse(account.lastSyncAt)) / 60_000));
  const when = minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
  const count = account.imported === 1 ? '1 update brought in' : `${account.imported} updates brought in`;
  return { text: `Synced ${when} · ${count}`, problem: false };
}
