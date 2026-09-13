// SettingsOverlayController (M1.4 repair): the testable state machine behind
// the mobile settings overlay. The shell listens for the
// `torwatch:open-settings` custom event on ANY EventTarget (window in the
// app; a plain EventTarget in deterministic node tests). A same-route history
// entry lets the native iOS back gesture dismiss settings before leaving it.
export const OPEN_SETTINGS_EVENT = 'torwatch:open-settings';

type MinimalEventTarget = {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
};

export class SettingsOverlayController {
  private openState = false;
  private readonly listeners = new Set<(open: boolean) => void>();
  private readonly target: MinimalEventTarget;
  private readonly history?: History;
  private readonly listener = (): void => {
    if (this.openState) return;
    this.history?.pushState({ ...this.history.state, torwatchOverlay: 'settings' }, '');
    this.setOpen(true);
  };
  private readonly onPopState = (): void => this.setOpen(this.history?.state?.torwatchOverlay === 'settings');

  constructor(target: MinimalEventTarget, history?: History) {
    this.target = target;
    this.history = history;
    this.openState = history?.state?.torwatchOverlay === 'settings';
    this.target.addEventListener(OPEN_SETTINGS_EVENT, this.listener);
    if (history) this.target.addEventListener('popstate', this.onPopState);
  }

  isOpen(): boolean {
    return this.openState;
  }

  subscribe(callback: (open: boolean) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /** Programmatic close (ServerSettings "Back" / successful save). */
  close(): void {
    if (this.history?.state?.torwatchOverlay === 'settings') this.history.back();
    this.setOpen(false);
  }

  /** Detach from the event target; idempotent. */
  dispose(): void {
    this.target.removeEventListener(OPEN_SETTINGS_EVENT, this.listener);
    this.target.removeEventListener('popstate', this.onPopState);
    this.listeners.clear();
  }

  private setOpen(open: boolean): void {
    if (this.openState === open) return; // repeated navigations are idempotent
    this.openState = open;
    for (const callback of Array.from(this.listeners)) {
      try {
        callback(open);
      } catch {
        // subscriber errors never break the overlay lifecycle
      }
    }
  }
}
