type Props = {
  audioDelay: number;
  subtitleDelay: number;
  onChange: (kind: 'audio' | 'subtitle', value: number) => void;
};

function formatDelay(seconds: number) {
  const value = Math.abs(seconds) < 0.05 ? 0 : seconds;
  return `${value.toFixed(1)} s`;
}

export function SyncMenu({ audioDelay, subtitleDelay, onChange }: Props) {
  return (
    <div className="track-menu sync-menu" id="syncMenu" role="dialog" aria-label="Playback synchronization">
      <div className="track-menu-head"><span>Playback sync</span><span className="track-source">0.1s steps</span></div>
      <div className="sync-item">
        <div className="sync-copy"><span className="sync-label">Subtitles</span><span className="sync-hint">Z earlier / X later</span></div>
        <div className="sync-actions">
          <button className="sync-step" type="button" onClick={() => onChange('subtitle', subtitleDelay - 0.1)} aria-label="Show subtitles earlier">-</button>
          <output className="sync-value" id="subtitleDelayValue" aria-live="polite">{formatDelay(subtitleDelay)}</output>
          <button className="sync-step" type="button" onClick={() => onChange('subtitle', subtitleDelay + 0.1)} aria-label="Show subtitles later">+</button>
          <button className="sync-reset" type="button" onClick={() => onChange('subtitle', 0)} aria-label="Reset subtitle timing">Reset</button>
        </div>
      </div>
      <div className="sync-item">
        <div className="sync-copy"><span className="sync-label">Audio</span><span className="sync-hint">Shift+Z earlier / Shift+X later</span></div>
        <div className="sync-actions">
          <button className="sync-step" type="button" onClick={() => onChange('audio', audioDelay - 0.1)} aria-label="Play audio earlier">-</button>
          <output className="sync-value" id="audioDelayValue" aria-live="polite">{formatDelay(audioDelay)}</output>
          <button className="sync-step" type="button" onClick={() => onChange('audio', audioDelay + 0.1)} aria-label="Play audio later">+</button>
          <button className="sync-reset" type="button" onClick={() => onChange('audio', 0)} aria-label="Reset audio timing">Reset</button>
        </div>
      </div>
    </div>
  );
}
