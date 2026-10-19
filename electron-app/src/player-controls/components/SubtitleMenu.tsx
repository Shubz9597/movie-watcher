import { useState } from 'react';
import type { FormEvent } from 'react';
import type { PlayerTrack } from '../../lib/player-tracks';
import type { SubtitleState, SubtitleTrack } from '../types';

// Audio and subtitles in one panel, named as on the phone: "Japanese
// [Original]", "English (CC)", "English (Dub)". The video's own subtitles
// come first; online files are a step away unless the video has none.

type Props = {
  audio: { tracks: PlayerTrack[]; names: string[]; selected: number | null; onChoose: (track: PlayerTrack) => void };
  embedded: { tracks: PlayerTrack[]; names: string[]; selected: number | null; loading: boolean; onChoose: (track: PlayerTrack) => void };
  matchedDub: { name: string; url: string; onChoose: () => void } | null;
  activeSubtitleUrl: string | null;
  loadingSubtitleUrl: string | null;
  state: SubtitleState;
  onChoose: (track: SubtitleTrack) => void;
  onDisable: () => void;
  onConfigure: (apiKey: string) => Promise<{ ok: boolean; error?: string }>;
  onOpenGuide: () => void;
  onTextSize: (step: number) => void;
};

export function SubtitleMenu({ audio, embedded, matchedDub, activeSubtitleUrl, loadingSubtitleUrl, state, onChoose, onDisable, onConfigure, onOpenGuide, onTextSize }: Props) {
  const [isConfiguring, setIsConfiguring] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);
  const [configurationError, setConfigurationError] = useState('');
  const [showOnline, setShowOnline] = useState(false);
  const tracks = state.tracks.filter((track) => ['en', 'eng', 'und', ''].includes(String(track.lang || '').toLowerCase()));
  const providerConfigured = state.providerConfigured !== false;
  const onlineActive = Boolean(activeSubtitleUrl && tracks.some((track) => track.url === activeSubtitleUrl));
  const onlineOpen = showOnline || onlineActive || (!embedded.loading && embedded.tracks.length === 0);
  const subtitlesOff = activeSubtitleUrl === null && embedded.selected === null;

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
    <div className="track-menu subtitle-menu" id="subtitleMenu" role="dialog" aria-label="Audio and subtitles">
      <div className="subtitle-browser-head">
        <div className="subtitle-browser-title">Audio &amp; subtitles</div>
        <div className="subtitle-size" role="group" aria-label="Subtitle size">
          <span>Text size</span>
          <button type="button" aria-label="Smaller subtitles" onClick={() => onTextSize(-1)}>A−</button>
          <button type="button" aria-label="Larger subtitles" onClick={() => onTextSize(1)}>A+</button>
        </div>
      </div>
      <div className="subtitle-browser-body">
        <nav className="subtitle-languages" aria-label="Audio">
          <div className="subtitle-column-title">Audio</div>
          {audio.tracks.length === 0 ? (
            <button className="subtitle-language active" type="button" aria-current="true"><span>Default</span></button>
          ) : audio.tracks.map((track, index) => (
            <button
              key={track.id}
              className={`subtitle-language${audio.selected === track.id ? ' active' : ''}`}
              type="button"
              aria-current={audio.selected === track.id ? 'true' : undefined}
              onClick={() => audio.onChoose(track)}
            >
              <span>{audio.names[index]}</span>
            </button>
          ))}
        </nav>
        <section className="subtitle-results" aria-label="Subtitles">
          <div className="subtitle-column-title">Subtitles</div>
          <div className="subtitle-options">
            <button className={`subtitle-option${subtitlesOff ? ' active' : ''}`} id="subtitleOff" type="button" onClick={onDisable}>
              <span className="subtitle-option-copy"><span className="subtitle-option-name">Off</span></span>
              <span className="subtitle-option-action">{subtitlesOff ? 'Active' : ''}</span>
            </button>
            {embedded.tracks.map((track, index) => {
              const isActive = embedded.selected === track.id && activeSubtitleUrl === null;
              return (
                <button key={track.id} className={`subtitle-option${isActive ? ' active' : ''}`} type="button" onClick={() => embedded.onChoose(track)}>
                  <span className="subtitle-option-copy">
                    <span className="subtitle-option-name">{embedded.names[index]}</span>
                    <span className="subtitle-option-meta"><span>In the video</span></span>
                  </span>
                  <span className="subtitle-option-action">{isActive ? 'Active' : ''}</span>
                </button>
              );
            })}
            {matchedDub ? (
              <button className={`subtitle-option${activeSubtitleUrl === matchedDub.url ? ' active' : ''}`} type="button" onClick={matchedDub.onChoose}>
                <span className="subtitle-option-copy">
                  <span className="subtitle-option-name">{matchedDub.name}</span>
                  <span className="subtitle-option-meta"><span>Matched to this dub</span></span>
                </span>
                <span className="subtitle-option-action">
                  {loadingSubtitleUrl === matchedDub.url ? 'Loading' : activeSubtitleUrl === matchedDub.url ? 'Active' : ''}
                </span>
              </button>
            ) : null}
            {embedded.loading ? <div className="track-empty">Reading the video’s tracks…</div> : null}
          </div>

          {!onlineOpen ? (
            <button className="subtitle-online-toggle" type="button" onClick={() => setShowOnline(true)}>
              Search online subtitles{tracks.length > 0 ? ` (${tracks.length})` : ''}
            </button>
          ) : (
            <div className="subtitle-online">
              <div className="subtitle-results-head">
                <span>Online · English</span>
                <span className="track-source" id="subtitleSource" role="status" aria-live="polite">
                  {state.status === 'loading' ? 'Checking' : state.source || 'Ready'}
                </span>
              </div>
              {!providerConfigured && state.status !== 'loading' && tracks.length > 0 ? (
                <div className="subtitle-provider-callout">
                  <span>{tracks.some((track) => track.source !== 'torrent') ? 'From the free subtitle addon' : 'From the torrent only'}</span>
                  {configureButton}
                </div>
              ) : null}
              {state.status !== 'loading' && tracks.length > 0 && state.message ? (
                <div className="subtitle-provider-callout" role="status">{state.message}</div>
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
                {state.status === 'loading' ? <div className="track-empty">Finding subtitles…</div> : null}
                {state.status !== 'loading' && tracks.length === 0 ? (
                  <div className="track-empty">
                    <span>{state.message || 'No English subtitles found.'}</span>
                    {!providerConfigured && !isConfiguring ? configureButton : null}
                  </div>
                ) : null}
                {tracks.map((track) => {
                  const details = [
                    track.source === 'torrent' ? 'Included in torrent' : 'OpenSubtitles',
                    String(track.format || 'srt').toUpperCase(),
                    track.downloadCount ? `${track.downloadCount.toLocaleString()} downloads` : '',
                    track.trusted ? 'Trusted' : '',
                    track.hearingImpaired ? 'CC' : '',
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
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
