export interface Column<T> {
  header: string;
  get: (row: T) => string;
  align?: 'left' | 'right';
}

export function table<T>(rows: T[], cols: Column<T>[]): string {
  const cells = rows.map((r) => cols.map((c) => c.get(r)));
  const widths = cols.map((c, i) => Math.max(c.header.length, ...cells.map((row) => row[i]!.length)));
  const fmt = (vals: string[]): string =>
    vals.map((v, i) => (cols[i]!.align === 'right' ? v.padStart(widths[i]!) : v.padEnd(widths[i]!))).join('  ');
  const lines = [fmt(cols.map((c) => c.header)), widths.map((w) => '-'.repeat(w)).join('  ')];
  for (const row of cells) lines.push(fmt(row));
  return lines.join('\n');
}

/** Trim a decimal string to `places` decimals (no rounding; display only). */
export function dec(s: string | null, places = 4): string {
  if (s === null) return '-';
  const i = s.indexOf('.');
  if (i < 0) return s;
  return places === 0 ? s.slice(0, i) : s.slice(0, i + 1 + places);
}

export function milliX(m: number): string {
  return `${(m / 1000).toFixed(2)}x`;
}

export function relTime(t: number, origin: number): string {
  return `t+${((t - origin) / 1000).toFixed(3)}s`;
}
