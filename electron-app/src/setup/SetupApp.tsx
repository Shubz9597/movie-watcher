import { FormEvent, useEffect, useMemo, useState } from 'react';
import appIcon from '../assets/torwatch-app-icon.png';
import type {
  CheckResult,
  CheckState,
  CredentialBadgeState,
  CredentialState,
  SetupApi,
  SetupDefaults,
  SetupFormValues,
  SetupModeState,
} from './types';

const emptyCredential: CredentialBadgeState = { state: '', message: '' };
const secretFields = ['tmdbKey', 'openSubApiKey', 'openSubUserToken', 'vpnPrivateKey'] as const;
type SecretField = typeof secretFields[number];

type CheckId = 'tmdb' | 'docker' | 'services';

const initialModeState: SetupModeState = {
  mode: 'settings',
  issue: '',
  hasSavedTmdbCredential: false,
};

const initialForm: SetupFormValues = {
  dataDir: '',
  tmdbKey: '',
  openSubApiKey: '',
  openSubUserToken: '',
  clearOpenSubUserToken: false,
  clearVpnConfiguration: false,
  vpnProvider: 'mullvad',
  vpnType: 'wireguard',
  vpnPrivateKey: '',
  vpnAddresses: '',
  serverCities: '',
};

const initialChecks: Record<CheckId, CheckResult> = {
  tmdb: { id: 'tmdb', state: 'waiting', message: 'Not checked' },
  docker: { id: 'docker', state: 'waiting', message: 'Waiting' },
  services: { id: 'services', state: 'waiting', message: 'Waiting' },
};

const checkMarks: Record<CheckState, string> = {
  waiting: '.',
  running: '...',
  passed: 'OK',
  failed: '!',
  skipped: '-',
};

type SetupAppProps = {
  api: SetupApi;
};

export function SetupApp({ api }: SetupAppProps) {
  const [defaults, setDefaults] = useState<SetupDefaults | null>(null);
  const [modeState, setModeState] = useState(initialModeState);
  const [form, setForm] = useState(initialForm);
  const [savedSecrets, setSavedSecrets] = useState<Set<SecretField>>(() => new Set());
  const [credentialStates, setCredentialStates] = useState<Record<SecretField, CredentialBadgeState>>({
    tmdbKey: emptyCredential,
    openSubApiKey: emptyCredential,
    openSubUserToken: emptyCredential,
    vpnPrivateKey: emptyCredential,
  });
  const [checks, setChecks] = useState(initialChecks);
  const [connectionVisible, setConnectionVisible] = useState(false);
  const [status, setStatus] = useState({ tone: '', message: '' });
  const [busy, setBusy] = useState(false);
  const [continueVisible, setContinueVisible] = useState(false);
  const [continueBusy, setContinueBusy] = useState(false);
  const [actionOverride, setActionOverride] = useState<string | null>(null);

  const gateMode = modeState.mode === 'tmdb-gate';
  const returningUser = Boolean(defaults?.setupComplete);
  const pageTitle = gateMode ? 'Connect TMDb' : returningUser ? 'TorWatch settings' : 'Set up TorWatch';
  const pageIntro = gateMode
    ? 'Movies and series stay locked until TMDb accepts your credential.'
    : returningUser
      ? 'Update your connections and storage location.'
      : 'Add a few details to start watching.';
  const actionLabel = actionOverride ?? (busy ? (gateMode ? 'Checking...' : 'Starting...') : gateMode ? 'Verify and continue' : returningUser ? 'Apply changes' : 'Start TorWatch');

  const visibleChecks = useMemo<CheckId[]>(() => (gateMode ? ['tmdb'] : ['tmdb', 'docker', 'services']), [gateMode]);

  useEffect(() => {
    document.body.dataset.mode = modeState.mode;
    document.title = gateMode ? 'Connect TMDb - TorWatch' : returningUser ? 'TorWatch settings' : 'Set up TorWatch';
  }, [gateMode, modeState.mode, returningUser]);

  useEffect(() => {
    let cancelled = false;

    api.getDefaults().then((nextDefaults) => {
      if (cancelled) return;
      setDefaults(nextDefaults);
      setForm((current) => ({
        ...current,
        dataDir: nextDefaults.dataDir ?? current.dataDir,
        vpnProvider: nextDefaults.vpnProvider ?? current.vpnProvider,
        vpnType: nextDefaults.vpnType ?? current.vpnType,
        vpnAddresses: nextDefaults.vpnAddresses ?? current.vpnAddresses,
        serverCities: nextDefaults.serverCities ?? current.serverCities,
      }));

      const nextSaved = new Set<SecretField>();
      const nextCredentialStates: Record<SecretField, CredentialBadgeState> = {
        tmdbKey: emptyCredential,
        openSubApiKey: emptyCredential,
        openSubUserToken: emptyCredential,
        vpnPrivateKey: emptyCredential,
      };
      if (nextDefaults.hasTmdbKey) {
        nextSaved.add('tmdbKey');
        nextCredentialStates.tmdbKey = { state: 'checking', message: 'Checking...' };
      }
      if (nextDefaults.hasOpenSubApiKey) {
        nextSaved.add('openSubApiKey');
        nextCredentialStates.openSubApiKey = { state: 'checking', message: 'Checking...' };
      }
      if (nextDefaults.hasOpenSubUserToken) {
        nextSaved.add('openSubUserToken');
        nextCredentialStates.openSubUserToken = { state: 'saved', message: 'Saved' };
      }
      if (nextDefaults.hasVpnPrivateKey) {
        nextSaved.add('vpnPrivateKey');
        nextCredentialStates.vpnPrivateKey = { state: 'saved', message: 'Saved' };
      }
      setSavedSecrets(nextSaved);
      setCredentialStates(nextCredentialStates);
      if (nextDefaults.setupComplete) setStatus({ tone: '', message: 'Settings are up to date.' });

      if (nextDefaults.hasTmdbKey || nextDefaults.hasOpenSubApiKey) {
        api.verifySavedCredentials().then((results) => {
          if (cancelled) return;
          setCredentialStates((current) => ({
            ...current,
            tmdbKey: results.tmdb ? results.tmdb : current.tmdbKey,
            openSubApiKey: results.openSubtitles ? results.openSubtitles : current.openSubApiKey,
          }));
        }).catch(() => {
          if (cancelled) return;
          setCredentialStates((current) => ({
            ...current,
            tmdbKey: nextDefaults.hasTmdbKey ? { state: 'failed', message: 'Could not check' } : current.tmdbKey,
            openSubApiKey: nextDefaults.hasOpenSubApiKey ? { state: 'failed', message: 'Could not check' } : current.openSubApiKey,
          }));
        });
      }
    });

    api.getMode().then((state) => {
      if (!cancelled) setModeState({ ...initialModeState, ...state });
    });
    api.onMode((state) => setModeState((current) => ({ ...current, ...state })));
    api.onStatus((message) => setStatus({ tone: '', message }));
    api.onCheck(updateCheck);

    return () => { cancelled = true; };
  }, [api]);

  useEffect(() => {
    if (gateMode) {
      setStatus({ tone: modeState.issue ? 'error' : '', message: modeState.issue || '' });
      return;
    }
    if (returningUser) setStatus({ tone: '', message: 'Settings are up to date.' });
  }, [gateMode, modeState.issue, returningUser]);

  function updateCheck(result: CheckResult) {
    const visibleId = result.id === 'backend' ? 'services' : result.id;
    if (visibleId !== 'tmdb' && visibleId !== 'docker' && visibleId !== 'services') return;
    setChecks((current) => ({
      ...current,
      [visibleId]: { ...result, id: visibleId },
    }));
  }

  function resetChecks() {
    setChecks(initialChecks);
    setContinueVisible(false);
  }

  function updateValue<K extends keyof SetupFormValues>(key: K, value: SetupFormValues[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    if (connectionVisible && !busy) {
      resetChecks();
      setConnectionVisible(false);
      setStatus({ tone: '', message: '' });
    }
  }

  function updateSecretValue(field: SecretField, value: string) {
    updateValue(field, value);
    if (value) {
      setCredential(field, 'changed', 'Unsaved change');
    } else if (savedSecrets.has(field)) {
      setCredential(field, 'saved', 'Saved');
    } else {
      setCredential(field, '', '');
    }
  }

  function setCredential(field: SecretField, state: CredentialState, message: string) {
    setCredentialStates((current) => ({
      ...current,
      [field]: { state, message },
    }));
  }

  async function chooseDataDirectory() {
    const selected = await api.chooseDataDirectory();
    if (selected) updateValue('dataDir', selected);
  }

  async function openTorWatch() {
    const result = await api.complete();
    if (!result.ok) {
      setStatus({ tone: 'error', message: result.error || 'TorWatch could not open.' });
      return false;
    }
    return true;
  }

  async function submitTmdbGate() {
    resetChecks();
    setConnectionVisible(true);
    updateCheck({ id: 'tmdb', state: 'running', message: 'Checking credential...' });
    setBusy(true);
    setActionOverride(null);
    setStatus({ tone: '', message: 'Connecting to TMDb...' });
    let result;
    try {
      result = await api.repairTmdb(form.tmdbKey);
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : 'TMDb could not be checked.' };
    } finally {
      setBusy(false);
    }
    if (!result.ok) {
      updateCheck({ id: 'tmdb', state: 'failed', message: result.error || 'Connection failed' });
      setStatus({ tone: 'error', message: result.error || 'TMDb could not be checked.' });
      setActionOverride('Try again');
      return;
    }
    updateCheck({ id: 'tmdb', state: 'passed', message: 'Connected' });
    setStatus({ tone: '', message: result.next === 'setup' ? 'TMDb connected. Finish setup.' : 'Connected.' });
  }

  async function submitSetup() {
    resetChecks();
    setConnectionVisible(true);
    setBusy(true);
    setActionOverride(null);
    setStatus({ tone: '', message: 'Starting application...' });
    let result;
    try {
      result = await api.test(form);
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : 'The setup check could not run.' };
    } finally {
      setBusy(false);
    }
    if (!result.ok) {
      setStatus({ tone: 'error', message: result.error || 'A connection check failed.' });
      setActionOverride('Try again');
      return;
    }
    if (result.warning) {
      setStatus({ tone: 'error', message: result.warning });
      setActionOverride('Try again');
      setContinueVisible(true);
      return;
    }
    setStatus({ tone: '', message: 'Ready.' });
    await openTorWatch();
  }

  async function submitForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (gateMode) await submitTmdbGate();
    else await submitSetup();
  }

  return (
    <>
      <div className="window-chrome" aria-hidden="true">
        <img src={appIcon} alt="" />
        <span>TorWatch</span>
      </div>

      <main>
        <header>
          <img className="brand-mark" src={appIcon} alt="" />
          <div className="header-copy">
            <h1>{pageTitle}</h1>
            <p className="intro">{pageIntro}</p>
          </div>
          {!gateMode && <button className="guide-button" type="button" onClick={() => void api.openGuide()} disabled={busy}>Help</button>}
        </header>

        <form onSubmit={(event) => void submitForm(event)}>
          <section aria-labelledby="general-heading">
            <div className="section-heading section-heading-row">
              <div>
                <h2 id="general-heading">{gateMode ? 'TMDb connection' : 'General'}</h2>
              </div>
              <button className="help-link" type="button" onClick={() => void api.openTmdbGuide()} disabled={busy}>
                Get a TMDb credential
              </button>
            </div>
            <div className="grid">
              {!gateMode && (
                <label className="wide">Application storage location
                  <div className="folder">
                    <input value={form.dataDir} onChange={(event) => updateValue('dataDir', event.target.value)} required disabled={busy} />
                    <button type="button" onClick={() => void chooseDataDirectory()} disabled={busy}>Browse</button>
                  </div>
                </label>
              )}
              <label className="wide">
                <span className="label-row">
                  <span>TMDb API key or read access token</span>
                  <CredentialBadge badge={credentialStates.tmdbKey} />
                </span>
                <input
                  value={form.tmdbKey}
                  type="password"
                  required={!modeState.hasSavedTmdbCredential && !defaults?.hasTmdbKey}
                  autoComplete="off"
                  spellCheck={false}
                  data-saved={savedSecrets.has('tmdbKey') ? 'true' : undefined}
                  placeholder={savedSecrets.has('tmdbKey') ? 'Saved - enter a replacement to change' : undefined}
                  onChange={(event) => updateSecretValue('tmdbKey', event.target.value)}
                  disabled={busy}
                />
                <span className="hint">A v3 API key is recommended. v4 read access tokens are also supported.</span>
              </label>
            </div>
          </section>

          {!gateMode && (
            <>
              <section aria-labelledby="subtitles-heading">
                <div className="section-heading section-heading-row">
                  <div>
                    <h2 id="subtitles-heading">Subtitles</h2>
                    <p className="section-copy">Connect OpenSubtitles to find subtitles.</p>
                  </div>
                  <button className="help-link" type="button" onClick={() => void api.openOpenSubtitlesGuide()} disabled={busy}>Get an API key</button>
                </div>
                <div className="grid">
                  <label className="wide">
                    <span className="label-row">
                      <span>OpenSubtitles API key <span className="optional">Optional</span></span>
                      <CredentialBadge badge={credentialStates.openSubApiKey} />
                    </span>
                    <input
                      value={form.openSubApiKey}
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      data-saved={savedSecrets.has('openSubApiKey') ? 'true' : undefined}
                      placeholder={savedSecrets.has('openSubApiKey') ? 'Saved - enter a replacement to change' : undefined}
                      onChange={(event) => updateSecretValue('openSubApiKey', event.target.value)}
                      disabled={busy}
                    />
                  </label>
                </div>
                <details>
                  <summary>Advanced OpenSubtitles settings</summary>
                  <div className="grid">
                    <label className="wide">
                      <span className="label-row">
                        <span>OpenSubtitles user token</span>
                        <CredentialBadge badge={credentialStates.openSubUserToken} />
                      </span>
                      <input
                        value={form.openSubUserToken}
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        data-saved={savedSecrets.has('openSubUserToken') ? 'true' : undefined}
                        placeholder={savedSecrets.has('openSubUserToken') ? 'Saved - enter a replacement to change' : undefined}
                        onChange={(event) => updateSecretValue('openSubUserToken', event.target.value)}
                        disabled={busy || form.clearOpenSubUserToken}
                      />
                    </label>
                    {savedSecrets.has('openSubUserToken') && (
                      <label className="clear-secret wide">
                        <input
                          checked={form.clearOpenSubUserToken}
                          type="checkbox"
                          onChange={(event) => updateValue('clearOpenSubUserToken', event.target.checked)}
                          disabled={busy}
                        />
                        <span>Clear the saved user token</span>
                      </label>
                    )}
                  </div>
                </details>
              </section>

              <section aria-labelledby="privacy-heading">
                <div className="section-heading section-heading-row">
                  <div>
                    <h2 id="privacy-heading">VPN <span className="optional">Optional</span></h2>
                    <p className="section-copy">Leave these blank to use your normal network or a system-wide VPN. Add WireGuard details only to route search services through TorWatch's embedded Gluetun tunnel.</p>
                  </div>
                  <button className="help-link" type="button" onClick={() => void api.openVpnGuide()} disabled={busy}>WireGuard setup help</button>
                </div>
                <div className="grid">
                  <label>VPN provider
                    <input value={form.vpnProvider} onChange={(event) => updateValue('vpnProvider', event.target.value)} spellCheck={false} disabled={busy || form.clearVpnConfiguration} />
                  </label>
                  <label className="wide">
                    <span className="label-row">
                      <span>WireGuard private key</span>
                      <CredentialBadge badge={credentialStates.vpnPrivateKey} />
                    </span>
                    <input
                      value={form.vpnPrivateKey}
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      data-saved={savedSecrets.has('vpnPrivateKey') ? 'true' : undefined}
                      placeholder={savedSecrets.has('vpnPrivateKey') ? 'Saved - enter a replacement to change' : undefined}
                      onChange={(event) => updateSecretValue('vpnPrivateKey', event.target.value)}
                      disabled={busy || form.clearVpnConfiguration}
                    />
                  </label>
                  <label>WireGuard address
                    <input value={form.vpnAddresses} placeholder="10.x.x.x/32" onChange={(event) => updateValue('vpnAddresses', event.target.value)} spellCheck={false} disabled={busy || form.clearVpnConfiguration} />
                  </label>
                  <label>
                    <span className="label-row"><span>Preferred server city</span><span className="optional">Optional</span></span>
                    <input value={form.serverCities} placeholder="Amsterdam" onChange={(event) => updateValue('serverCities', event.target.value)} disabled={busy || form.clearVpnConfiguration} />
                  </label>
                  {savedSecrets.has('vpnPrivateKey') && (
                    <label className="clear-secret wide">
                      <input
                        checked={form.clearVpnConfiguration}
                        type="checkbox"
                        onChange={(event) => updateValue('clearVpnConfiguration', event.target.checked)}
                        disabled={busy}
                      />
                      <span>Stop using the embedded VPN and use the normal/system-VPN route</span>
                    </label>
                  )}
                </div>
              </section>

              <section aria-labelledby="search-heading">
                <div className="section-heading">
                  <h2 id="search-heading">Search sources</h2>
                  <p className="section-copy">TorWatch adds a starter set of public movie, series, and anime sources. Advanced source management is available after services are running.</p>
                </div>
                <div className="button-row">
                  <button type="button" onClick={() => void api.openProwlarr()} disabled={busy}>Open source manager</button>
                  <button type="button" onClick={() => void api.openProwlarrGuide()} disabled={busy}>Read source guide</button>
                </div>
              </section>
            </>
          )}

          {connectionVisible && (
            <div className="connection-status">
              <h2>Starting application</h2>
              <ul className="checks" aria-label="Connection checks">
                {visibleChecks.map((id) => (
                  <CheckRow key={id} check={checks[id]} onDockerInstall={() => void api.installDocker()} />
                ))}
              </ul>
            </div>
          )}

          <div className="actions">
            <div id="status" className={status.tone} role="status" aria-live="polite">{status.message}</div>
            {continueVisible && !gateMode && (
              <button
                type="button"
                disabled={continueBusy}
                onClick={() => {
                  setContinueBusy(true);
                  void openTorWatch().then((opened) => {
                    if (!opened) setContinueBusy(false);
                  });
                }}
              >
                Open TorWatch
              </button>
            )}
            <button className={`primary${busy ? ' is-busy' : ''}`} type="submit" disabled={busy}>{actionLabel}</button>
          </div>
        </form>
      </main>
    </>
  );
}

type CredentialBadgeProps = {
  badge: CredentialBadgeState;
};

function CredentialBadge({ badge }: CredentialBadgeProps) {
  if (!badge.message) return null;
  return <span className={`credential-state ${badge.state}`}>{badge.message}</span>;
}

type CheckRowProps = {
  check: CheckResult;
  onDockerInstall: () => void;
};

function CheckRow({ check, onDockerInstall }: CheckRowProps) {
  const label = check.id === 'tmdb' ? 'TMDb' : check.id === 'docker' ? 'Docker Desktop' : 'TorWatch';
  return (
    <li className={`check-row ${check.state}`} data-check={check.id}>
      <span className="check-mark">{checkMarks[check.state]}</span>
      <span>{label}</span>
      <span className="check-message">{check.message}</span>
      {check.id === 'docker' && check.state === 'failed' && (
        <button className="check-action" type="button" onClick={onDockerInstall}>Get Docker Desktop</button>
      )}
    </li>
  );
}
