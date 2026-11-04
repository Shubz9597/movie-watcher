// Whether a film is out yet, like the episode list's "Coming soon":
//   upcoming  before its release date: nothing to play, no sources searched;
//   theatres  released but not yet out to stream or buy (digital release in
//             the future): sources are usually camera copies;
//   released  out, or the dates are unknown.
// Dates are YYYY-MM-DD (server catalog), read as local midnight.

export type MovieRelease =
  | { state: 'upcoming'; releaseDate: string; digitalRelease: string | null }
  | { state: 'theatres'; digitalRelease: string }
  | { state: 'released' };

function dayStart(value?: string | null): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const time = Date.parse(`${value.slice(0, 10)}T00:00:00`);
  return Number.isFinite(time) ? time : null;
}

export function movieRelease(dates: { releaseDate?: string | null; digitalRelease?: string | null }, now = Date.now()): MovieRelease {
  const release = dayStart(dates.releaseDate);
  const digital = dayStart(dates.digitalRelease);
  if (release !== null && release > now) {
    return { state: 'upcoming', releaseDate: dates.releaseDate!.slice(0, 10), digitalRelease: digital !== null ? dates.digitalRelease!.slice(0, 10) : null };
  }
  // Out to stream before (or without) a cinema date: it is out.
  if (digital !== null && digital > now && release !== null) {
    return { state: 'theatres', digitalRelease: dates.digitalRelease!.slice(0, 10) };
  }
  return { state: 'released' };
}

/** "18 Dec 2026" in the viewer's locale. */
export function formatReleaseDate(value: string): string {
  const time = dayStart(value);
  if (time === null) return value;
  return new Date(time).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
