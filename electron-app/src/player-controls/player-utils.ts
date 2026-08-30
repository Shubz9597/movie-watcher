export function formatTime(seconds: number) {
  const safeSeconds = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const secs = Math.floor(safeSeconds % 60);
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function episodeCodeFromIdentity(season?: number, episode?: number) {
  if (!Number.isInteger(season) || !Number.isInteger(episode) || Number(season) < 0 || Number(episode) < 0) return '';
  return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
}

export function skipSegmentsFromPayload(value: unknown) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && Array.isArray((value as { segments?: unknown }).segments)) {
    return (value as { segments: unknown[] }).segments;
  }
  return [];
}
