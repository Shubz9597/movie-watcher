// Pure launch policy (offline-downloads C01, spec C2 "launch decisions").
//
// Deterministic and reachability-free BY CONSTRUCTION: the input type has no
// connection status. Reachability is a separate observable used for
// contextual availability (ConnectionChip, per-page recovery) and NEVER
// chooses a tab, never gates the shell, and never triggers a redirect.
// The previous three-second routing deadline / interaction-latch proposal is
// deleted: there is no connection-triggered navigation to arbitrate.
//
// Kept free of JSX/React so deterministic node tests can import it directly
// (node --test strip-types cannot load .tsx modules).

/** Saved server configuration, read from storage before any network work. */
export type ConfigurationState =
  | { kind: 'missing' }      // no saved server address (first installation)
  | { kind: 'read-error' }   // storage failed — a recovery state, never first install
  | { kind: 'present'; origin: string };

/** Local download inventory, read from the native/adapter store without network. */
export type LocalInventoryState =
  | { kind: 'empty' }        // read succeeded; zero completed downloads
  | { kind: 'ready-exists' } // at least one completed download is playable offline
  | { kind: 'read-error' };  // must surface a storage error, never imply zero downloads

/** Explicit launch intent from a notification or OS deep link. */
export type DeepLinkIntent =
  | { kind: 'none' }
  | { kind: 'downloads' }         // Downloads deep link wins over tab restoration
  | { kind: 'expired-playback' }; // expired playback routes are NOT auto-resumed

export type RestorableTab = 'home' | 'library' | 'search' | 'downloads';

export type LaunchDecision =
  | { surface: 'setup' }                                       // WF01
  | { surface: 'downloads' }                                   // local files, no server needed
  | { surface: 'config-error' }                                // storage recovery, not WF01
  | { surface: 'shell'; tab: RestorableTab; inventoryError: boolean };

export type LaunchPolicyInput = {
  configuration: ConfigurationState;
  inventory: LocalInventoryState;
  savedTab: string | null;
  deepLink: DeepLinkIntent;
  /** Whether this client exposes the Downloads destination (native downloads capability). */
  downloadsTabAvailable: boolean;
};

const RESTORABLE_TABS: readonly string[] = ['home', 'library', 'search', 'downloads'];

/** Restore the last valid tab, otherwise Home. A saved tab this client cannot
 *  show (e.g. Downloads on a client without the native capability) falls back
 *  to Home instead of silently hiding where the user landed. */
export function resolveRestoredTab(savedTab: string | null, downloadsTabAvailable: boolean): RestorableTab {
  if (savedTab && RESTORABLE_TABS.includes(savedTab)) {
    if (savedTab !== 'downloads' || downloadsTabAvailable) {
      return savedTab as RestorableTab;
    }
  }
  return 'home';
}

/**
 * resolveLaunch: the ONLY decision point for the initial surface.
 *
 * Precedence:
 *   1. Downloads deep link (notification tap) — wins over tab restoration and
 *      over first-run setup only when local files may exist; the Downloads
 *      surface itself owns the storage-error and empty states.
 *   2. Configuration read error — recovery state; never WF01 (which would
 *      imply the user must set up again) and never a config wipe.
 *   3. Saved configuration — shell immediately at the restored tab. Checks
 *      pending, unreachable, incompatible: the decision is identical, because
 *      reachability is not an input.
 *   4. No saved configuration — Downloads if completed local files exist
 *      (orphaned files stay accessible; setup lives in Settings), else WF01.
 */
export function resolveLaunch(input: LaunchPolicyInput): LaunchDecision {
  const { configuration, inventory, savedTab, deepLink, downloadsTabAvailable } = input;

  if (deepLink.kind === 'downloads') {
    // The Downloads page renders its own storage-error state when the
    // inventory read failed; that is still the correct destination.
    return { surface: 'downloads' };
  }
  // Expired playback routes are never auto-resumed; they are ignored here and
  // the normal policy applies. (Live playback intent goes through the player
  // route explicitly, with its own lease validation.)

  if (configuration.kind === 'read-error') {
    return { surface: 'config-error' };
  }

  if (configuration.kind === 'present') {
    return {
      surface: 'shell',
      tab: resolveRestoredTab(savedTab, downloadsTabAvailable),
      // A failed local inventory read surfaces the storage error inside the
      // shell; it never blocks launch and never reads as "no downloads".
      inventoryError: inventory.kind === 'read-error',
    };
  }

  // configuration.kind === 'missing'
  if (inventory.kind === 'ready-exists') {
    return { surface: 'downloads' };
  }
  // 'empty' or 'read-error': first installation. The setup screen makes no
  // claim about local downloads either way.
  return { surface: 'setup' };
}
