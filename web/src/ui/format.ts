export function fmtDistance(m: number): string {
  if (!Number.isFinite(m)) return '∞';
  const a = Math.abs(m);
  if (a < 10_000) return `${Math.round(m).toLocaleString('en-US')} m`;
  return `${(m / 1000).toLocaleString('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 1 })} km`;
}

export function fmtSpeed(v: number): string {
  return `${v.toLocaleString('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 1 })} m/s`;
}

export function fmtDuration(s: number): string {
  if (!Number.isFinite(s)) return '∞';
  const t = Math.max(0, Math.floor(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

export function fmtPercent(f: number): string {
  return `${Math.round(f * 100)}%`;
}

/** Spoken-style span: "45 seconds", "17 minutes", "2 hours 40 minutes". */
export function fmtSpan(s: number): string {
  if (!Number.isFinite(s)) return 'a long time';
  const t = Math.max(0, Math.round(s));
  if (t < 90) return `${t} seconds`;
  const m = Math.round(t / 60);
  if (m < 90) return `${m} minutes`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h} hours` : `${h} hours ${rem} minutes`;
}
