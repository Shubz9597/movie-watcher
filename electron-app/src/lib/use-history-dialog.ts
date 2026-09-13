import { useCallback, useEffect, useState } from 'react';

// A same-route entry gives WebKit's edge gesture a modal to dismiss before
// it goes back to the previous page. Selecting a result reuses that entry.
export function useHistoryDialog(name: string) {
  const [open, setOpen] = useState(() => window.history.state?.torwatchOverlay === name);
  useEffect(() => {
    const sync = () => setOpen(window.history.state?.torwatchOverlay === name);
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, [name]);
  const changeOpen = useCallback((next: boolean) => {
    if (next && window.history.state?.torwatchOverlay !== name) {
      window.history.pushState({ ...window.history.state, torwatchOverlay: name }, '');
    } else if (!next && window.history.state?.torwatchOverlay === name) {
      window.history.back();
    }
    setOpen(next);
  }, [name]);
  return { open, changeOpen };
}
