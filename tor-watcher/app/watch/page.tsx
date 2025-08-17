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
  }>;
}) {
  const sp = await searchParams; // <-- await first
  const { magnet, src, infoHash, title = "Unknown", year, imdbId } = sp;

  // Build a guaranteed string for the player (it only accepts a `magnet: string`)
  const resolvedMagnet =
    (magnet && magnet.length > 0 && magnet) ||
    (src && src.length > 0 && src) ||
    (infoHash && `magnet:?xt=urn:btih:${infoHash.toUpperCase()}`) ||
    "";

  return (
    <div className="p-4">
      <VideoPlayer
        magnet={resolvedMagnet}
        title={title}
        year={year ? Number(year) : undefined}
        imdbId={imdbId}
      />
    </div>
  );
}