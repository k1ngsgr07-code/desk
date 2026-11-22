// Order lifecycle. Each status change and its ledger movement happen in ONE transaction.
//
//   pending --approve--> approved --paid--> paid        (USDT hold -> house, merchant payable +INR)
//   pending --decline--> declined                       (hold released to user)
//   pending --5 min----> expired                        (hold released to user)
//   approved --admin cancel--> declined                 (hold released to user)

import { PoolClient } from 'pg';
import { pool, tx } from './db';
import { config } from './config';
import { AppError, hold, release, settleOrder } from './ledger';
import { toMicro } from './money';

export type Order = {
  id: number;
  user_id: number;
  merchant_id: number;
  payee_vpa: string;
  payee_name: string;
  inr_amount: string;
  usdt_amount: string;
  rate: string;
  status: string;
  proof: string | null;
  created_at: string;
};

export type Quote = {
  quoteId: string;
  payload: string;
  vpa: string;
  name: string;
  inr: string;   // "500.00"
  usdt: string;  // "5.767013"
  rate: string;  // "86.6800"
  base?: string; // "88.0000" rate before spread
};

/** Move an order from one of `from` to `to`, or fail if it is not in that state (or not this merchant's). */
async function move(c: PoolClient, id: number, from: string[], to: string, merchantId?: number): Promise<Order> {
  const r = await c.query(
    `UPDATE orders SET status=$1, updated_at=now()
     WHERE id=$2 AND status = ANY($3::text[]) AND ($4::int IS NULL OR merchant_id=$4)
     RETURNING *`,
    [to, id, from, merchantId ?? null],
  );
  if (!r.rows[0]) throw new AppError(409, `Order #${id} cannot be changed to "${to}" right now`);
  return r.rows[0];
}

/** Pick an active merchant: prefer ones linked to Telegram, then the one with the fewest open orders. */
async function pickMerchant(c: PoolClient): Promise<number> {
  const r = await c.query(
    `SELECT m.id FROM merchants m
     WHERE m.active
     ORDER BY (m.telegram_chat_id IS NULL),
              (SELECT count(*) FROM orders o WHERE o.merchant_id=m.id AND o.status IN ('pending','approved')),
              random()
     LIMIT 1`,
  );
  if (!r.rows[0]) throw new AppError(503, 'No active merchant is available');
  return r.rows[0].id;
}

export async function createOrder(userId: number, q: Quote): Promise<Order> {
  // TODO(KYC): refuse unless the user has passed identity verification.
  // TODO(AML): screen the user, the payee VPA and the amount (sanctions, velocity, structuring) before holding funds.
  // TODO(LIMITS): enforce per-order / daily / monthly limits.
  return tx(async (c) => {
    const merchantId = await pickMerchant(c);
    let order: Order;
    try {
      const r = await c.query(
        `INSERT INTO orders(user_id, merchant_id, quote_id, upi_payload, payee_vpa, payee_name, inr_amount, usdt_amount, rate, base_rate)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [userId, merchantId, q.quoteId, q.payload, q.vpa, q.name, q.inr, q.usdt, q.rate, q.base ?? null],
      );
      order = r.rows[0];
    } catch (e: any) {
      if (e.code === '23505') throw new AppError(409, 'This quote was already used');
      throw e;
    }
    await hold(c, userId, order.id, toMicro(q.usdt)); // throws if the wallet would go negative
    return order;
  });
}

export function approve(orderId: number, merchantId?: number): Promise<Order> {
  return tx((c) => move(c, orderId, ['pending'], 'approved', merchantId));
}

/** Merchant decline (pending only). Admin cancel may also release an approved order. */
export function decline(orderId: number, merchantId?: number, allowApproved = false): Promise<Order> {
  return tx(async (c) => {
    const o = await move(c, orderId, allowApproved ? ['pending', 'approved'] : ['pending'], 'declined', merchantId);
    await release(c, o.user_id, o.id, toMicro(o.usdt_amount));
    return o;
  });
}

export async function setProof(orderId: number, proof: string, merchantId?: number): Promise<Order> {
  const r = await pool.query(
    `UPDATE orders SET proof=$1, updated_at=now()
     WHERE id=$2 AND status='approved' AND ($3::int IS NULL OR merchant_id=$3) RETURNING *`,
    [proof.slice(0, 300), orderId, merchantId ?? null],
  );
  if (!r.rows[0]) throw new AppError(409, `Order #${orderId} is not waiting for a payment proof`);
  return r.rows[0];
}

export function markPaid(orderId: number, merchantId?: number): Promise<Order> {
  return tx(async (c) => {
    const o = await move(c, orderId, ['approved'], 'paid', merchantId);
    if (!o.proof) throw new AppError(400, 'Send the payment proof (UTR text or photo) before pressing Paid');
    await settleOrder(c, o.user_id, o.merchant_id, o.id, toMicro(o.usdt_amount), toMicro(o.inr_amount));
    return o;
  });
}

/** Expire pending orders older than 5 minutes and release their holds. Returns the expired orders. */
export async function expireOld(): Promise<Order[]> {
  const due = await pool.query(
    `SELECT id FROM orders WHERE status='pending' AND created_at < now() - make_interval(secs => $1)`,
    [config.orderExpirySeconds],
  );
  const expired: Order[] = [];
  for (const row of due.rows) {
    try {
      expired.push(
        await tx(async (c) => {
          const o = await move(c, row.id, ['pending'], 'expired');
          await release(c, o.user_id, o.id, toMicro(o.usdt_amount));
          return o;
        }),
      );
    } catch (e) {
      if (!(e instanceof AppError)) throw e; // AppError = the merchant acted first; fine
    }
  }
  return expired;
}

/** What a merchant has paid, and what the desk owes / has settled to them. */
export async function merchantSummary(merchantId: number) {
  const r = await pool.query(
    `SELECT
       (SELECT count(*) FROM orders WHERE merchant_id=$1 AND status='paid')::int AS paid_count,
       (SELECT COALESCE(SUM(inr_amount),0) FROM orders WHERE merchant_id=$1 AND status='paid')::numeric(20,2)::text AS paid_inr,
       (SELECT COALESCE(SUM(e.amount),0) FROM entries e JOIN accounts a ON a.id=e.account_id
         WHERE a.owner_type='merchant' AND a.owner_id=$1 AND a.currency='INR' AND a.label='payable')::numeric(20,2)::text AS owed_inr`,
    [merchantId],
  );
  return r.rows[0] as { paid_count: number; paid_inr: string; owed_inr: string };
}
