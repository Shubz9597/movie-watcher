/**
 * Player utility functions for time formatting and buffer calculations
 */

export function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const sec = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }
  return `${m}:${String(sec).padStart(2, '0')}`;
}

export function formatTimeWithHours(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0:00:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const sec = Math.floor(seconds % 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

export function calculateBufferPercentage(
  contiguousAhead: number,
  targetBytes: number,
  fileLength: number
): number {
  if (!targetBytes || targetBytes <= 0) return 0;
  if (!fileLength || fileLength <= 0) return 0;
  
  // Calculate percentage based on how much we've buffered vs target
  const buffered = Math.min(contiguousAhead, targetBytes);
  const percentage = (buffered / targetBytes) * 100;
  return Math.min(100, Math.max(0, percentage));
}

export function getPosterUrl(posterPath: string | null | undefined, size: 'w342' | 'w500' | 'w780' | 'original' = 'w500'): string | null {
  if (!posterPath) return null;
  if (posterPath.startsWith('http://') || posterPath.startsWith('https://')) {
    return posterPath;
  }
  return `https://image.tmdb.org/t/p/${size}${posterPath}`;
}
