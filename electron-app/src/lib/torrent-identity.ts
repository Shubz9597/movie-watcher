import type { SavedResumeSource, TorrentRow } from './types';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function base32ToHex(value: string) {
  let accumulator = 0;
  let bitCount = 0;
  const bytes: number[] = [];

  for (const character of value.toUpperCase()) {
    const digit = BASE32_ALPHABET.indexOf(character);
    if (digit < 0) return '';
    accumulator = (accumulator << 5) | digit;
    bitCount += 5;
    if (bitCount >= 8) {
      bitCount -= 8;
      bytes.push((accumulator >> bitCount) & 0xff);
      accumulator &= bitCount > 0 ? (1 << bitCount) - 1 : 0;
    }
  }

  return bytes.length === 20
    ? bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('')
    : '';
}

/** Returns a canonical v1 info hash for a raw hash or magnet URI. */
export function torrentInfoHash(value?: string | null) {
  if (!value) return '';
  const decoded = safeDecode(value.trim());
  const magnetMatch = decoded.match(/urn:btih:([^&]+)/i);
  const candidate = safeDecode(magnetMatch?.[1] || decoded).trim();

  if (/^[a-f0-9]{40}$/i.test(candidate)) return candidate.toLowerCase();
  if (/^[a-z2-7]{32}$/i.test(candidate)) return base32ToHex(candidate);
  return '';
}

export function sameTorrent(left?: string | null, right?: string | null) {
  const leftHash = torrentInfoHash(left);
  const rightHash = torrentInfoHash(right);
  return Boolean(leftHash && rightHash && leftHash === rightHash);
}

/** Promotes a prior source, or restores its saved magnet when indexers no longer return it. */
export function prioritizePreviouslyUsedTorrent(
  rows: TorrentRow[],
  source?: SavedResumeSource | null,
): TorrentRow[] {
  if (!source) return rows;
  const savedHash = torrentInfoHash(source.sourceUri);
  const matchIndex = savedHash
    ? rows.findIndex((row) => {
        const rowHash = torrentInfoHash(row.infoHash) || torrentInfoHash(row.magnetUri);
        return rowHash === savedHash;
      })
    : -1;
  if (matchIndex >= 0) {
    const exactMatch: TorrentRow = {
      ...rows[matchIndex],
      fileIndex: source.fileIndex ?? rows[matchIndex].fileIndex,
      previouslyUsed: true,
    };
    return [exactMatch, ...rows.filter((_, index) => index !== matchIndex)];
  }

  const sourceURI = source.sourceUri.trim();
  if (!sourceURI.toLowerCase().startsWith('magnet:?')) return rows;
  return [{
    title: source.sourceName || 'Previously used source',
    indexer: 'History',
    magnetUri: sourceURI,
    infoHash: savedHash || undefined,
    fileIndex: source.fileIndex,
    previouslyUsed: true,
  }, ...rows];
}
