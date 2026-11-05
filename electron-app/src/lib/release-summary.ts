// A source row's readable line: what a viewer chooses by, from the release
// name ("Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX" ->
// "4K · Dolby Vision · Atmos · Web"). Only what the name states; nothing is
// guessed. The full name stays available under Details.

const has = (name: string, pattern: RegExp) => pattern.test(name);

export function releaseFeatures(name: string, quality?: string | null): string[] {
  const features: string[] = [];
  const q = (quality ?? '').toLowerCase();
  if (q === '2160p' || has(name, /\b(2160p|4k|uhd)\b/i)) features.push('4K');
  else if (q === '1080p' || has(name, /\b1080p\b/i)) features.push('HD 1080p');
  else if (q === '720p' || has(name, /\b720p\b/i)) features.push('HD 720p');
  else if (has(name, /\b(480p|576p|sd)\b/i)) features.push('SD');

  if (has(name, /\b(dv|dovi|dolby[ ._-]?vision)\b/i)) features.push('Dolby Vision');
  else if (has(name, /\bhdr10\+|\bhdr10plus\b/i)) features.push('HDR10+');
  else if (has(name, /\bhdr(10)?\b/i)) features.push('HDR');

  if (has(name, /\batmos\b/i)) features.push('Atmos');
  else if (has(name, /\b(ddp|dd\+|eac3|e-ac-3)[ ._]?(5[ ._]1|7[ ._]1)\b|\b(dts[ ._-]?hd|truehd)\b/i)) features.push('5.1');
  else if (has(name, /\b(5[ ._]1|7[ ._]1)\b/)) features.push('5.1');

  if (has(name, /\b(remux)\b/i)) features.push('Remux');
  else if (has(name, /\b(blu[ ._-]?ray|bdrip|brrip)\b/i)) features.push('Blu-ray');
  else if (has(name, /\b(web[ ._-]?dl|webrip|web)\b/i)) features.push('Web');
  else if (has(name, /\bhdtv\b/i)) features.push('TV');
  else if (has(name, /\b(cam|hdcam|ts|telesync|hdts)\b/i)) features.push('Camera copy');
  return features;
}
