import { AlertCircle, LoaderCircle, Settings2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { RuntimeState } from '../types/electron';
import { ACTION_PRIMARY_CLASS, ACTION_SECONDARY_CLASS } from '../lib/design-tokens';

export default function RuntimeStatusBar() {
  const [runtime, setRuntime] = useState<RuntimeState | null>(null);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;

    let active = true;
    void api.getRuntimeState().then((state) => {
      if (active) setRuntime(state);
    }).catch(() => {});
    const unsubscribe = api.onRuntimeState((state) => {
      if (active) setRuntime(state);
    });
    return () => {
      active = false;
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, []);

  if (!runtime || runtime.status === 'ready' || runtime.status === 'idle') return null;

  const starting = runtime.status === 'starting';
  const needsSetup = runtime.status === 'setup-required';

  const retry = async () => {
    const api = window.electronAPI;
    if (!api || starting) return;
    setRuntime({ status: 'starting', message: 'Starting playback services…', code: 'RUNTIME_STARTING' });
    const result = await api.retryRuntime();
    setRuntime(result.state);
  };

  return (
    <section
      className="sticky top-[104px] z-30 border-b border-white/[0.09] bg-[var(--surface-raised)]"
      role={runtime.status === 'error' ? 'alert' : 'status'}
      aria-live="polite"
    >
      <div className="mx-auto flex min-h-14 max-w-[1600px] flex-wrap items-center gap-x-4 gap-y-3 px-5 py-3 md:px-8 xl:px-12">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {starting ? (
            <LoaderCircle className="h-4 w-4 shrink-0 animate-spin text-[#ffc285]" aria-hidden="true" />
          ) : (
            <AlertCircle className="h-4 w-4 shrink-0 text-[#ffc285]" aria-hidden="true" />
          )}
          <p className="type-secondary min-w-0 text-pretty text-white/80">
            {runtime.message}
          </p>
        </div>

        {!starting ? (
          <div className="flex shrink-0 items-center gap-2">
            {!needsSetup ? (
              <button
                type="button"
                onClick={() => void retry()}
                className={ACTION_SECONDARY_CLASS}
              >
                Try again
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => void window.electronAPI?.openSetup()}
              className={ACTION_PRIMARY_CLASS}
            >
              <Settings2 className="h-4 w-4" aria-hidden="true" />
              Open settings
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
