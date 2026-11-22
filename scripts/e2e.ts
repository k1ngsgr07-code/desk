// End-to-end check against the RUNNING server (npm start), using the fake QR image.
// Covers: login, test deposit, QR decode, quote, order + hold, approve, proof, paid,
// decline + release, settlement, and the ledger zero-sum check.
import fs from 'fs';
import path from 'path';
import assert from 'node:assert/strict';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import 'dotenv/config';

const BASE = `http://localhost:${process.env.PORT || 3000}`;

async function call(pathname: string, token?: string, body?: unknown) {
  const res = await fetch(BASE + '/api' + pathname, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: any = await res.json();
  return { status: res.status, data };
}

async function ok(pathname: string, token?: string, body?: unknown) {
  const r = await call(pathname, token, body);
  assert.equal(r.status, 200, `${pathname} -> ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}

const step = (s: string) => console.log('  ✓ ' + s);

async function main() {
  const env = process.env;
  const user = (await ok('/login', undefined, { email: env.SEED_USER_EMAIL, password: env.SEED_USER_PASSWORD })).token;
  const admin = (await ok('/login', undefined, { email: env.SEED_ADMIN_EMAIL, password: env.SEED_ADMIN_PASSWORD })).token;
  step('logged in as seed user and admin');

  assert.equal((await call('/me')).status, 401);
  assert.equal((await call('/admin/overview', user)).status, 403);
  step('no token -> 401, normal user on admin API -> 403');

  const start = Number((await ok('/me', user)).usdt_balance);
  await ok('/test-deposit', user, { amount: 100 });
  assert.equal(Number((await ok('/me', user)).usdt_balance), start + 100);
  step('test deposit credited 100 USDT');

  const png = PNG.sync.read(fs.readFileSync(path.join(__dirname, '..', 'public', 'test-qr.png')));
  const payload = jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data;
  assert.ok(payload, 'could not decode the fake QR');
  const upi = await ok('/upi/parse', user, { payload });
  assert.equal(upi.vpa, 'teststore@upi');
  assert.equal(upi.amount, '500.00');
  step(`decoded fake QR: ${upi.name} <${upi.vpa}> INR ${upi.amount}`);

  assert.equal((await call('/upi/parse', user, { payload: 'https://example.com' })).status, 400);
  assert.equal((await call('/quote', user, { payload, inr_amount: '-5' })).status, 400);
  assert.equal((await call('/quote', user, { payload, inr_amount: '99999999' })).status, 400);
  step('bad QR text and bad amounts are rejected');

  // Order 1: approve -> proof -> paid
  const q1 = await ok('/quote', user, { payload, inr_amount: upi.amount });
  const o1 = await ok('/orders', user, { quote: q1.quote });
  let me = await ok('/me', user);
  assert.equal(Number(me.usdt_on_hold), Number(q1.usdt));
  step(`order #${o1.id} created: ${q1.usdt} USDT on hold for INR ${q1.inr} at ${q1.rate}`);

  assert.equal((await call('/orders', user, { quote: q1.quote })).status, 409);
  assert.equal((await call('/orders', user, { quote: q1.quote + 'x' })).status, 400);
  step('reused quote -> 409, tampered quote -> 400');

  await ok(`/admin/orders/${o1.id}/simulate`, admin, { action: 'approve' });
  await ok(`/admin/orders/${o1.id}/simulate`, admin, { action: 'paid', proof: 'UTR 123456789012' });
  me = await ok('/me', user);
  assert.equal(Number(me.usdt_on_hold), 0);
  assert.equal(me.orders.find((o: any) => o.id === o1.id).status, 'paid');
  step(`order #${o1.id} approved and paid: hold moved to the house`);

  // Order 2: decline -> release
  const before = Number(me.usdt_balance);
  const q2 = await ok('/quote', user, { payload, inr_amount: '250' });
  const o2 = await ok('/orders', user, { quote: q2.quote });
  await ok(`/admin/orders/${o2.id}/simulate`, admin, { action: 'decline' });
  me = await ok('/me', user);
  assert.equal(Number(me.usdt_balance), before);
  assert.equal(me.orders.find((o: any) => o.id === o2.id).status, 'declined');
  assert.equal((await call(`/admin/orders/${o2.id}/simulate`, admin, { action: 'approve' })).status, 409);
  step(`order #${o2.id} declined: USDT released back to the wallet`);

  // Rate change
  const old = (await ok('/admin/overview', admin)).rate;
  const changed = await ok('/admin/rate', admin, { base: '90', spread: '2' });
  assert.equal(changed.user_rate, '88.2000');
  assert.equal((await ok('/rate')).rate, '88.2000');
  await ok('/admin/rate', admin, { base: old.base, spread: old.spread });
  step('admin changed the rate (90 @ 2% -> 88.20) and restored it');

  // Settlement
  let ov = await ok('/admin/overview', admin);
  const paidOrder = ov.orders.find((o: any) => o.id === o1.id);
  const merchant = ov.merchants.find((m: any) => m.name === paidOrder.merchant);
  assert.ok(Number(merchant.owed_inr) >= 500);
  const s = await ok('/admin/settle', admin, { merchant_id: merchant.id, note: 'e2e' });
  ov = await ok('/admin/overview', admin);
  assert.equal(Number(ov.merchants.find((m: any) => m.id === merchant.id).owed_inr), 0);
  step(`settled INR ${s.settled_inr} to ${merchant.name}; desk now owes them 0`);

  for (const c of ov.ledger_check) assert.equal(Number(c.total), 0, `${c.currency} ledger off by ${c.total}`);
  step('ledger sums to zero in USDT and INR');

  console.log('\nEnd-to-end flow passed.');
}

main().catch((e) => {
  console.error('\nE2E FAILED:', e.message);
  process.exit(1);
});
