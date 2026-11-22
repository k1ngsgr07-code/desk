// Money is handled as BigInt "micro" units (6 decimal places) so there is no float rounding.
// 1 USDT = 1_000_000n, 1 INR = 1_000_000n. Postgres stores NUMERIC and returns strings.

export const MICRO = 1_000_000n;

/** Parse a decimal string or number like "12.5" into micro units. Throws on bad input. */
export function toMicro(value: string | number): bigint {
  const s = String(value).trim();
  const m = /^(-?)(\d{1,14})(?:\.(\d{1,6}))?$/.exec(s);
  if (!m) throw new Error(`Invalid amount: ${s}`);
  const micro = BigInt(m[2]) * MICRO + BigInt((m[3] || '').padEnd(6, '0'));
  return m[1] ? -micro : micro;
}

/** Format micro units as a decimal string with `dp` decimals (truncates extra digits). */
export function fmt(micro: bigint, dp = 6): string {
  const neg = micro < 0n;
  const abs = neg ? -micro : micro;
  const whole = abs / MICRO;
  const frac = (abs % MICRO).toString().padStart(6, '0').slice(0, dp);
  return `${neg ? '-' : ''}${whole}${dp > 0 ? '.' + frac : ''}`;
}
