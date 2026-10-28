// "Download on Wi-Fi only" (Settings): the phone's downloader keeps video
// transfers off mobile data while it is on (the default). Hidden in app
// builds without the setting.
import { useEffect, useState } from 'react';
import { FOCUS_RING_CLASS } from '../lib/design-tokens';
import { getNativeDownloads } from './downloads-adapter';
import type { NativeNetworkRule } from '../platform/native-downloads';

export function WifiOnlySetting() {
  const [rule, setRule] = useState<NativeNetworkRule | null>(null);

  useEffect(() => {
    let active = true;
    const native = getNativeDownloads();
    if (!native?.getNetworkRule) return undefined;
    const read = () => native.getNetworkRule?.()
      .then((next) => { if (active) setRule(next); })
      .catch(() => {});
    void read();
    // Leaving or reaching Wi-Fi announces a downloads change.
    let handle: { remove: () => Promise<void> } | null = null;
    void native.addListener('downloadsChanged', () => void read()).then((listener) => {
      handle = listener;
      if (!active) void listener.remove();
    });
    return () => {
      active = false;
      void handle?.remove();
    };
  }, []);

  if (!rule) return null;
  const toggle = () => {
    const wifiOnly = !rule.wifiOnly;
    const previous = rule;
    setRule({ ...rule, wifiOnly });
    void getNativeDownloads()?.setNetworkRule?.({ wifiOnly })
      .then((next) => setRule(next))
      .catch(() => setRule(previous));
  };
  return (
    <button
      type="button"
      role="switch"
      aria-checked={rule.wifiOnly}
      onClick={toggle}
      className={`flex min-h-12 w-full items-center gap-3 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3.5 py-3 text-left ${FOCUS_RING_CLASS}`}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-white">Download on Wi-Fi only</span>
        <span className="type-secondary block text-white/60">
          {rule.wifiOnly
            ? rule.waitingForWifi ? 'Not on Wi-Fi: downloads wait' : 'Mobile data is never used'
            : 'Mobile data is used when there’s no Wi-Fi'}
        </span>
      </span>
      <span
        aria-hidden="true"
        className={`relative h-7 w-12 shrink-0 rounded-full transition ${rule.wifiOnly ? 'bg-green-500' : 'bg-white/20'}`}
      >
        <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white transition-all ${rule.wifiOnly ? 'left-[1.375rem]' : 'left-0.5'}`} />
      </span>
    </button>
  );
}
