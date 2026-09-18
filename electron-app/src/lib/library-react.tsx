// Library React integration (feature 002 M3.3): the composition root supplies
// one library controller (the server-backed LibraryStore) via
// LibraryContextProvider; shared components consume it through useLibrary()
// and useLibraryState(). A null controller means the platform has no
// server-backed library (browser preview/fixture mode or pre-capability
// servers) — consumers render their truthful unavailable or preview states
// and never fall back to local storage.
import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import type { LibraryController, LibrarySnapshot } from './library-store.ts';

const LibraryContext = createContext<LibraryController | null>(null);

export function LibraryContextProvider({ store, children }: { store: LibraryController | null; children: ReactNode }) {
  return <LibraryContext.Provider value={store}>{children}</LibraryContext.Provider>;
}

export function useLibrary(): LibraryController | null {
  return useContext(LibraryContext);
}

const nullSubscribe = () => () => undefined;
const nullSnapshot = () => null;

export function useLibraryState(): LibrarySnapshot | null {
  const store = useLibrary();
  // The same snapshot function serves client and server renders so SSR
  // markup reflects the current state (relevant for test/capture harnesses).
  return useSyncExternalStore(
    store?.subscribe ?? nullSubscribe,
    store?.getSnapshot ?? nullSnapshot,
    store?.getSnapshot ?? nullSnapshot,
  );
}

// Slice subscription: re-renders ONLY when the selected slice changes
// (Object.is) instead of on every publish of the whole snapshot. Selectors
// must return primitives or snapshot-stable references (a slice of the
// current snapshot), never freshly-built objects.
const selectorCaches = new WeakMap<LibraryController, Map<(snapshot: LibrarySnapshot | null) => unknown, { snapshot: LibrarySnapshot | null; result: unknown }>>();

function selectCached<T>(store: LibraryController | null, selector: (snapshot: LibrarySnapshot | null) => T): T {
  if (!store) return selector(null);
  let bySelector = selectorCaches.get(store);
  if (!bySelector) {
    bySelector = new Map();
    selectorCaches.set(store, bySelector);
  }
  // Inline (per-render) selectors accumulate; keep the cache bounded.
  if (bySelector.size > 32) bySelector.clear();
  const cached = bySelector.get(selector);
  const snapshot = store.getSnapshot();
  if (cached && cached.snapshot === snapshot) return cached.result as T;
  const result = selector(snapshot);
  bySelector.set(selector, { snapshot, result });
  return result;
}

export function useLibrarySelector<T>(store: LibraryController | null, selector: (snapshot: LibrarySnapshot | null) => T): T {
  return useSyncExternalStore(
    store?.subscribe ?? nullSubscribe,
    () => selectCached(store, selector),
    () => selectCached(store, selector),
  );
}
