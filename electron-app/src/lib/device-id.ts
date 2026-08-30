const DEVICE_ID_KEY = 'mw_device_id';
let transientDeviceId = '';

export function getDeviceId(): string {
  if (typeof window === 'undefined') return '';

  try {
    const existing = window.localStorage.getItem(DEVICE_ID_KEY);
    if (existing && existing !== 'null' && existing !== 'undefined') return existing;
  } catch (error) {
    console.warn('[DeviceId] Persistent storage is unavailable; using a session identity.', error);
  }

  if (transientDeviceId) return transientDeviceId;

  const value = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  transientDeviceId = value;
  try {
    window.localStorage.setItem(DEVICE_ID_KEY, value);
  } catch (error) {
    console.warn('[DeviceId] Could not persist the session identity.', error);
  }
  return value;
}
