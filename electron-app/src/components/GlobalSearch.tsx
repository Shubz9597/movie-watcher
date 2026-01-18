import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from './ui/dialog';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from './ui/command';
import { TrendingUp } from 'lucide-react';

type SearchKind = 'movie' | 'tv' | 'person';
type Basic = { id: number; title?: string; name?: string; year?: number; rating?: number; posterUrl?: string | null };
type SearchResults = Record<SearchKind, Basic[]>;

const MIN_CHARS = 2;
const DEBOUNCE_MS = 350;
const MAX_ITEMS_PER_GROUP = 6;
const CACHE_SIZE = 50;

class LRU<K, V> {
  private map = new Map<K, V>();
  constructor(private readonly max = 50) {}
  get(k: K): V | undefined {
    const v = this.map.get(k);
    if (v !== undefined) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  set(k: K, v: V) {
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, v);
    if (this.map.size > this.max) {
      const first = this.map.keys().next().value;
      if (first !== undefined) {
        this.map.delete(first);
      }
    }
  }
}
const cache = new LRU<string, SearchResults>(CACHE_SIZE);

const QUICK_SEARCHES = ['Dune: Part Two', 'The Bear', 'Deadpool & Wolverine', 'Inside Out 2', 'Fallout'];

export default function GlobalSearch({
  children,
  navigate,
}: {
  children: React.ReactNode;
  navigate: (path: string, params?: Record<string, string>) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [debouncedQuery, setDebouncedQuery] = React.useState('');
  const [results, setResults] = React.useState<SearchResults>({ movie: [], tv: [], person: [] });
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const latestReqIdRef = React.useRef(0);

  // Global hotkey: Cmd/Ctrl+K to open
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isCmdK = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k';
      if (isCmdK) {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Debounce input
  React.useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < MIN_CHARS) {
      setDebouncedQuery('');
      setResults({ movie: [], tv: [], person: [] });
      setError(null);
      setLoading(false);
      return;
    }
    const t = setTimeout(() => setDebouncedQuery(q), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [open, query]);

  // Fetch when debouncedQuery changes
  React.useEffect(() => {
    const q = debouncedQuery;
    if (!open || q.length < MIN_CHARS) return;

    const key = `multi:${q}`;
    const cached = cache.get(key);
    if (cached) {
      setResults(cached);
      return;
    }

    const id = latestReqIdRef.current + 1;
    latestReqIdRef.current = id;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);

    (async () => {
      try {
        setLoading(true);
        setError(null);

        const u = new URLSearchParams();
        u.set('page', '1');
        u.set('query', q);

        console.log('[GlobalSearch] Searching for:', q);
        const { searchMulti } = await import('../lib/services/tmdb-service');
        const data = await searchMulti(q, 1);

        const normalized: SearchResults = {
          movie: (data?.movie ?? []).slice(0, MAX_ITEMS_PER_GROUP),
          tv: (data?.tv ?? []).slice(0, MAX_ITEMS_PER_GROUP),
          person: (data?.person ?? []).slice(0, MAX_ITEMS_PER_GROUP),
        };

        if (latestReqIdRef.current === id) {
          setResults(normalized);
          cache.set(key, normalized);
        }
      } catch (e: unknown) {
        if ((e as { name?: string }).name !== 'AbortError') {
          const msg = e instanceof Error ? e.message : String(e);
          console.error('[GlobalSearch] Error:', e);
          setError(msg || 'Search failed');
          setResults({ movie: [], tv: [], person: [] });
          
          // If it's an auth error, show helpful message
          if (msg.includes('authentication') || msg.includes('401')) {
            setError('API key not configured. Please set TMDB_API_KEY or TMDB_ACCESS_TOKEN in settings.');
          }
        }
      } finally {
        clearTimeout(timer);
        setLoading(false);
      }
    })();

    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [open, debouncedQuery]);

  function clsx(...a: (string | false | null | undefined)[]) {
    return a.filter(Boolean).join(' ');
  }

  function highlight(text: string, q: string) {
    if (!q) return text;
    const i = text.toLowerCase().indexOf(q.toLowerCase());
    if (i === -1) return text;
    return (
      <>
        {text.slice(0, i)}
        <mark className="rounded px-1 bg-amber-400/20 text-amber-100">{text.slice(i, i + q.length)}</mark>
        {text.slice(i + q.length)}
      </>
    );
  }

  function ratingColor(r?: number) {
    if (!r && r !== 0) return 'bg-slate-700 text-slate-200';
    if (r >= 7.5) return 'bg-emerald-600/20 text-emerald-300 ring-1 ring-emerald-500/30';
    if (r >= 6) return 'bg-amber-600/20 text-amber-300 ring-1 ring-amber-500/30';
    return 'bg-rose-600/20 text-rose-300 ring-1 ring-rose-500/30';
  }

  function RatingPill({ rating }: { rating?: number }) {
    if (rating == null) return null;
    return (
      <span
        className={clsx(
          'ml-3 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
          ratingColor(rating)
        )}
      >
        <span className="inline-block rounded-[3px] bg-yellow-400/90 text-black px-1 py-[1px] text-[10px] leading-none">
          IMDb
        </span>
        {rating.toFixed(1)}
      </span>
    );
  }

  function PosterThumb({ src, alt }: { src?: string | null; alt: string }) {
    return (
      <div className="mr-3 h-10 w-7 overflow-hidden rounded-md bg-slate-800 ring-1 ring-white/5">
        {src ? <img src={src} alt={alt} className="h-10 w-7 object-cover" /> : null}
      </div>
    );
  }

  function searchNow() {
    const q = query.trim();
    if (q.length >= MIN_CHARS) setDebouncedQuery(q);
  }

  function closeAnd(fn?: () => void) {
    setOpen(false);
    setQuery('');
    setDebouncedQuery('');
    setResults({ movie: [], tv: [], person: [] });
    setLoading(false);
    setError(null);
    fn?.();
  }

  // Handle clicks on children to open dialog
  const handleChildClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setOpen(true);
  };

  // Clone children and add click handler
  const childrenWithClick = React.Children.map(children, (child) => {
    if (React.isValidElement(child)) {
      return React.cloneElement(child as React.ReactElement<any>, {
        onClick: (e: React.MouseEvent) => {
          handleChildClick(e);
          // Call original onClick if it exists
          if (child.props.onClick) {
            child.props.onClick(e);
          }
        },
      });
    }
    return child;
  });

  return (
    <>
      {childrenWithClick}

      <Dialog
        open={open}
        onOpenChange={(v) => {
          setOpen(v);
          if (!v) {
            setQuery('');
            setDebouncedQuery('');
            setResults({ movie: [], tv: [], person: [] });
            setLoading(false);
            setError(null);
          }
        }}
      >
        <DialogContent className="w-full max-w-2xl overflow-hidden rounded-2xl border border-white/10 bg-[#050912]/95 p-0 shadow-2xl backdrop-blur-2xl">
          <DialogTitle className="sr-only">Global search</DialogTitle>

          <Command
            shouldFilter={false}
            className="[&_[cmdk-group-heading]]:sticky [&_[cmdk-group-heading]]:top-0 [&_[cmdk-group-heading]]:z-10 [&_[cmdk-group-heading]]:bg-transparent [&_[cmdk-group-heading]]:px-4 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:tracking-[0.08em] [&_[cmdk-group-heading]]:text-slate-300 [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:after:block [&_[cmdk-group-heading]]:after:mt-1 [&_[cmdk-group-heading]]:after:h-px [&_[cmdk-group-heading]]:after:w-full [&_[cmdk-group-heading]]:after:bg-white/10"
          >
            <CommandInput
              aria-label="Search movies, shows, people"
              placeholder="Search movies, shows, people…"
              className="px-4 text-base [&_input]:pr-8"
              value={query}
              onValueChange={setQuery}
              onKeyDown={(e) => {
                if (e.key === 'Enter') searchNow();
              }}
              onPaste={() => searchNow()}
            />

            <CommandList aria-busy={loading} className="max-h-[60vh] overflow-y-auto">
              <CommandEmpty>
                <div className="px-4 py-6 text-sm text-slate-400">
                  {error
                    ? `Error: ${error}`
                    : query.trim().length < MIN_CHARS
                      ? `Type at least ${MIN_CHARS} characters to search`
                      : loading
                        ? 'Searching…'
                        : 'No results found.'}
                </div>
              </CommandEmpty>

              {debouncedQuery.length < MIN_CHARS && (
                <CommandGroup heading="TRY THIS">
                  {QUICK_SEARCHES.map((title) => (
                    <CommandItem
                      key={title}
                      value={title}
                      onSelect={() => {
                        setQuery(title);
                        setDebouncedQuery(title);
                      }}
                      className="px-4 py-2 text-slate-200 hover:bg-white/5"
                    >
                      <TrendingUp className="mr-2 h-4 w-4 text-amber-400" />
                      {title}
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}

              {results.movie.length > 0 && (
                <CommandGroup heading="MOVIES">
                  {results.movie.map((m) => (
                    <CommandItem
                      key={`m-${m.id}`}
                      onSelect={() => closeAnd(() => navigate('title', { kind: 'movie', id: String(m.id) }))}
                      className="px-4 py-2 hover:bg-white/5 data-[selected=true]:bg-white/10 data-[selected=true]:text-white"
                    >
                      <PosterThumb src={m.posterUrl ?? undefined} alt={m.title || 'Movie'} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-slate-100">{highlight(m.title || 'Untitled', query.trim())}</div>
                      </div>
                      {m.year ? <span className="ml-3 shrink-0 text-xs text-slate-400">{m.year}</span> : null}
                      <RatingPill rating={m.rating} />
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}

              {results.tv.length > 0 && (
                <CommandGroup heading="TV SHOWS">
                  {results.tv.map((t) => (
                    <CommandItem
                      key={`t-${t.id}`}
                      onSelect={() => closeAnd(() => navigate('title', { kind: 'tv', id: String(t.id) }))}
                      className="px-4 py-2 hover:bg-white/5 data-[selected=true]:bg-white/10 data-[selected=true]:text-white"
                    >
                      <PosterThumb src={t.posterUrl ?? undefined} alt={t.title || t.name || 'TV'} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-slate-100">{highlight(t.title || t.name || 'Untitled', query.trim())}</div>
                      </div>
                      {t.year ? <span className="ml-3 shrink-0 text-xs text-slate-400">{t.year}</span> : null}
                      <RatingPill rating={t.rating} />
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}

              {results.person.length > 0 && (
                <CommandGroup heading="PEOPLE">
                  {results.person.map((p) => (
                    <CommandItem
                      key={`p-${p.id}`}
                      onSelect={() => closeAnd()}
                      className="px-4 py-2 hover:bg-white/5 data-[selected=true]:bg-white/10 data-[selected=true]:text-white"
                    >
                      <div className="mr-3 h-10 w-10 overflow-hidden rounded-full bg-slate-800 ring-1 ring-white/5" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-slate-100">{highlight(p.name || 'Unknown', query.trim())}</div>
                      </div>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}

              <CommandSeparator />
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>
    </>
  );
}



