export function progressFromPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  const subjectId = String(payload.subjectId || "").trim();
  const seriesId = String(payload.seriesId || "").trim();
  const season = Number(payload.season ?? 0);
  const episode = Number(payload.episode ?? 0);
  if (!subjectId || !seriesId || !Number.isInteger(season) || !Number.isInteger(episode) || season < 0 || episode < 0) {
    return null;
  }
  const sourceUri = String(payload.magnet || payload.url || "").trim();
  const sourceName = String(payload.sourceName || "").trim();
  const sourceKind = String(payload.cat || "").trim();
  const parsedFileIndex = Number(payload.fileIndex);
  const sourceFileIndex = payload.fileIndex !== undefined && Number.isInteger(parsedFileIndex) && parsedFileIndex >= 0
    ? parsedFileIndex
    : null;
  const parsedNextSeason = Number(payload.nextSeason);
  const parsedNextEpisode = Number(payload.nextEpisode);
  const hasNextEpisode = payload.nextSeason !== undefined
    && payload.nextEpisode !== undefined
    && Number.isInteger(parsedNextSeason)
    && Number.isInteger(parsedNextEpisode)
    && parsedNextSeason >= 0
    && parsedNextEpisode > 0
    && (parsedNextSeason !== season || parsedNextEpisode !== episode);
  return {
    subjectId,
    seriesId,
    season,
    episode,
    sourceUri,
    sourceName,
    sourceKind,
    sourceFileIndex,
    nextSeason: hasNextEpisode ? parsedNextSeason : null,
    nextEpisode: hasNextEpisode ? parsedNextEpisode : null,
  };
}

export async function fetchResumePosition(vodBase, progress) {
  if (!progress) return 0;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const query = new URLSearchParams({
      subjectId: progress.subjectId,
      seriesId: progress.seriesId,
      season: String(progress.season),
      episode: String(progress.episode),
    });
    const response = await fetch(`${vodBase}/v1/resume?${query.toString()}`, { signal: controller.signal });
    if (!response.ok) return 0;
    const data = await response.json();
    const position = Number(data?.position_s || 0);
    return data?.found === true && Number.isFinite(position) && position > 0 ? position : 0;
  } catch (err) {
    console.warn("[Progress] Resume lookup failed:", err.message);
    return 0;
  } finally {
    clearTimeout(timeout);
  }
}

export async function postProgress(vodBase, progress, position, duration) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(`${vodBase}/v1/session/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subjectId: progress.subjectId,
        seriesId: progress.seriesId,
        season: progress.season,
        episode: progress.episode,
        position_s: Math.floor(position),
        duration_s: Math.floor(duration),
        sourceUri: progress.sourceUri,
        sourceName: progress.sourceName,
        sourceKind: progress.sourceKind,
        sourceFileIndex: progress.sourceFileIndex,
        nextSeason: progress.nextSeason,
        nextEpisode: progress.nextEpisode,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`heartbeat returned ${response.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}
