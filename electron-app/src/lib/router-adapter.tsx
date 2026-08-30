// Router adapter to make Next.js router work in Electron
import { createContext, useContext, ReactNode } from 'react';

type NavigateFunction = (path: string, params?: Record<string, string>) => void;

const RouterContext = createContext<{ navigate: NavigateFunction } | null>(null);

export function RouterProvider({
  children,
  navigate,
}: {
  children: ReactNode;
  navigate: NavigateFunction;
}) {
  return <RouterContext.Provider value={{ navigate }}>{children}</RouterContext.Provider>;
}

// Hook that mimics Next.js useRouter
export function useRouter() {
  const ctx = useContext(RouterContext);
  if (!ctx) {
    // Fallback for components that don't have router context
    return {
      push: (path: string) => {
        window.location.hash = path.startsWith('#') ? path.slice(1) : path.startsWith('/') ? path.slice(1) : path;
      },
      replace: (path: string) => {
        window.location.hash = path.startsWith('#') ? path.slice(1) : path.startsWith('/') ? path.slice(1) : path;
      },
      prefetch: () => {},
    };
  }
  return {
    push: (path: string, params?: Record<string, string>) => {
      // If params are provided as second argument, use them directly
      if (params) {
        ctx.navigate(path, params);
        return;
      }
      // Otherwise, parse path like "/title/movie/123" or "/watch?magnet=..."
      let route = path;
      if (route.startsWith('/')) route = route.slice(1);
      if (route.startsWith('#')) route = route.slice(1);
      const [routePath, query] = route.split('?');
      const parsedParams = query ? Object.fromEntries(new URLSearchParams(query)) : {};
      ctx.navigate(routePath, parsedParams);
    },
    replace: (path: string, params?: Record<string, string>) => {
      // If params are provided as second argument, use them directly
      if (params) {
        ctx.navigate(path, params);
        return;
      }
      // Otherwise, parse path
      let route = path;
      if (route.startsWith('/')) route = route.slice(1);
      if (route.startsWith('#')) route = route.slice(1);
      const [routePath, query] = route.split('?');
      const parsedParams = query ? Object.fromEntries(new URLSearchParams(query)) : {};
      ctx.navigate(routePath, parsedParams);
    },
    prefetch: () => {}, // No-op in Electron
  };
}

// Hook that mimics Next.js useSearchParams
export function useSearchParams() {
  const hash = window.location.hash.slice(1);
  const [, query] = hash.split('?');
  return new URLSearchParams(query || '');
}

// Hook that mimics Next.js usePathname
export function usePathname() {
  const hash = window.location.hash.slice(1);
  const [path] = hash.split('?');
  return `/${path || 'home'}`;
}



