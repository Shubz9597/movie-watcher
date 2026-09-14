import torWatchLogo from '../../assets/torwatch-app-icon.png';

// Same dimensions, viewport center and background as LaunchScreen's first frame.
export function StartupSplash() {
  return (
    <main className="tw-startup-splash" role="status" aria-label="Starting TorWatch">
      <img src={torWatchLogo} width={96} height={96} alt="" aria-hidden="true" />
    </main>
  );
}
