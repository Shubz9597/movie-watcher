// Mark only this app's history entries so Back never leaves a directly
// opened page. The native iOS edge gesture uses the same browser history.
const INDEX_KEY = 'torwatchHistoryIndex';
type NavigationWindow = Pick<Window, 'history' | 'location' | 'dispatchEvent'>;

function index(target: NavigationWindow): number {
  const value = target.history.state?.[INDEX_KEY];
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

export function initializeHashNavigation(target: NavigationWindow): void {
  target.history.replaceState({ ...target.history.state, [INDEX_KEY]: index(target) }, '');
}

export function navigateHash(target: NavigationWindow, path: string, params: Record<string, string> = {}, replace = false): void {
  const query = new URLSearchParams(params).toString();
  const hash = `#${path}${query ? `?${query}` : ''}`;
  // If a search result is the current page, its dialog's close handler owns
  // the single history.back() call (browser traversal is asynchronous).
  if (target.location.hash === hash) return;
  const state = { [INDEX_KEY]: replace ? index(target) : index(target) + 1 };
  if (replace || target.history.state?.torwatchOverlay) target.history.replaceState(state, '', hash);
  else target.history.pushState(state, '', hash);
  // pushState does not emit hashchange; native back/forward emits popstate.
  target.dispatchEvent(new Event('hashchange'));
}

export function goBackHash(target: NavigationWindow): void {
  if (index(target) > 0) target.history.back();
  else navigateHash(target, 'home', {}, true);
}
