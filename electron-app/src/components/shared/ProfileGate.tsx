// "Who's watching?" (profiles, lib/services/profile-service.ts). Shown on
// start when the server has two or more profiles and this device hasn't
// picked one, and from the profile button in the header. Picking a profile
// reloads the app so every list (Continue Watching, library, picks) is that
// profile's. Managing: anyone adds a profile; the server's owner (by
// Tailscale login) renames or removes any, others their own.
import { userMessage } from '../../lib/user-error';
import { useCallback, useEffect, useState } from 'react';
import { Pencil, Plus, X } from 'lucide-react';
import { FOCUS_RING_CLASS } from '../../lib/design-tokens';
import {
  OPEN_PROFILES_EVENT, PROFILE_COLORS, createProfile, deleteProfile, loadProfiles, selectProfile, updateProfile,
  type Profile, type ProfilesState,
} from '../../lib/services/profile-service';

const CURRENT_KEY = 'torwatch_profile_v1';

/** The profile this device uses, as last seen (header button). */
export function cachedProfile(): Pick<Profile, 'id' | 'name' | 'color'> | null {
  try {
    return JSON.parse(localStorage.getItem(CURRENT_KEY) || 'null');
  } catch {
    return null;
  }
}

function remember(profile: Pick<Profile, 'id' | 'name' | 'color'> | null): void {
  try {
    if (profile) localStorage.setItem(CURRENT_KEY, JSON.stringify({ id: profile.id, name: profile.name, color: profile.color }));
    else localStorage.removeItem(CURRENT_KEY);
  } catch {
    // Storage full: the button shows a plain icon.
  }
}

function Avatar({ profile, size = 'h-24 w-24 text-4xl' }: { profile: Pick<Profile, 'name' | 'color'>; size?: string }) {
  return (
    <span aria-hidden="true" className={`${size} inline-flex items-center justify-center rounded-xl font-semibold text-white`} style={{ backgroundColor: profile.color }}>
      {profile.name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}

export function ProfileButton({ className = '' }: { className?: string }) {
  const [profile, setProfile] = useState(cachedProfile);
  useEffect(() => {
    const update = () => setProfile(cachedProfile());
    window.addEventListener('torwatch:profile-changed', update);
    return () => window.removeEventListener('torwatch:profile-changed', update);
  }, []);
  if (!profile) return null;
  return (
    <button
      type="button"
      aria-label={`Profile: ${profile.name}. Switch profile`}
      title={`${profile.name} · Switch profile`}
      onClick={() => window.dispatchEvent(new CustomEvent(OPEN_PROFILES_EVENT))}
      className={`inline-flex h-11 w-11 items-center justify-center rounded-full ${FOCUS_RING_CLASS} ${className}`}
    >
      <Avatar profile={profile} size="h-8 w-8 text-sm" />
    </button>
  );
}

type Editing = { id: string | null; name: string; color: string; canDelete: boolean };

export function ProfileGate() {
  const [state, setState] = useState<ProfilesState | null>(null);
  const [open, setOpen] = useState(false);
  const [forced, setForced] = useState(false);
  const [managing, setManaging] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async (): Promise<ProfilesState | null> => {
    const next = await loadProfiles();
    setState(next);
    if (next) {
      const current = next.profiles.find((profile) => profile.id === (next.current ?? 'household')) ?? next.profiles[0] ?? null;
      // The header's button shows it (and opens this screen to add more).
      remember(current);
      window.dispatchEvent(new CustomEvent('torwatch:profile-changed'));
    }
    return next;
  }, []);

  useEffect(() => {
    void refresh().then((next) => {
      if (next && next.profiles.length >= 2 && next.current === null) {
        setForced(true);
        setOpen(true);
      }
    });
    const openPicker = () => {
      setForced(false);
      setManaging(false);
      setOpen(true);
      void refresh();
    };
    window.addEventListener(OPEN_PROFILES_EVENT, openPicker);
    return () => window.removeEventListener(OPEN_PROFILES_EVENT, openPicker);
  }, [refresh]);

  if (!open || !state) return null;

  const choose = async (profile: Profile) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await selectProfile(profile.id);
      remember(profile);
      // Every list on screen belongs to the old profile: start fresh.
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t switch profile.');
      setBusy(false);
    }
  };

  const save = async () => {
    if (!editing || busy) return;
    const name = editing.name.trim();
    if (!name) {
      setError('Give the profile a name.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      if (editing.id) await updateProfile(editing.id, { name, color: editing.color });
      else await createProfile(name, editing.color);
      setEditing(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t save the profile.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!editing?.id || busy) return;
    setBusy(true);
    setError('');
    try {
      await deleteProfile(editing.id);
      setEditing(null);
      const next = await refresh();
      // This device used it: it goes back to choosing.
      if (next && next.current === null && next.profiles.length >= 2) setForced(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t remove the profile.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="Who's watching?" className="fixed inset-0 z-[100] flex flex-col items-center overflow-y-auto bg-[#0a0a0a] px-6 pb-[max(2rem,var(--app-safe-bottom))] pt-[max(3rem,var(--app-safe-top))] text-white">
      {!forced ? (
        <button type="button" aria-label="Close" onClick={() => setOpen(false)} className={`absolute right-4 top-[max(1rem,var(--app-safe-top))] inline-flex h-12 w-12 items-center justify-center rounded-full text-white/75 hover:bg-white/[0.08] ${FOCUS_RING_CLASS}`}>
          <X className="h-6 w-6" aria-hidden="true" />
        </button>
      ) : null}
      {editing ? (
        <div className="mt-8 w-full max-w-sm">
          <h1 className="text-2xl font-semibold">{editing.id ? 'Edit profile' : 'Add profile'}</h1>
          <div className="mt-6 flex justify-center"><Avatar profile={{ name: editing.name || '?', color: editing.color }} /></div>
          <label className="type-secondary mt-6 block text-white/70" htmlFor="profileName">Name</label>
          <input
            id="profileName"
            value={editing.name}
            maxLength={40}
            autoFocus
            onChange={(event) => setEditing({ ...editing, name: event.target.value })}
            className="mt-2 min-h-12 w-full rounded-lg border border-white/15 bg-black/30 px-3.5 text-base text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
          />
          <div className="mt-4 flex flex-wrap gap-3" role="radiogroup" aria-label="Colour">
            {PROFILE_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                role="radio"
                aria-checked={editing.color === color}
                aria-label={color}
                onClick={() => setEditing({ ...editing, color })}
                className={`h-10 w-10 rounded-full ${editing.color === color ? 'ring-2 ring-white ring-offset-2 ring-offset-[#0a0a0a]' : ''} ${FOCUS_RING_CLASS}`}
                style={{ backgroundColor: color }}
              />
            ))}
          </div>
          {error ? <p role="alert" className="type-secondary mt-4 text-red-300">{userMessage(error, 'Couldn’t save the profile.')}</p> : null}
          <div className="mt-6 flex flex-col gap-3">
            <button type="button" disabled={busy} onClick={() => void save()} className="min-h-12 rounded-lg bg-white px-5 text-sm font-medium text-black disabled:opacity-40">Save</button>
            {editing.id && editing.canDelete ? (
              <button type="button" disabled={busy} onClick={() => void remove()} className="min-h-12 rounded-lg border border-red-500/60 px-5 text-sm text-red-300 disabled:opacity-40">
                Remove profile and its history
              </button>
            ) : null}
            <button type="button" disabled={busy} onClick={() => { setEditing(null); setError(''); }} className="min-h-12 rounded-lg border border-white/20 px-5 text-sm text-white/85">Cancel</button>
          </div>
        </div>
      ) : (
        <>
          <h1 className="mt-8 text-3xl font-semibold">{managing ? 'Manage profiles' : 'Who’s watching?'}</h1>
          <ul className="mt-10 grid w-full max-w-3xl grid-cols-2 justify-items-center gap-8 sm:grid-cols-3 md:grid-cols-4">
            {state.profiles.map((profile) => {
              const disabled = busy || (managing && !profile.canManage);
              return (
                <li key={profile.id}>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => managing
                      ? setEditing({ id: profile.id, name: profile.name, color: profile.color, canDelete: profile.id !== 'household' })
                      : void choose(profile)}
                    className={`group flex flex-col items-center gap-3 disabled:opacity-40 ${FOCUS_RING_CLASS}`}
                  >
                    <span className="relative">
                      <Avatar profile={profile} />
                      {managing && profile.canManage ? (
                        <span className="absolute inset-0 flex items-center justify-center rounded-xl bg-black/50"><Pencil className="h-7 w-7" aria-hidden="true" /></span>
                      ) : null}
                    </span>
                    <span className={`text-base ${state.current === profile.id ? 'font-semibold text-white' : 'text-white/75'}`}>{profile.name}</span>
                  </button>
                </li>
              );
            })}
            {state.profiles.length < state.max ? (
              <li>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setEditing({ id: null, name: '', color: PROFILE_COLORS[state.profiles.length % PROFILE_COLORS.length], canDelete: false })}
                  className={`flex flex-col items-center gap-3 ${FOCUS_RING_CLASS}`}
                >
                  <span className="inline-flex h-24 w-24 items-center justify-center rounded-xl border-2 border-dashed border-white/30 text-white/60"><Plus className="h-10 w-10" aria-hidden="true" /></span>
                  <span className="text-base text-white/75">Add profile</span>
                </button>
              </li>
            ) : null}
          </ul>
          {error ? <p role="alert" className="type-secondary mt-6 text-red-300">{userMessage(error, 'Couldn’t change profiles.')}</p> : null}
          <button
            type="button"
            onClick={() => { setManaging(!managing); setError(''); }}
            className={`mt-12 min-h-12 rounded-lg border border-white/30 px-6 text-sm tracking-wide text-white/80 hover:border-white ${FOCUS_RING_CLASS}`}
          >
            {managing ? 'Done' : 'Manage profiles'}
          </button>
          {managing && state.me.login ? (
            <p className="type-secondary mt-4 text-center text-white/50">
              Signed in to Tailscale as {state.me.name || state.me.login}{state.me.owner ? ' · owner: you can change every profile' : ''}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
