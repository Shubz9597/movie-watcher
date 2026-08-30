import torWatchIcon from '../../build/torwatch-icon.png';

export default function WindowChrome() {
  return (
    <div className="window-chrome" role="presentation">
      <div className="window-chrome__identity">
        <img
          src={torWatchIcon}
          alt=""
          aria-hidden="true"
          draggable={false}
          className="window-chrome__icon"
        />
        <span className="window-chrome__title">TorWatch</span>
      </div>
    </div>
  );
}
