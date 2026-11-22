// Rate engine. BASE_RATE_INR and SPREAD_PERCENT start from .env; the admin can change them
// at runtime (stored in the settings table).
// User rate = base * (1 - spread%). The user gets fewer rupees per USDT; the spread is the desk's margin.

import { pool } from './db';
import { config } from './config';
import { AppError } from './ledger';

const E4 = 10_000n;

function parseFixed(value: string, decimals: number, what: string): bigint {
  const m = new RegExp(`^(\\d{1,6})(?:\\.(\\d{1,${decimals}}))?$`).exec(String(value).trim());
  if (!m) throw new AppError(400, `Invalid ${what}`);
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt((m[2] || '').padEnd(decimals, '0'));
}

function show(v: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  return `${v / scale}.${(v % scale).toString().padStart(decimals, '0')}`;
}

export type Rate = { base: string; spread: string; rate: string; rateE4: bigint };

export function computeRate(base: string, spread: string): Rate {
  const baseE4 = parseFixed(base, 4, 'base rate');
  const spreadE2 = parseFixed(spread, 2, 'spread');
  if (baseE4 <= 0n) throw new AppError(400, 'Base rate must be positive');
  if (spreadE2 >= 5000n) throw new AppError(400, 'Spread must be under 50%');
  const rateE4 = (baseE4 * (10_000n - spreadE2)) / 10_000n; // rounded down, in the desk's favour
  return { base: show(baseE4, 4), spread: show(spreadE2, 2), rate: show(rateE4, 4), rateE4 };
}

export async function getRate(): Promise<Rate> {
  const r = await pool.query("SELECT key, value FROM settings WHERE key IN ('base_rate_inr','spread_percent')");
  const s = Object.fromEntries(r.rows.map((x) => [x.key, x.value]));
  return computeRate(s.base_rate_inr ?? config.baseRateInr, s.spread_percent ?? config.spreadPercent);
}

export async function setRate(base: string, spread: string): Promise<Rate> {
  const next = computeRate(base, spread); // validates
  await pool.query(
    `INSERT INTO settings(key, value) VALUES ('base_rate_inr',$1), ('spread_percent',$2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [next.base, next.spread],
  );
  return next;
}

/** USDT (micro) the user must pay for an INR amount (micro). Rounded up to 6 dp. */
export function usdtForInr(inrMicro: bigint, rateE4: bigint): bigint {
  return (inrMicro * E4 + rateE4 - 1n) / rateE4;
}
