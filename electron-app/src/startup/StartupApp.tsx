import { useEffect, useState } from 'react';
import appIcon from '../assets/torwatch-app-icon.png';
import type { StartupApi } from './bridge';

type StartupAppProps = {
  api: StartupApi;
};

export function StartupApp({ api }: StartupAppProps) {
  const [status, setStatus] = useState('Preparing TorWatch...');

  useEffect(() => {
    api.onStatus(setStatus);
  }, [api]);

  return (
    <main>
      <img className="mark" src={appIcon} alt="" />
      <h1>Starting application</h1>
      <p id="status">{status}</p>
    </main>
  );
}
