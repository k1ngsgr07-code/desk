// Ledger tests. They run against a separate throwaway database (desk_test) on the same Postgres.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import 'dotenv/config';
import { Client } from 'pg';

// Point the app at desk_test BEFORE loading any app module.
const baseUrl = process.env.DATABASE_URL || 'postgres://postgres:password@localhost:5432/desk';
const testUrl = new URL(baseUrl);
testUrl.pathname = '/desk_test';
process.env.DATABASE_URL = testUrl.toString();

const { pool, tx } = require('../src/db') as typeof import('../src/db');
const ledger = require('../src/ledger') as typeof import('../src/ledger');
const orders = require('../src/orders') as typeof import('../src/orders');
const rates = require('../src/rates') as typeof import('../src/rates');
const { migrate } = require('../src/migrate') as typeof import('../src/migrate');
const { toMicro, fmt } = require('../src/money') as typeof import('../src/money');

let userId = 0;
let merchantId = 0;

async function wallet(label: 'wallet' | 'hold' = 'wallet') {
  return tx(async (c) => ledger.balance(c, await ledger.getAccount(c, 'user', userId, 'USDT', label)));
}

function quote(inr: string, usdt: string) {
  return { quoteId: crypto.randomUUID(), payload: 'upi://pay?pa=t@upi', vpa: 't@upi', name: 'T', inr, usdt, rate: '86.6800' };
}

async function ledgerTotals() {
  const r = await pool.query(
    `SELECT a.currency, SUM(e.amount)::text AS total FROM entries e JOIN accounts a ON a.id=e.account_id GROUP BY a.currency`,
  );
  return r.rows;
}

before(async () => {
  const adminDb = new Client({ connectionString: baseUrl });
  await adminDb.connect();
  await adminDb.query('DROP DATABASE IF EXISTS desk_test');
  await adminDb.query('CREATE DATABASE desk_test');
  await adminDb.end();
  await migrate();
  userId = (await pool.query("INSERT INTO users(email, password_hash) VALUES ('t@desk.test','x') RETURNING id")).rows[0].id;
  merchantId = (await pool.query("INSERT INTO merchants(name) VALUES ('M') RETURNING id")).rows[0].id;
});

after(() => pool.end());

test('money: parse and format without float errors', () => {
  assert.equal(toMicro('0.1') + toMicro('0.2'), toMicro('0.3'));
  assert.equal(fmt(toMicro('12.5')), '12.500000');
  assert.equal(fmt(toMicro('500'), 2), '500.00');
  assert.throws(() => toMicro('1e5'));
  assert.throws(() => toMicro('abc'));
});

test('rate: spread is applied and USDT is rounded up', () => {
  const r = rates.computeRate('88.00', '1.5');
  assert.equal(r.rate, '86.6800');
  const usdt = rates.usdtForInr(toMicro('500'), r.rateE4);
  assert.equal(fmt(usdt), '5.768344'); // 500 / 86.68 = 5.7683433..., rounded up
});

test('an unbalanced journal is rejected and writes nothing', async () => {
  const before = (await pool.query('SELECT count(*)::int AS n FROM entries')).rows[0].n;
  await assert.rejects(
    tx(async (c) => {
      const a = await ledger.getAccount(c, 'house', null, 'USDT', 'external');
      const b = await ledger.getAccount(c, 'user', userId, 'USDT', 'wallet');
      await ledger.post(c, 'bad', 'test', [
        { account: a, amount: -toMicro('10') },
        { account: b, amount: toMicro('9.999999') },
      ]);
    }),
    /does not balance/,
  );
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM entries')).rows[0].n, before);
});

test('a journal must balance in each currency separately', async () => {
  await assert.rejects(
    tx(async (c) => {
      const usdt = await ledger.getAccount(c, 'house', null, 'USDT', 'external');
      const inr = await ledger.getAccount(c, 'house', null, 'INR', 'payout_cost');
      await ledger.post(c, 'bad', 'test', [
        { account: usdt, amount: -toMicro('10') },
        { account: inr, amount: toMicro('10') },
      ]);
    }),
    /does not balance/,
  );
});

test('deposit, hold and release move the right amounts', async () => {
  await ledger.testDeposit(userId, toMicro('100'));
  assert.equal(await wallet(), toMicro('100'));

  const o = await orders.createOrder(userId, quote('500.00', '5.768344'));
  assert.equal(o.status, 'pending');
  assert.equal(await wallet(), toMicro('94.231656'));
  assert.equal(await wallet('hold'), toMicro('5.768344'));

  await orders.decline(o.id);
  assert.equal(await wallet(), toMicro('100'));
  assert.equal(await wallet('hold'), 0n);

  // a declined order cannot be declined, approved or paid again
  await assert.rejects(orders.decline(o.id), ledger.AppError);
  await assert.rejects(orders.approve(o.id), ledger.AppError);
  await assert.rejects(orders.markPaid(o.id), ledger.AppError);
  assert.equal(await wallet(), toMicro('100'));
});

test('the wallet can never go negative, and a failed order leaves no trace', async () => {
  const n = (await pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n;
  await assert.rejects(orders.createOrder(userId, quote('50000.00', '576.834334')), /Insufficient/);
  assert.equal(await wallet(), toMicro('100'));
  assert.equal(await wallet('hold'), 0n);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n, n);
});

test('two orders at the same moment cannot both spend the same balance', async () => {
  const results = await Promise.allSettled([
    orders.createOrder(userId, quote('5200.00', '60.000000')),
    orders.createOrder(userId, quote('5200.00', '60.000000')),
  ]);
  const okOnes = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>[];
  assert.equal(okOnes.length, 1);
  assert.equal(await wallet(), toMicro('40'));
  await orders.decline(okOnes[0].value.id);
  assert.equal(await wallet(), toMicro('100'));
});

test('a quote can only be used once', async () => {
  const q = quote('100.00', '1.153669');
  const o = await orders.createOrder(userId, q);
  await assert.rejects(orders.createOrder(userId, q), /already used/);
  await orders.decline(o.id);
});

test('paid order: USDT goes to the house, merchant is owed INR, settlement zeroes it', async () => {
  const o = await orders.createOrder(userId, quote('500.00', '5.768344'));
  await orders.approve(o.id, merchantId);
  await assert.rejects(orders.markPaid(o.id, merchantId), /proof/); // needs proof first
  assert.equal(await wallet('hold'), toMicro('5.768344'));           // failed Paid changed nothing
  await orders.setProof(o.id, 'UTR 123456789012', merchantId);
  const paid = await orders.markPaid(o.id, merchantId);
  assert.equal(paid.status, 'paid');

  assert.equal(await wallet(), toMicro('94.231656'));
  assert.equal(await wallet('hold'), 0n);
  assert.equal((await orders.merchantSummary(merchantId)).owed_inr, '500.00');
  await assert.rejects(orders.decline(o.id, undefined, true), ledger.AppError); // paid is final

  assert.equal(await ledger.settleMerchant(merchantId, 'test'), toMicro('500'));
  assert.equal((await orders.merchantSummary(merchantId)).owed_inr, '0.00');
  await assert.rejects(ledger.settleMerchant(merchantId, 'again'), /Nothing owed/);
});

test('a settlement can be a part payment, but never more than is owed', async () => {
  const o = await orders.createOrder(userId, { ...quote('300.00', '3.461006'), base: '88.0000' });
  await orders.approve(o.id, merchantId);
  await orders.setProof(o.id, 'UTR 999', merchantId);
  await orders.markPaid(o.id, merchantId);
  await assert.rejects(ledger.settleMerchant(merchantId, 'too much', toMicro('300.01')), /more than is owed/);
  assert.equal(await ledger.settleMerchant(merchantId, 'part', toMicro('100')), toMicro('100'));
  assert.equal((await orders.merchantSummary(merchantId)).owed_inr, '200.00');
  assert.equal(await ledger.settleMerchant(merchantId, 'rest'), toMicro('200'));
  assert.equal((await orders.merchantSummary(merchantId)).owed_inr, '0.00');
});

test('pending orders expire after 5 minutes and release the hold', async () => {
  const o = await orders.createOrder(userId, quote('100.00', '1.153669'));
  assert.equal((await orders.expireOld()).length, 0); // too new
  await pool.query("UPDATE orders SET created_at = now() - interval '6 minutes' WHERE id=$1", [o.id]);
  const expired = await orders.expireOld();
  assert.deepEqual(expired.map((x) => x.id), [o.id]);
  assert.equal(await wallet('hold'), 0n);
  assert.equal(await wallet(), toMicro('90.770650'));
});

test('the whole ledger sums to zero in every currency', async () => {
  const totals = await ledgerTotals();
  assert.ok(totals.length >= 2);
  for (const t of totals) assert.equal(Number(t.total), 0, `${t.currency} is off by ${t.total}`);
});
