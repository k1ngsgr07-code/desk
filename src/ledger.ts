// Double-entry ledger. This file is the heart of the app.
// - Every journal sums to zero per currency.
// - Balances are never stored, only summed from entries.
// - User accounts (wallet, hold) can never go negative.
// - Everything runs inside the caller's DB transaction, so half-finished payments cannot happen.
//
// Sign convention: positive = credit to that account, negative = debit.
//   user wallet / hold (USDT)     positive = the user's funds
//   merchant payable (INR)        positive = the desk owes the merchant
//   house accounts                contra accounts (see README "Ledger accounts")
//
// TODO(AUDIT): write an append-only audit log entry for every journal (actor, IP, reason).

import { PoolClient } from 'pg';
import { tx } from './db';
import { fmt } from './money';

/** An error that is safe to show to the caller, with an HTTP status. */
export class AppError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export type Line = { account: number; amount: bigint }; // amount in micro units

export async function getAccount(
  client: PoolClient,
  ownerType: 'user' | 'merchant' | 'house',
  ownerId: number | null,
  currency: 'USDT' | 'INR',
  label: string,
): Promise<number> {
  await client.query(
    'INSERT INTO accounts(owner_type, owner_id, currency, label) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
    [ownerType, ownerId, currency, label],
  );
  const found = await client.query(
    'SELECT id FROM accounts WHERE owner_type=$1 AND owner_id IS NOT DISTINCT FROM $2 AND currency=$3 AND label=$4',
    [ownerType, ownerId, currency, label],
  );
  return found.rows[0].id as number;
}

/** Balance of one account in micro units. */
export async function balance(client: PoolClient, accountId: number): Promise<bigint> {
  const r = await client.query(
    'SELECT trunc(COALESCE(SUM(amount),0) * 1000000)::text AS b FROM entries WHERE account_id=$1',
    [accountId],
  );
  return BigInt(r.rows[0].b);
}

/** Post one balanced journal. Must be called inside a transaction (see tx()). */
export async function post(client: PoolClient, kind: string, ref: string, lines: Line[]): Promise<number> {
  if (lines.length < 2) throw new Error('A journal needs at least two entries');

  // Lock the accounts (in id order, to avoid deadlocks) so concurrent journals
  // on the same wallet cannot both pass the balance check.
  const ids = [...new Set(lines.map((l) => l.account))].sort((a, b) => a - b);
  const accounts = await client.query(
    'SELECT id, owner_type, currency FROM accounts WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE',
    [ids],
  );
  if (accounts.rows.length !== ids.length) throw new Error('Unknown account in journal');
  const info = new Map<number, { owner_type: string; currency: string }>(accounts.rows.map((a) => [a.id, a]));

  // Must sum to zero for each currency.
  const totals = new Map<string, bigint>();
  for (const l of lines) {
    const cur = info.get(l.account)!.currency;
    totals.set(cur, (totals.get(cur) || 0n) + l.amount);
  }
  for (const [cur, total] of totals) {
    if (total !== 0n) throw new Error(`Journal does not balance (${cur} off by ${fmt(total)})`);
  }

  const j = await client.query('INSERT INTO journal(kind, ref) VALUES ($1,$2) RETURNING id', [kind, ref]);
  for (const l of lines) {
    await client.query('INSERT INTO entries(journal_id, account_id, amount) VALUES ($1,$2,$3)', [
      j.rows[0].id,
      l.account,
      fmt(l.amount),
    ]);
  }

  // User money can never go negative. Throwing here rolls back the whole transaction.
  for (const id of ids) {
    if (info.get(id)!.owner_type === 'user' && (await balance(client, id)) < 0n) {
      throw new AppError(400, 'Insufficient USDT balance');
    }
  }
  return j.rows[0].id as number;
}

// ---- Money movements used by the app ----

/** Test deposit: the house "external" account sends fake USDT to the user wallet. */
export async function testDeposit(userId: number, usdt: bigint) {
  if (usdt <= 0n) throw new AppError(400, 'Deposit must be positive');
  // TODO(DEPOSITS): replace with a real USDT deposit watcher (per-user address, confirmations, reorg handling).
  await tx(async (c) => {
    const ext = await getAccount(c, 'house', null, 'USDT', 'external');
    const wallet = await getAccount(c, 'user', userId, 'USDT', 'wallet');
    await post(c, 'deposit', 'test', [
      { account: ext, amount: -usdt },
      { account: wallet, amount: usdt },
    ]);
  });
}

/** Order created: move USDT from the user's wallet into their hold account. */
export async function hold(c: PoolClient, userId: number, orderId: number, usdt: bigint) {
  const wallet = await getAccount(c, 'user', userId, 'USDT', 'wallet');
  const held = await getAccount(c, 'user', userId, 'USDT', 'hold');
  await post(c, 'order_hold', `order:${orderId}`, [
    { account: wallet, amount: -usdt },
    { account: held, amount: usdt },
  ]);
}

/** Order declined / expired: give the held USDT back to the user. */
export async function release(c: PoolClient, userId: number, orderId: number, usdt: bigint) {
  const wallet = await getAccount(c, 'user', userId, 'USDT', 'wallet');
  const held = await getAccount(c, 'user', userId, 'USDT', 'hold');
  await post(c, 'order_release', `order:${orderId}`, [
    { account: held, amount: -usdt },
    { account: wallet, amount: usdt },
  ]);
}

/** Order paid: held USDT goes to the house, and the desk now owes the merchant INR. */
export async function settleOrder(
  c: PoolClient,
  userId: number,
  merchantId: number,
  orderId: number,
  usdt: bigint,
  inr: bigint,
) {
  const held = await getAccount(c, 'user', userId, 'USDT', 'hold');
  const treasury = await getAccount(c, 'house', null, 'USDT', 'treasury');
  const payoutCost = await getAccount(c, 'house', null, 'INR', 'payout_cost');
  const payable = await getAccount(c, 'merchant', merchantId, 'INR', 'payable');
  await post(c, 'order_settle', `order:${orderId}`, [
    { account: held, amount: -usdt },
    { account: treasury, amount: usdt },
    { account: payoutCost, amount: -inr },
    { account: payable, amount: inr },
  ]);
}

/** Evening settlement: the desk pays the merchant everything it owes them (off-ledger bank transfer). */
export async function settleMerchant(merchantId: number, note: string, amount?: bigint): Promise<bigint> {
  return tx(async (c) => {
    const payable = await getAccount(c, 'merchant', merchantId, 'INR', 'payable');
    const settled = await getAccount(c, 'house', null, 'INR', 'settled');
    // Lock the payable account before reading its balance.
    await c.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE', [payable]);
    const owed = await balance(c, payable);
    if (owed <= 0n) throw new AppError(400, 'Nothing owed to this merchant');
    const pay = amount ?? owed; // no amount = settle everything
    if (pay <= 0n) throw new AppError(400, 'Settlement amount must be positive');
    if (pay > owed) throw new AppError(400, `Cannot settle more than is owed (INR ${fmt(owed, 2)})`);
    await post(c, 'merchant_settlement', `merchant:${merchantId} ${note}`.trim(), [
      { account: payable, amount: -pay },
      { account: settled, amount: pay },
    ]);
    return pay;
  });
}
