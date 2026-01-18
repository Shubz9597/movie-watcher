import { useEffect, useRef, useState } from 'react';
import { getMovie as getTmdbMovie, getTv as getTmdbTv } from '../lib/services/tmdb-service';
import { getAnime } from '../lib/services/jikan-service';
import { getVodBase } from '../lib/api-client';

type Props = {
  navigate: (path: string, params?: Record<string, string>) => void;
  params: Record<string, string>;
};

const VOD_BASE = getVodBase();

export default function PlayerPage({ navigate, params }: Props) {
  const {
    magnet,
    title: paramTitle,
    cat = 'movie',
    tmdbId,
    malId,
    fileIndex = '0',
  } = params;

  const [posterUrl, setPosterUrl] = useState<string | null>(null);
  const [year, setYear] = useState<number | undefined>(undefined);
  const [displayTitle, setDisplayTitle] = useState(paramTitle || 'Playing');
  const didStartPlaybackRef = useRef(false);

  // Fetch poster and metadata
  useEffect(() => {
    async function fetchMetadata() {
      if (tmdbId && cat !== 'anime') {
        try {
          const data = cat === 'movie' ? await getTmdbMovie(Number(tmdbId)) : await getTv(Number(tmdbId));
          if (data.poster_path) {
            setPosterUrl(data.poster_path);
          }
          if (data.release_date || data.first_air_date) {
            const date = data.release_date || data.first_air_date;
            setYear(Number(date.slice(0, 4)));
          }
          if (data.title || data.name) {
            setDisplayTitle(data.title || data.name);
          }
        } catch (err) {
          console.error('[PlayerPage] Failed to fetch TMDB metadata:', err);
        }
      } else if (malId && cat === 'anime') {
        try {
          const data = await getAnime(Number(malId));
          if (data.images?.jpg?.large_image_url) {
            setPosterUrl(data.images.jpg.large_image_url);
          }
          if (data.year) {
            setYear(data.year);
          }
          if (data.title) {
            setDisplayTitle(data.title);
          }
        } catch (err) {
          console.error('[PlayerPage] Failed to fetch anime metadata:', err);
        }
      }
    }
    fetchMetadata();
  }, [tmdbId, malId, cat]);

  // Initialize playback
  useEffect(() => {
    if (!magnet) {
      console.error('[PlayerPage] No magnet provided');
      navigate('home');
      return;
    }

    let cancelled = false;

    async function startPlayback() {
      try {
        window.electronAPI?.debugLog?.('[PlayerPage] startPlayback', {
          hasElectronAPI: Boolean(window.electronAPI),
          hasMagnet: Boolean(magnet),
          cat,
          fileIndex,
        });
        // Check MPV readiness
        const readyCheck = await window.electronAPI?.isMpvReady();
        if (!readyCheck?.ready) {
          const waitResult = await window.electronAPI?.waitForMpvReady();
          if (cancelled) return;
          if (!waitResult?.ready) {
            alert('MPV player failed to initialize');
            navigate('home');
            return;
          }
        }
        if (cancelled) return;

        // Start playback
        window.electronAPI?.debugLog?.('[PlayerPage] calling playInMpv', { title: displayTitle, cat, fileIndex });
        const result = await window.electronAPI?.playInMpv({
          url: magnet,
          magnet: magnet, // Pass magnet separately for backend API calls
          title: displayTitle,
          cat,
          fileIndex: Number(fileIndex),
          tmdbId: tmdbId ? Number(tmdbId) : undefined,
          malId: malId ? Number(malId) : undefined,
          year: year,
          posterUrl: posterUrl,
        });
        if (cancelled) return;

        if (!result?.ok) {
          alert(`Failed to play: ${result?.error || 'Unknown error'}`);
          navigate('home');
          return;
        }

        didStartPlaybackRef.current = true;

        // MPV window is now positioned automatically by the play handler
        // Loading screen and buffer info are handled by the controls overlay window
      } catch (err) {
        console.error('[PlayerPage] Playback initialization failed:', err);
        alert('Failed to start playback: ' + (err instanceof Error ? err.message : String(err)));
        navigate('home');
      }
    }

    startPlayback();

    return () => {
      cancelled = true;
      // In dev (React strict mode / HMR), effects can mount/unmount rapidly.
      // Only stop MPV if we actually started playback from this page.
      if (!didStartPlaybackRef.current) return;
      window.electronAPI?.stopMpv().catch(err => {
        console.error('[PlayerPage] Error stopping MPV on unmount:', err);
      });
    };
  }, [magnet, cat, fileIndex, displayTitle, year, posterUrl, navigate]);


  return (
    <div className="fixed inset-0 z-50 bg-black">
      {/* Note: MPV window is a separate standalone window that appears over this page */}
      {/* The loading screen and controls overlay are handled by the MPV window's controls overlay */}
      {/* This page is hidden during playback, so no UI is needed here */}
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="text-center text-white/50">
          <p className="text-lg">Playing in MPV player</p>
          <p className="text-sm mt-2">The video window should be visible</p>
        </div>
      </div>
    </div>
  );
}
