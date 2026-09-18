import { useEffect, useState } from 'react';

// iOS changes the visible viewport when its keyboard opens. Keep the search
// frame inside that viewport; only the results pane is allowed to scroll.
export function useSearchViewport(active: boolean) {
  const [frame, setFrame] = useState({ height: window.innerHeight, top: 0, keyboardOpen: false });
  useEffect(() => {
    if (!active) return;
    const viewport = window.visualViewport;
    let fullHeight = window.innerHeight;
    let width = window.innerWidth;
    let keyboardOpen = false;
    const update = () => {
      const height = viewport?.height ?? window.innerHeight;
      const editing = document.activeElement?.matches('input, textarea, [contenteditable="true"]') ?? false;
      if (Math.abs(window.innerWidth - width) > 100) {
        fullHeight = window.innerHeight;
        width = window.innerWidth;
      }
      if (!editing && !keyboardOpen) fullHeight = window.innerHeight;
      fullHeight = Math.max(fullHeight, height);
      // Focus alone is insufficient (hardware keyboards). A real viewport
      // reduction is required; keep chrome hidden during keyboard dismissal.
      keyboardOpen = (editing || keyboardOpen) && fullHeight - height > 120 && (viewport?.scale ?? 1) < 1.1;
      const top = viewport?.offsetTop ?? 0;
      // Perf (mobile): visualViewport scroll fires continuously while the
      // keyboard opens/closes; skip the state write (and the AppShell
      // re-render) when nothing actually changed.
      setFrame((previous) => (
        previous.height === height && previous.top === top && previous.keyboardOpen === keyboardOpen
          ? previous
          : { height, top, keyboardOpen }
      ));
    };
    const previous = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    update();
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', update);
    return () => {
      document.documentElement.style.overflow = previous;
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      document.removeEventListener('focusin', update);
      document.removeEventListener('focusout', update);
    };
  }, [active]);
  return frame;
}
