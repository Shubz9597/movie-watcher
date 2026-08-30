import { useState } from 'react';
import type { FormEvent } from 'react';
import type { SubtitleState, SubtitleTrack } from '../types';

type Props = {
  activeSubtitleUrl: string | null;
  loadingSubtitleUrl: string | null;
  state: SubtitleState;
  onChoose: (track: SubtitleTrack) => void;
  onDisable: () => void;
  onConfigure: (apiKey: string) => Promise<{ ok: boolean; error?: string }>;
  onOpenGuide: () => void;
};

export function SubtitleMenu({ activeSubtitleUrl, loadingSubtitleUrl, state, onChoose, onDisable, onConfigure, onOpenGuide }: Props) {
  const [isConfiguring, setIsConfiguring] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);
  const [configurationError, setConfigurationError] = useState('');
  const tracks = state.tracks.filter((track) => ['en', 'eng', 'und', ''].includes(String(track.lang || '').toLowerCase()));
  const providerConfigured = state.providerConfigured !== false;

  const beginConfiguration = () => {
    setConfigurationError('');
    setIsConfiguring(true);
  };

  const submitConfiguration = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const credential = apiKey.trim();
    if (!credential) {
      setConfigurationError('Enter your OpenSubtitles API key.');
      return;
    }
    setConfigurationError('');
    setIsConnecting(true);
    const result = await onConfigure(credential);
    setIsConnecting(false);
    if (!result.ok) {
      setConfigurationError(result.error || 'OpenSubtitles could not be connected.');
      return;
    }
    setApiKey('');
    setIsConfiguring(false);
  };

  const configureButton = (
    <button type="button" onClick={beginConfiguration}>Add OpenSubtitles</button>
  );

  return (
    <div className="track-menu subtitle-menu" id="subtitleMenu" role="dialog" aria-label="Subtitle selection">
      <div className="subtitle-browser-head">
        <div>
          <div className="subtitle-browser-title">Subtitles</div>
          <div className="subtitle-browser-note">Choose a subtitle for this video</div>
        </div>
        <button
          className={`subtitle-off${activeSubtitleUrl ? '' : ' active'}`}
          id="subtitleOff"
          type="button"
          disabled={!activeSubtitleUrl}
          aria-label="Turn subtitles off"
          onClick={onDisable}
        >
          {activeSubtitleUrl ? 'Turn off' : 'Off'}
        </button>
      </div>
      <div className="subtitle-browser-body">
        <nav className="subtitle-languages" aria-label="Subtitle languages">
          <button className="subtitle-language" type="button" aria-current="true">
            <span>English</span><span className="subtitle-count" id="subtitleCount">{tracks.length}</span>
          </button>
        </nav>
        <section className="subtitle-results" aria-label="English subtitle files">
          <div className="subtitle-results-head">
            <span>English files</span>
            <span className="track-source" id="subtitleSource" role="status" aria-live="polite">
              {state.status === 'loading' ? 'Checking' : state.source || 'Ready'}
            </span>
          </div>
          {!providerConfigured && state.status !== 'loading' && tracks.length > 0 ? (
            <div className="subtitle-provider-callout">
              <span>Showing subtitles included with the torrent.</span>
              {configureButton}
            </div>
          ) : null}
          {isConfiguring ? (
            <form className="subtitle-provider-form" onSubmit={submitConfiguration}>
              <label htmlFor="openSubtitlesApiKey">OpenSubtitles API key</label>
              <div className="subtitle-provider-fields">
                <input
                  id="openSubtitlesApiKey"
                  type="password"
                  value={apiKey}
                  autoComplete="new-password"
                  autoFocus
                  disabled={isConnecting}
                  placeholder="Paste API key"
                  onChange={(event) => setApiKey(event.target.value)}
                />
                <button type="submit" disabled={isConnecting}>{isConnecting ? 'Connecting…' : 'Connect'}</button>
              </div>
              <div className="subtitle-provider-help">
                <button type="button" disabled={isConnecting} onClick={onOpenGuide}>Get an API key</button>
                {configurationError ? <span role="alert">{configurationError}</span> : null}
              </div>
            </form>
          ) : null}
          <div className="subtitle-options" id="subtitleOptions" aria-busy={state.status === 'loading'}>
            {state.status === 'loading' ? <div className="track-empty">Finding English subtitles...</div> : null}
            {state.status !== 'loading' && tracks.length === 0 ? (
              <div className="track-empty">
                <span>{state.message || 'No English subtitle files were found.'}</span>
                {!providerConfigured && !isConfiguring ? configureButton : null}
              </div>
            ) : null}
            {tracks.map((track) => {
              const details = [
                track.source === 'torrent' ? 'Included in torrent' : 'OpenSubtitles',
                String(track.format || 'srt').toUpperCase(),
                track.downloadCount ? `${track.downloadCount.toLocaleString()} downloads` : '',
                track.trusted ? 'Trusted' : '',
                track.hearingImpaired ? 'HI' : '',
                track.movieHashMatched ? 'Hash match' : '',
              ].filter(Boolean);
              const isActive = activeSubtitleUrl === track.url;
              const isLoading = loadingSubtitleUrl === track.url;
              return (
                <button
                  className={`subtitle-option${isActive ? ' active' : ''}`}
                  key={track.url}
                  type="button"
                  onClick={() => onChoose(track)}
                >
                  <span className="subtitle-option-copy">
                    <span className="subtitle-option-name">{track.fileName || 'English subtitles'}</span>
                    <span className="subtitle-option-meta">{details.map((detail) => <span key={detail}>{detail}</span>)}</span>
                  </span>
                  <span className="subtitle-option-action">{isLoading ? 'Loading' : isActive ? 'Active' : 'Use'}</span>
                </button>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
