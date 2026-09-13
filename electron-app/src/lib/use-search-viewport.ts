import { useEffect, useState } from 'react';

// iOS changes the visible viewport when its keyboard opens. Keep the search
// frame inside that viewport; only the results pane is allowed to scroll.
export function useSearchViewport(active: boolean) {
  const [frame, setFrame] = useState({ height: window.innerHeight, top: 0 });
  useEffect(() => {
    if (!active) return;
    const viewport = window.visualViewport;
    const update = () => setFrame({ height: viewport?.height ?? window.innerHeight, top: viewport?.offsetTop ?? 0 });
    const previous = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    update();
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    return () => {
      document.documentElement.style.overflow = previous;
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [active]);
  return frame;
}
