import { useEffect, useState } from 'react';
import { RouterProvider } from './lib/router-adapter';
import AppHeader from './components/AppHeader';
import HomePage from './pages/HomePage';
import TitlePage from './pages/TitlePage';
import SeeAllPage from './pages/SeeAllPage';
import WatchPage from './pages/WatchPage';
import PlayerPage from './pages/PlayerPage';

// Simple hash-based router
function useHashRouter() {
  const [route, setRoute] = useState(() => {
    const hash = window.location.hash.slice(1) || 'home';
    const [path, query] = hash.split('?');
    return { path, params: new URLSearchParams(query || '') };
  });

  useEffect(() => {
    const handleHashChange = () => {
      const hash = window.location.hash.slice(1) || 'home';
      const [path, query] = hash.split('?');
      setRoute({ path, params: new URLSearchParams(query || '') });
    };

    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  const navigate = (path: string, params: Record<string, string> = {}) => {
    const query = new URLSearchParams(params).toString();
    window.location.hash = query ? `${path}?${query}` : path;
  };

  return { route, navigate };
}

export default function App() {
  const { route, navigate } = useHashRouter();

  const isPlayerPage = route.path === 'player';

  return (
    <RouterProvider navigate={navigate}>
      <div className="min-h-screen bg-[#03060c]">
        {!isPlayerPage && <AppHeader navigate={navigate} />}
        <main className={isPlayerPage ? '' : 'px-4 md:px-6 xl:px-10 2xl:px-12 py-6'}>
          {route.path === 'home' && <HomePage navigate={navigate} />}
          {route.path === 'title' && (
            <TitlePage
              navigate={navigate}
              kind={route.params.get('kind') || 'movie'}
              id={route.params.get('id') || ''}
            />
          )}
          {route.path === 'see-all' && (
            <SeeAllPage
              navigate={navigate}
              title={route.params.get('title') || 'Browse'}
              api={route.params.get('api') || ''}
              kind={route.params.get('kind') || 'movie'}
            />
          )}
          {route.path === 'watch' && (
            <WatchPage
              navigate={navigate}
              params={Object.fromEntries(route.params)}
            />
          )}
          {route.path === 'player' && (
            <PlayerPage
              navigate={navigate}
              params={Object.fromEntries(route.params)}
            />
          )}
        </main>
      </div>
    </RouterProvider>
  );
}



