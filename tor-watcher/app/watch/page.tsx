import VideoPlayer from "@/components/player/VideoPlayer";

export default async function WatchPage({
  searchParams,
}: {
  searchParams: Promise<{
    magnet?: string;
    src?: string;
    infoHash?: string;
    title?: string;
    year?: string;
    imdbId?: string;
    fileIndex?: string;
    kind?: string;
    seriesId?: string;
    season?: string;
    episode?: string;
  }>;
}) {
  const sp = await searchParams; // <-- await first
  const { magnet, src, infoHash, title = "Unknown", year, imdbId, fileIndex, kind, seriesId, season, episode } = sp;

  // Build a guaranteed string for the player (it only accepts a `magnet: string`)
  const resolvedMagnet =
    (magnet && magnet.length > 0 && magnet) ||
    (src && src.length > 0 && src) ||
    (infoHash && `magnet:?xt=urn:btih:${infoHash.toUpperCase()}`) ||
    "";

  const parsedFileIndex = fileIndex ? Number(fileIndex) : undefined;
  const validFileIndex =
    parsedFileIndex !== undefined && Number.isFinite(parsedFileIndex) && parsedFileIndex >= 0
      ? parsedFileIndex
      : undefined;

  const resolvedKind = kind === "tv" || kind === "anime" ? kind : "movie";
  const parsedSeason = season ? Number(season) : undefined;
  const parsedEpisode = episode ? Number(episode) : undefined;

  return (
    <div className="p-4">
      <VideoPlayer
        magnet={resolvedMagnet}
        title={title}
        year={year ? Number(year) : undefined}
        imdbId={imdbId}
        fileIndex={validFileIndex}
        cat={resolvedKind}
        seriesId={seriesId}
        season={parsedSeason}
        episode={parsedEpisode}
      />
    </div>
  );
}