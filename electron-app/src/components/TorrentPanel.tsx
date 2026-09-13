// Electron-compatible wrapper for TorrentPanel that fixes API calls
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from '../lib/router-adapter';
import { Button } from './ui/button';
import { Loader2, Play, RotateCcw } from 'lucide-react';
import PlaybackSplitButton from './PlaybackSplitButton';
import { getVodBase } from '../lib/api-client';
import { resolveTorrentSource, searchMovieTorrents, searchAnimeTorrents } from '../lib/services/torrent-search-service';
import { getSavedResumeSource } from '../lib/services/continue-service';
import type { ResumeSourceContext, SavedResumeSource, TorrentRow } from '../lib/types';
import { prioritizePreviouslyUsedTorrent, torrentInfoHash } from '../lib/torrent-identity';
import { getDeviceId } from '../lib/device-id';
import { usePlatform } from '../platform/PlatformProvider';
import { FOCUS_RING_CLASS } from '../lib/design-tokens';

type Props = {
  title: string;
  year?: number;
  imdbId?: string;
  originalLanguage?: string;
  kind?: 'movie' | 'anime';
  anilistId?: number;
  tmdbId?: number;
  titleAliases?: string[];
  resumeContext?: ResumeSourceContext | null;
  resumeSource?: SavedResumeSource | null;
};

type TorrentApiItem = {
  title: string;
  size?: number;
  sizeBytes?: number;
  seeders?: number;
  leechers?: number;
  magnetUri?: string;
  magnet?: string;
  sourceId?: string;
  torrentUrl?: string;
  downloadUrl?: string;
  infoHash?: string;
  indexer?: string;
  publishDate?: string;
};

const formatBytes = (value?: number) => {
  if (!value || value <= 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let idx = 0;
  while (size >= 1024 && idx < units.length - 1) {
    size /= 1024;
    idx += 1;
  }
  return `${size.toFixed(2)} ${units[idx]}`;
};

const formatDate = (iso?: string) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};

function qualityFromTitle(title: string) {
  const lower = title.toLowerCase();
  if (lower.includes('2160p') || /\b4k\b/i.test(title)) return '2160p';
  if (lower.includes('1080p')) return '1080p';
  if (lower.includes('720p')) return '720p';
  return null;
}

// The backend origin is read per call so runtime origin switches apply.
async function downloadM3U(magnet: string, displayTitle: string, cat: string, seriesId?: string, imdbId?: string) {
  const VOD_BASE = getVodBase();
  const params = new URLSearchParams();
  params.set('cat', cat);
  params.set('magnet', magnet);
  if (seriesId) params.set('seriesId', seriesId);
  params.set('subjectId', getDeviceId());
  params.set('trackProgress', '1');

  const streamUrl = `${VOD_BASE}/stream?${params.toString()}`;
  const safeFilename = displayTitle.replace(/[<>:"/\\|?*]/g, '_');

  let subtitleUrl: string | undefined;
  try {
    const subParams = new URLSearchParams({ cat, magnet });
    if (imdbId) subParams.set('imdbId', imdbId);
    subParams.set('langs', 'en');
    const res = await fetch(`${VOD_BASE}/subtitles/list?${subParams.toString()}`);
    if (res.ok) {
      const data = await res.json();
      const torrentSub = data.torrent?.[0];
      const externalSub = data.external?.[0];
      if (torrentSub) {
        subtitleUrl = `${VOD_BASE}/subtitles/torrent?magnet=${encodeURIComponent(magnet)}&cat=${cat}&fileIndex=${torrentSub.index}`;
      } else if (externalSub) {
        subtitleUrl = `${VOD_BASE}${externalSub.url}`;
      }
    }
  } catch {}

  let m3uContent = `#EXTM3U\n#EXTINF:-1,${displayTitle}\n`;
  if (subtitleUrl) {
    m3uContent += `#EXTVLCOPT:input-slave=${subtitleUrl}\n`;
    m3uContent += `#EXTVLCOPT:sub-track=0\n`;
  }
  m3uContent += `${streamUrl}\n`;

  const blob = new Blob([m3uContent], { type: 'audio/x-mpegurl' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safeFilename}.m3u`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function TorrentPanel({
  title,
  year,
  imdbId,
  originalLanguage,
  kind = 'movie',
  anilistId,
  tmdbId,
  titleAliases,
  resumeContext,
  resumeSource,
}: Props) {
  const router = useRouter();
  const platform = usePlatform();
  const isElectron = platform.kind === 'electron';
  const [torrents, setTorrents] = useState<TorrentRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastFetched, setLastFetched] = useState<number | null>(null);
  const [busyActionId, setBusyActionId] = useState<string | null>(null);
  const [historySource, setHistorySource] = useState<SavedResumeSource | null>(null);
  // WF06: selection is a distinct step — selecting a row never plays.
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null);
  // WF06a: one details disclosure open at a time; refs keep per-row toggles
  // so confirming details can return focus to the list.
  const [detailsOpenKey, setDetailsOpenKey] = useState<string | null>(null);
  const detailsButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const refreshInFlight = useRef(false);
  const actionInFlight = useRef(false);

  const canSearch = title.length > 0;
  const isAnime = kind === 'anime';
  const defaultSeriesId = anilistId
    ? `anilist:${anilistId}`
    : tmdbId
      ? `tmdb:movie:${tmdbId}`
      : '';
  const preferredSourceContext = resumeContext || (defaultSeriesId
    ? { subjectId: getDeviceId(), seriesId: defaultSeriesId, season: 0, episode: 0 }
    : null);

  useEffect(() => {
    let cancelled = false;
    setHistorySource(null);
    if (!preferredSourceContext) return;
    void getSavedResumeSource(preferredSourceContext).then((result) => {
      if (!cancelled && result.found) setHistorySource(result.source);
    });
    return () => {
      cancelled = true;
    };
  }, [preferredSourceContext?.subjectId, preferredSourceContext?.seriesId, preferredSourceContext?.season, preferredSourceContext?.episode]);

  const refresh = async () => {
    if (!canSearch || refreshInFlight.current) return;
    refreshInFlight.current = true;
    setLoading(true);
    setError(null);
    const previousSelection = selectedKey;
    try {
      console.log('[TorrentPanel] Searching torrents for', title, kind);

      let result: { results: TorrentApiItem[]; error?: string };
      if (isAnime) {
        result = await searchAnimeTorrents({
          title,
          year,
          aliases: titleAliases,
          originalLanguage,
        });
      } else {
        result = await searchMovieTorrents({
          imdbId,
          title,
          year,
          originalLanguage,
        });
      }

      if (result.error) throw new Error(result.error);
      const items = Array.isArray(result.results) ? result.results : [];
      const rows: TorrentRow[] = items.map((it) => ({
        title: it.title,
        size: typeof it.size === 'number' ? it.size : it.sizeBytes,
        seeders: it.seeders,
        leechers: it.leechers,
        magnetUri: it.magnetUri || it.magnet,
        sourceId: it.sourceId,
        torrentUrl: it.torrentUrl || it.downloadUrl,
        downloadUrl: it.downloadUrl,
        infoHash: it.infoHash,
        indexer: it.indexer || '-',
        publishDate: it.publishDate,
      }));
      console.log('[TorrentPanel] Found', rows.length, 'torrents');
      setTorrents(rows);
      setLastFetched(Date.now());
      // Refresh preserves the selected source by stable identity; a source
      // that vanished clears the selection with an explanation instead of
      // silently switching to another torrent.
      if (previousSelection && !rows.some((row) => actionKey(row) === previousSelection)) {
        setSelectedKey(null);
        setSelectionNotice('The selected source is no longer available. Choose another source.');
      } else {
        setSelectionNotice(null);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to load torrents';
      console.error('[TorrentPanel] Error:', e);
      setError(message);
      setTorrents([]);
    } finally {
      refreshInFlight.current = false;
      setLoading(false);
    }
  };

  useEffect(() => {
    setTorrents(null);
    setSelectedKey(null);
    setSelectionNotice(null);
    setDetailsOpenKey(null);
    setLastFetched(null);
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, imdbId, year, originalLanguage, kind, anilistId]);

  const meta = useMemo(() => {
    if (!lastFetched) return null;
    return new Date(lastFetched).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }, [lastFetched]);

  const displayedTorrents = useMemo(() => {
    return prioritizePreviouslyUsedTorrent(torrents || [], resumeSource || historySource);
  }, [historySource, resumeSource, torrents]);
  const actionKey = (torrent: TorrentRow) =>
    torrentInfoHash(torrent.infoHash) || torrentInfoHash(torrent.magnetUri) || torrent.sourceId || torrent.torrentUrl || torrent.title;

  const playInMpv = async (t: TorrentRow) => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setBusyActionId(`play:${actionKey(t)}`);
    setError(null);
    try {
    // Never log the torrent row or route params: they contain the magnet URI.
    platform.desktop?.debugLog?.('[TorrentPanel] playInMpv click', {
      title: t.title,
      hasMagnetUri: Boolean(t.magnetUri),
      hasInfoHash: Boolean(t.infoHash),
    });

    if (!platform.player) {
      setError('Playback is unavailable on this device. Reconnect to the server and try again.');
      return;
    }

    let magnet: string;
    try {
      magnet = await resolveTorrentSource(t);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to resolve the selected torrent.';
      setError(message);
      return;
    }

    // Navigate to player page with all necessary params
    const params: Record<string, string> = {
      magnet,
      title: title || 'Playing',
      cat: kind,
      sourceName: t.title,
    };
    if (resumeContext) {
      params.seriesId = resumeContext.seriesId;
      params.season = String(resumeContext.season);
      params.episode = String(resumeContext.episode);
    }
    if (tmdbId) params.tmdbId = String(tmdbId);
    if (imdbId) params.imdbId = imdbId;
    if (anilistId) params.anilistId = String(anilistId);
    if (!params.seriesId && defaultSeriesId) params.seriesId = defaultSeriesId;
    if (t.fileIndex != null) params.fileIndex = String(t.fileIndex);
    if (year) params.year = String(year);

    // Never log route params: they contain the magnet URI.
    router.push('player', params);
    } finally {
      actionInFlight.current = false;
      setBusyActionId(null);
    }
  };

  const openInExternalPlayer = async (torrent: TorrentRow) => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setBusyActionId(`external:${actionKey(torrent)}`);
    setError(null);
    try {
      const magnet = await resolveTorrentSource(torrent);
      await downloadM3U(magnet, title, kind, defaultSeriesId || undefined, imdbId);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Unable to resolve the selected torrent.');
    } finally {
      actionInFlight.current = false;
      setBusyActionId(null);
    }
  };

  if (!canSearch) {
    return (
      <div className="type-body rounded-xl border border-white/[0.1] bg-[#0a0a0a]/70 p-6 text-center text-white/70 backdrop-blur-xl">
        <p>Enter a title to find available sources.</p>
      </div>
    );
  }

  return (
    <aside className="max-h-[60vh] overflow-y-auto rounded-xl border border-white/[0.12] bg-[#0a0a0a]/75 backdrop-blur-2xl app-scrollbar">
      <div className="flex items-center justify-between border-b border-white/[0.08] px-5 py-4">
        <div>
          <p className="type-secondary font-medium text-white/65">Playback</p>
          <h3 className="type-panel-title mt-1 text-white">Available sources</h3>
          {meta ? <p className="type-caption text-numeric mt-1 text-white/65">Updated {meta}</p> : null}
        </div>
        <Button
          size="sm"
          onClick={() => void refresh()}
          disabled={loading}
          variant="outline"
          className="min-h-11 rounded-full border-white/20 bg-transparent px-4 text-white/75 hover:border-white/40 hover:bg-white/[0.05] hover:text-white"
        >
          <RotateCcw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {loading && torrents === null && (
        <div className="flex items-center justify-center gap-2 px-5 py-14 text-sm text-white/60" role="status" aria-live="polite">
          <Loader2 className="h-4 w-4 animate-spin" />
          Finding sources…
        </div>
      )}

      {error && (
        <div className="m-4 rounded-lg border border-red-400/20 bg-red-950/20 p-4 text-sm text-red-100" role="alert">
          <p>{error}</p>
          {platform.desktop ? (
            <button
              type="button"
              onClick={() => platform.desktop?.openSetup()}
              className="mt-3 min-h-10 rounded-full border border-white/20 px-4 text-sm text-white/85 transition hover:border-white/40 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
            >
              Open settings
            </button>
          ) : null}
        </div>
      )}

      {selectionNotice && (
        <p className="mx-4 mt-4 rounded-lg border border-[#ffc285]/30 bg-[#ffc285]/10 px-4 py-3 text-sm text-[#ffc285]" role="status">
          {selectionNotice}
        </p>
      )}

      {!loading && torrents && displayedTorrents.length === 0 && (
        <div className="type-body m-4 rounded-lg border border-dashed border-white/15 p-8 text-center text-white/70">
          No sources found for this title.
        </div>
      )}

      {!loading && torrents && displayedTorrents.length > 0 && (
        <>
          <ul className="list-none" aria-label="Available torrent sources">
            {displayedTorrents.slice(0, 10).map((t, idx) => {
              const quality = qualityFromTitle(t.title);
              const isPreviouslyUsed = t.previouslyUsed === true;
              const torrentActionKey = actionKey(t);
              const playActionId = `play:${torrentActionKey}`;
              const externalActionId = `external:${torrentActionKey}`;
              const isSelected = selectedKey === torrentActionKey;
              const detailsOpen = detailsOpenKey === torrentActionKey;
              return (
                <li
                  key={torrentInfoHash(t.infoHash) || torrentInfoHash(t.magnetUri) || t.magnetUri || t.infoHash || idx}
                  className={`border-b border-white/[0.08] last:border-b-0 ${
                    isSelected ? 'bg-white/[0.07]' : isPreviouslyUsed ? 'bg-[#ff7a17]/[0.09]' : 'hover:bg-white/[0.035]'
                  }`}
                >
                  <div className="px-5 py-4">
                    <div className="flex items-start gap-3 sm:items-center sm:justify-between">
                      <button type="button" aria-label={`Play source ${t.title}`} onClick={() => { setSelectedKey(torrentActionKey); void playInMpv(t); }} disabled={Boolean(busyActionId)} className={`inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-white text-black disabled:opacity-50 sm:hidden ${FOCUS_RING_CLASS}`}>
                        {busyActionId === playActionId ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" /> : <Play className="h-5 w-5 fill-current" aria-hidden="true" />}
                      </button>
                      {/* WF06: tapping a row selects it — playback is a
                          separate, explicit action (footer button on compact,
                          split button on desktop). The release name is never
                          truncated. */}
                      <button
                        type="button"
                        onClick={() => { setSelectedKey(torrentActionKey); setSelectionNotice(null); }}
                        aria-pressed={isSelected}
                        className={`block min-w-0 flex-1 text-left ${FOCUS_RING_CLASS}`}
                        aria-label={`Select source ${t.title}`}
                      >
                        <div className="min-w-0 flex-1">
                            <div className="mb-2 flex flex-wrap items-center gap-2">
                              <p className={`break-all text-sm ${isSelected ? 'font-semibold text-white' : 'text-white/85'}`}>{t.title}</p>
                              {quality ? (
                                <span className="font-label shrink-0 rounded border border-white/20 px-1.5 py-0.5 text-white/70">
                                  {quality}
                                </span>
                              ) : (
                                <span className="font-label shrink-0 rounded border border-white/10 px-1.5 py-0.5 text-white/40">Unknown quality</span>
                              )}
                              {isSelected ? (
                                <span className="font-label shrink-0 rounded bg-white px-1.5 py-0.5 text-black">Selected</span>
                              ) : isPreviouslyUsed ? (
                                <span className="font-label shrink-0 rounded bg-[#ff7a17] px-1.5 py-0.5 text-black">Previously used</span>
                              ) : null}
                            </div>
                            <div className="type-caption text-numeric flex flex-wrap items-center gap-x-3 gap-y-1 text-white/70">
                              <span>{t.size ? formatBytes(t.size) : 'Unknown size'}</span>
                              <span className={typeof t.seeders === 'number' ? 'text-emerald-300/70' : 'text-white/40'}>
                                {typeof t.seeders === 'number' ? `↑ ${t.seeders}` : '↑ Unknown seeders'}
                              </span>
                              {typeof t.leechers === 'number' && (
                                <span className="text-[#ffc285]/70">↓ {t.leechers}</span>
                              )}
                              {t.indexer && t.indexer !== '-' && <span>{t.indexer}</span>}
                              {t.publishDate && <span>{formatDate(t.publishDate)}</span>}
                            </div>
                        </div>
                      </button>
                      <div className="hidden shrink-0 sm:flex">
                            {isElectron ? (
                              <PlaybackSplitButton
                                onPlay={() => {
                                  // Title only: torrent rows carry the magnet URI.
                                  console.log('[TorrentPanel] Play clicked:', t.title);
                                  setSelectedKey(torrentActionKey);
                                  void playInMpv(t);
                                }}
                                onOpenExternal={() => void openInExternalPlayer(t)}
                                disabled={Boolean(busyActionId)}
                                playBusy={busyActionId === playActionId}
                                externalBusy={busyActionId === externalActionId}
                              />
                            ) : (
                              <Button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setSelectedKey(torrentActionKey);
                                  void playInMpv(t);
                                }}
                                disabled={Boolean(busyActionId)}
                                className="min-h-11 rounded-full bg-white px-5 text-black hover:bg-white/85"
                              >
                                <Play className="mr-2 h-4 w-4 fill-current" aria-hidden="true" />
                                {busyActionId === playActionId ? 'Opening…' : 'Play'}
                              </Button>
                            )}
                          </div>
                        </div>

                    {/* WF06a: source-details disclosure — technical/source
                        metadata with explicit unknowns; "Use this torrent"
                        confirms the selection and returns to the list without
                        starting playback. */}
                    <div className="mt-2">
                      <button
                        type="button"
                        ref={(element) => {
                          if (element) detailsButtonRefs.current.set(torrentActionKey, element);
                          else detailsButtonRefs.current.delete(torrentActionKey);
                        }}
                        onClick={() => setDetailsOpenKey(detailsOpen ? null : torrentActionKey)}
                        aria-expanded={detailsOpen}
                        aria-controls={`source-details-${idx}`}
                        className={`inline-flex min-h-9 items-center gap-1 rounded-full px-3 text-xs text-white/60 transition hover:text-white ${FOCUS_RING_CLASS}`}
                      >
                        {detailsOpen ? 'Hide details' : 'Details'}
                      </button>
                      {detailsOpen ? (
                        <dl id={`source-details-${idx}`} className="mt-3 space-y-2 rounded-lg border border-white/10 bg-black/30 p-4 text-sm">
                          <div>
                            <dt className="text-xs uppercase tracking-wide text-white/45">Full release name</dt>
                            <dd className="break-all text-white/85">{t.title}</dd>
                          </div>
                          <div className="grid grid-cols-2 gap-x-6 gap-y-2">
                            <div>
                              <dt className="text-xs uppercase tracking-wide text-white/45">Quality</dt>
                              <dd className="text-white/85">{quality ?? 'Unknown'}</dd>
                            </div>
                            <div>
                              <dt className="text-xs uppercase tracking-wide text-white/45">Size</dt>
                              <dd className="text-numeric text-white/85">{t.size ? `${formatBytes(t.size)} (${t.size.toLocaleString()} bytes)` : 'Unknown'}</dd>
                            </div>
                            <div>
                              <dt className="text-xs uppercase tracking-wide text-white/45">Seeders</dt>
                              <dd className="text-numeric text-white/85">{typeof t.seeders === 'number' ? t.seeders : 'Unknown'}</dd>
                            </div>
                            <div>
                              <dt className="text-xs uppercase tracking-wide text-white/45">Leechers</dt>
                              <dd className="text-numeric text-white/85">{typeof t.leechers === 'number' ? t.leechers : 'Unknown'}</dd>
                            </div>
                            <div>
                              <dt className="text-xs uppercase tracking-wide text-white/45">Indexer</dt>
                              <dd className="break-all text-white/85">{t.indexer && t.indexer !== '-' ? t.indexer : 'Unknown'}</dd>
                            </div>
                            <div>
                              <dt className="text-xs uppercase tracking-wide text-white/45">Published</dt>
                              <dd className="text-white/85">{formatDate(t.publishDate) ?? 'Unknown'}</dd>
                            </div>
                            <div>
                              <dt className="text-xs uppercase tracking-wide text-white/45">Info hash</dt>
                              <dd className="break-all text-numeric text-white/85">{torrentInfoHash(t.infoHash) ?? torrentInfoHash(t.magnetUri) ?? 'Unknown'}</dd>
                            </div>
                            <div>
                              <dt className="text-xs uppercase tracking-wide text-white/45">Magnet link</dt>
                              <dd className="text-white/85">{t.magnetUri || torrentInfoHash(t.infoHash) || torrentInfoHash(t.magnetUri) ? 'Available' : 'Unknown'}</dd>
                            </div>
                          </div>
                          <div className="pt-1">
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedKey(torrentActionKey);
                                setSelectionNotice(null);
                                setDetailsOpenKey(null);
                                // Return focus to the list: the row's details
                                // toggle stays in place, preserving position.
                                requestAnimationFrame(() => {
                                  detailsButtonRefs.current.get(torrentActionKey)?.focus();
                                });
                              }}
                              className={`inline-flex min-h-11 items-center gap-2 rounded-lg border border-white/20 px-4 text-sm text-white/90 transition hover:border-white/40 hover:text-white ${FOCUS_RING_CLASS}`}
                              aria-label={`Use this torrent: ${t.title}`}
                            >
                              Use this torrent
                            </button>
                            <p className="type-caption mt-2 text-white/50">
                              Confirming selects this source and returns to the list — it does not start playback.
                            </p>
                          </div>
                        </dl>
                      ) : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>

          {/* WF06: fixed Play footer — the explicit playback action for the
              selected source. Disabled without a selection; never auto-plays. */}
          <div className="sticky bottom-0 border-t border-white/[0.1] bg-[#0c0c0c]/95 px-5 py-3 backdrop-blur-xl sm:hidden">
            <Button
                type="button"
                onClick={() => {
                  const selected = displayedTorrents.find((row) => actionKey(row) === selectedKey);
                  if (selected) void playInMpv(selected);
                }}
                disabled={!selectedKey || Boolean(busyActionId)}
                className="min-h-11 w-full rounded-full bg-white px-4 text-black hover:bg-white/85"
              >
                <Play className="mr-2 h-4 w-4 fill-current" aria-hidden="true" />
                {busyActionId ? 'Opening…' : selectedKey ? 'Play selected source' : 'Select a source to play'}
              </Button>
          </div>
        </>
      )}
    </aside>
  );
}



