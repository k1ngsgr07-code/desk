// API server + static web app. PRIVATE TEST BUILD - NO REAL MONEY.
//
// TODO before ANY real use (mandatory, KYC first):
//   TODO(KYC)      identity verification for users and merchants
//   TODO(AML)      sanctions / transaction screening and monitoring
//   TODO(LIMITS)   per-user and per-merchant limits
//   TODO(2FA)      two-factor auth for users, admins and withdrawals
//   TODO(DEPOSITS) real USDT deposit watcher instead of the test deposit button
//   TODO(AUDIT)    append-only audit logging
//   TODO(LEGAL)    legal and regulatory review (VDA rules, FIU-IND registration, tax, UPI/NPCI terms)
//   TODO(SECURITY) rate limiting, HTTPS, secure cookies/CSRF, secrets management, pen test

import path from 'path';
import crypto from 'crypto';
import express, { NextFunction, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { BANNER, config } from './config';
import { pool } from './db';
import { AppError, settleMerchant, testDeposit } from './ledger';
import { fmt, toMicro } from './money';
import { getRate, setRate, usdtForInr } from './rates';
import { parseUpi } from './upi';
import { Quote, approve, createOrder, decline, expireOld, markPaid, merchantSummary, setProof } from './orders';
import { notifyMerchant, notifyNewOrder, startBot } from './bot';
import { migrate } from './migrate';
import { seedMain } from './seed';

const app = express();
app.use(express.json({ limit: '20kb' }));

app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/vendor/jsQR.js', (_req, res) => res.sendFile(require.resolve('jsqr/dist/jsQR.js')));

// ---------- helpers ----------

type Authed = Request & { user: { id: number; email: string; is_admin: boolean } };

function str(v: unknown, what: string, max = 200): string {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new AppError(400, `Invalid ${what}`);
  return v.trim();
}

function intParam(v: unknown, what: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new AppError(400, `Invalid ${what}`);
  return n;
}

function sign(userId: number) {
  return jwt.sign({ typ: 'login', uid: userId }, config.jwtSecret, { expiresIn: '12h' });
}

async function auth(req: Request, _res: Response, next: NextFunction) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  let uid: number;
  try {
    const p = jwt.verify(token, config.jwtSecret) as any;
    if (p.typ !== 'login') throw new Error();
    uid = p.uid;
  } catch {
    throw new AppError(401, 'Please log in');
  }
  const r = await pool.query('SELECT id, email, is_admin FROM users WHERE id=$1', [uid]);
  if (!r.rows[0]) throw new AppError(401, 'Please log in');
  (req as Authed).user = r.rows[0];
  next();
}

async function admin(req: Request, res: Response, next: NextFunction) {
  await auth(req, res, () => {
    if (!(req as Authed).user.is_admin) throw new AppError(403, 'Admins only');
    next();
  });
}

// ---------- 1. auth ----------

app.post('/api/signup', async (req, res) => {
  const email = str(req.body?.email, 'email').toLowerCase();
  const password = str(req.body?.password, 'password', 100);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError(400, 'Invalid email');
  if (password.length < 8) throw new AppError(400, 'Password must be at least 8 characters');
  // TODO(KYC): collect and verify identity here before the account can transact.
  // TODO(2FA): enrol a second factor.
  try {
    const r = await pool.query('INSERT INTO users(email, password_hash) VALUES ($1,$2) RETURNING id', [
      email,
      await bcrypt.hash(password, 10),
    ]);
    res.json({ token: sign(r.rows[0].id), email, is_admin: false });
  } catch (e: any) {
    if (e.code === '23505') throw new AppError(409, 'Email already registered');
    throw e;
  }
});

app.post('/api/login', async (req, res) => {
  const email = str(req.body?.email, 'email').toLowerCase();
  const password = str(req.body?.password, 'password', 100);
  const r = await pool.query('SELECT id, password_hash, is_admin FROM users WHERE email=$1', [email]);
  const ok = r.rows[0] && (await bcrypt.compare(password, r.rows[0].password_hash));
  if (!ok) throw new AppError(401, 'Wrong email or password');
  // TODO(SECURITY): login rate limiting / lockout. TODO(2FA): require second factor.
  res.json({ token: sign(r.rows[0].id), email, is_admin: r.rows[0].is_admin });
});

// ---------- 2. wallet + order history ----------

app.get('/api/me', auth, async (req, res) => {
  const u = (req as Authed).user;
  const bal = await pool.query(
    `SELECT a.label, COALESCE(SUM(e.amount),0)::text AS balance
     FROM accounts a LEFT JOIN entries e ON e.account_id=a.id
     WHERE a.owner_type='user' AND a.owner_id=$1 AND a.currency='USDT' GROUP BY a.label`,
    [u.id],
  );
  const by = Object.fromEntries(bal.rows.map((r) => [r.label, r.balance]));
  const orders = await pool.query(
    `SELECT id, payee_vpa, payee_name, inr_amount, usdt_amount, rate, status, created_at
     FROM orders WHERE user_id=$1 ORDER BY id DESC LIMIT 50`,
    [u.id],
  );
  const rate = await getRate();
  res.json({
    email: u.email,
    is_admin: u.is_admin,
    usdt_balance: by.wallet || '0.000000',
    usdt_on_hold: by.hold || '0.000000',
    rate: rate.rate,
    orders: orders.rows,
  });
});

// ---------- 3. test deposit ----------

app.post('/api/test-deposit', auth, async (req, res) => {
  const amount = Number(req.body?.amount ?? 100);
  if (!Number.isFinite(amount) || amount <= 0 || amount > config.maxTestDepositUsdt) {
    throw new AppError(400, `Test deposit must be between 0 and ${config.maxTestDepositUsdt} USDT`);
  }
  await testDeposit((req as Authed).user.id, toMicro(amount.toFixed(6)));
  res.json({ ok: true });
});

// ---------- 4. rate ----------

app.get('/api/rate', async (_req, res) => {
  const r = await getRate();
  res.json({ rate: r.rate }); // users only see the rate after spread
});

// ---------- 5. withdraw by UPI QR: parse -> quote (locked 2 min) -> order ----------

app.post('/api/upi/parse', auth, (req, res) => {
  res.json(parseUpi(str(req.body?.payload, 'QR text', 1000)));
});

app.post('/api/quote', auth, async (req, res) => {
  const payload = str(req.body?.payload, 'QR text', 1000);
  const upi = parseUpi(payload);
  const inrText = str(String(req.body?.inr_amount ?? ''), 'INR amount', 12);
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(inrText)) throw new AppError(400, 'Invalid INR amount');
  const inr = toMicro(inrText);
  if (inr <= 0n || inr > toMicro(config.maxOrderInr)) {
    throw new AppError(400, `INR amount must be between 0 and ${config.maxOrderInr}`);
  }
  const rate = await getRate();
  const q: Quote = {
    quoteId: crypto.randomUUID(),
    payload,
    vpa: upi.vpa,
    name: upi.name,
    inr: fmt(inr, 2),
    usdt: fmt(usdtForInr(inr, rate.rateE4)),
    rate: rate.rate,
    base: rate.base,
  };
  // The quote is a signed token, so the rate cannot be changed by the client and it dies after 2 minutes.
  const token = jwt.sign({ typ: 'quote', uid: (req as Authed).user.id, q }, config.jwtSecret, {
    expiresIn: config.quoteTtlSeconds,
  });
  res.json({ quote: token, expires_in: config.quoteTtlSeconds, vpa: q.vpa, name: q.name, inr: q.inr, usdt: q.usdt, rate: q.rate });
});

app.post('/api/orders', auth, async (req, res) => {
  const u = (req as Authed).user;
  let q: Quote;
  try {
    const p = jwt.verify(str(req.body?.quote, 'quote', 4000), config.jwtSecret) as any;
    if (p.typ !== 'quote' || p.uid !== u.id) throw new Error();
    q = p.q;
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(400, 'Quote expired or invalid. Please get a new quote.');
  }
  const order = await createOrder(u.id, q);
  notifyNewOrder(order).catch((e) => console.error(e));
  res.json({ id: order.id, status: order.status });
});

// ---------- 8. admin ----------

// Per-merchant numbers, all worked out from orders and the ledger (nothing stored).
const MERCHANT_STATS = `
  (SELECT count(*) FROM orders o WHERE o.merchant_id=m.id AND o.status='paid')::int AS paid_count,
  (SELECT count(*) FROM orders o WHERE o.merchant_id=m.id AND o.status IN ('pending','approved'))::int AS open_count,
  (SELECT COALESCE(SUM(o.inr_amount),0) FROM orders o WHERE o.merchant_id=m.id AND o.status='paid')::numeric(20,2)::text AS paid_inr,
  (SELECT COALESCE(SUM(o.usdt_amount),0) FROM orders o WHERE o.merchant_id=m.id AND o.status='paid')::numeric(20,2)::text AS usdt_collected,
  (SELECT COALESCE(SUM(o.usdt_amount*o.base_rate - o.inr_amount),0) FROM orders o
     WHERE o.merchant_id=m.id AND o.status='paid' AND o.base_rate IS NOT NULL)::numeric(20,2)::text AS margin_inr,
  (SELECT COALESCE(SUM(e.amount),0) FROM entries e JOIN accounts a ON a.id=e.account_id
     WHERE a.owner_type='merchant' AND a.owner_id=m.id AND a.label='payable')::numeric(20,2)::text AS owed_inr,
  (SELECT COALESCE(-SUM(e.amount),0) FROM entries e JOIN accounts a ON a.id=e.account_id JOIN journal j ON j.id=e.journal_id
     WHERE a.owner_type='merchant' AND a.owner_id=m.id AND a.label='payable' AND j.kind='merchant_settlement')::numeric(20,2)::text AS settled_inr`;

const MERCHANT_COLS = `m.id, m.name, m.phone, m.settle_to, m.note, m.active, m.link_code, m.created_at,
  (m.telegram_chat_id IS NOT NULL) AS linked`;

function optStr(v: unknown, what: string, max: number): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || v.length > max) throw new AppError(400, `Invalid ${what}`);
  return v.trim() || null;
}

function merchantFields(body: any) {
  const phone = optStr(body?.phone, 'phone', 20);
  if (phone && !/^[0-9+\- ]{6,20}$/.test(phone)) throw new AppError(400, 'Invalid phone');
  return {
    name: str(body?.name, 'merchant name', 80),
    phone,
    settle_to: optStr(body?.settle_to, 'settlement details', 120),
    note: optStr(body?.note, 'note', 300),
  };
}

const newLinkCode = () => crypto.randomBytes(4).toString('hex').toUpperCase();

app.get('/api/admin/overview', admin, async (_req, res) => {
  const orders = await pool.query(
    `SELECT o.id, u.email, m.name AS merchant, o.payee_vpa, o.payee_name, o.inr_amount, o.usdt_amount, o.rate,
            o.status, o.proof, o.created_at
     FROM orders o JOIN users u ON u.id=o.user_id JOIN merchants m ON m.id=o.merchant_id
     ORDER BY o.id DESC LIMIT 100`,
  );
  const merchants = await pool.query(`SELECT ${MERCHANT_COLS}, ${MERCHANT_STATS} FROM merchants m ORDER BY m.id`);
  // Today = since midnight India time.
  const today = await pool.query(
    `SELECT count(*)::int AS paid_count,
            COALESCE(SUM(inr_amount),0)::numeric(20,2)::text AS paid_inr,
            COALESCE(SUM(usdt_amount),0)::numeric(20,2)::text AS usdt_collected,
            COALESCE(SUM(usdt_amount*base_rate - inr_amount) FILTER (WHERE base_rate IS NOT NULL),0)::numeric(20,2)::text AS margin_inr
     FROM orders WHERE status='paid'
       AND updated_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'`,
  );
  const balances = await pool.query(
    `SELECT a.owner_type, a.owner_id, a.currency, a.label, COALESCE(SUM(e.amount),0)::text AS balance
     FROM accounts a LEFT JOIN entries e ON e.account_id=a.id
     GROUP BY a.id ORDER BY a.owner_type, a.owner_id NULLS FIRST, a.label`,
  );
  // Sanity check: the whole ledger must sum to zero in each currency.
  const check = await pool.query(
    `SELECT a.currency, COALESCE(SUM(e.amount),0)::text AS total
     FROM entries e JOIN accounts a ON a.id=e.account_id GROUP BY a.currency`,
  );
  const rate = await getRate();
  res.json({
    rate: { base: rate.base, spread: rate.spread, user_rate: rate.rate },
    today: today.rows[0],
    orders: orders.rows,
    merchants: merchants.rows,
    balances: balances.rows,
    ledger_check: check.rows,
    telegram: !!config.telegramToken,
  });
});

app.post('/api/admin/rate', admin, async (req, res) => {
  const r = await setRate(String(req.body?.base ?? ''), String(req.body?.spread ?? ''));
  res.json({ base: r.base, spread: r.spread, user_rate: r.rate });
});

// ---- merchants: add, edit, details, settle ----
// TODO(KYC): a merchant must pass KYB / identity checks before being activated for real payouts.

app.post('/api/admin/merchants', admin, async (req, res) => {
  const f = merchantFields(req.body);
  const r = await pool.query(
    'INSERT INTO merchants(name, phone, settle_to, note, link_code) VALUES ($1,$2,$3,$4,$5) RETURNING id, link_code',
    [f.name, f.phone, f.settle_to, f.note, newLinkCode()],
  );
  res.json(r.rows[0]);
});

app.post('/api/admin/merchants/:id', admin, async (req, res) => {
  const f = merchantFields(req.body);
  const r = await pool.query('UPDATE merchants SET name=$1, phone=$2, settle_to=$3, note=$4 WHERE id=$5 RETURNING id', [
    f.name, f.phone, f.settle_to, f.note, intParam(req.params.id, 'merchant'),
  ]);
  if (!r.rows[0]) throw new AppError(404, 'Merchant not found');
  res.json({ ok: true });
});

app.get('/api/admin/merchants/:id', admin, async (req, res) => {
  const id = intParam(req.params.id, 'merchant');
  const m = await pool.query(`SELECT ${MERCHANT_COLS}, ${MERCHANT_STATS} FROM merchants m WHERE m.id=$1`, [id]);
  if (!m.rows[0]) throw new AppError(404, 'Merchant not found');
  const orders = await pool.query(
    `SELECT o.id, u.email, o.payee_vpa, o.payee_name, o.inr_amount, o.usdt_amount, o.status, o.proof, o.created_at
     FROM orders o JOIN users u ON u.id=o.user_id WHERE o.merchant_id=$1 ORDER BY o.id DESC LIMIT 200`,
    [id],
  );
  const settlements = await pool.query(
    `SELECT j.id, j.created_at, (-e.amount)::numeric(20,2)::text AS inr, j.ref
     FROM journal j JOIN entries e ON e.journal_id=j.id JOIN accounts a ON a.id=e.account_id
     WHERE j.kind='merchant_settlement' AND a.owner_type='merchant' AND a.owner_id=$1
     ORDER BY j.id DESC LIMIT 200`,
    [id],
  );
  res.json({
    merchant: m.rows[0],
    orders: orders.rows,
    settlements: settlements.rows.map((s) => ({
      id: s.id,
      created_at: s.created_at,
      inr: s.inr,
      note: String(s.ref || '').replace(/^merchant:\d+\s*/, ''),
    })),
  });
});

app.post('/api/admin/merchants/:id/active', admin, async (req, res) => {
  await pool.query('UPDATE merchants SET active=$1 WHERE id=$2', [!!req.body?.active, intParam(req.params.id, 'merchant')]);
  res.json({ ok: true });
});

// Disconnect the merchant's Telegram chat and issue a fresh /link code (e.g. lost phone).
app.post('/api/admin/merchants/:id/relink', admin, async (req, res) => {
  const r = await pool.query('UPDATE merchants SET telegram_chat_id=NULL, link_code=$1 WHERE id=$2 RETURNING link_code', [
    newLinkCode(), intParam(req.params.id, 'merchant'),
  ]);
  if (!r.rows[0]) throw new AppError(404, 'Merchant not found');
  res.json(r.rows[0]);
});

// Record a settlement the desk has paid to a merchant (the bank/UPI transfer itself happens outside this app).
// No amount = everything owed. A smaller amount records a part payment.
app.post('/api/admin/settle', admin, async (req, res) => {
  const merchantId = intParam(req.body?.merchant_id, 'merchant');
  const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 100) : '';
  let amount: bigint | undefined;
  if (req.body?.amount !== undefined && req.body.amount !== '') {
    const text = String(req.body.amount).trim();
    if (!/^\d{1,9}(\.\d{1,2})?$/.test(text)) throw new AppError(400, 'Invalid settlement amount');
    amount = toMicro(text);
  }
  const paid = await settleMerchant(merchantId, note, amount);
  const left = (await merchantSummary(merchantId)).owed_inr;
  notifyMerchant(merchantId, `Settlement recorded: INR ${fmt(paid, 2)}${note ? ` (${note})` : ''}. Desk now owes you INR ${left}.`).catch(() => {});
  res.json({ settled_inr: fmt(paid, 2), owed_inr: left });
});

// TEST ONLY: act as the merchant from the admin page, so the flow can be tested without Telegram.
// "decline" here also cancels an approved order that got stuck.
app.post('/api/admin/orders/:id/simulate', admin, async (req, res) => {
  const id = intParam(req.params.id, 'order');
  const action = req.body?.action;
  let o;
  if (action === 'approve') o = await approve(id);
  else if (action === 'decline') o = await decline(id, undefined, true);
  else if (action === 'paid') {
    await setProof(id, str(req.body?.proof ?? 'UTR SIMULATED-BY-ADMIN', 'proof'));
    o = await markPaid(id);
  } else throw new AppError(400, 'action must be approve, decline or paid');
  res.json({ id: o.id, status: o.status });
});

// ---------- errors ----------

app.use('/api', (_req, _res) => {
  throw new AppError(404, 'Not found');
});

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof AppError) return res.status(err.status).json({ error: err.message });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

// ---------- start ----------

async function main() {
  await migrate();
  await seedMain();
  await pool.query('SELECT 1 FROM orders LIMIT 1').catch(() => {
    console.error('Database is not ready. Start Postgres, then run: npm run migrate && npm run seed');
    process.exit(1);
  });

  // 6. Pending orders expire after 5 minutes and release the hold automatically.
  setInterval(async () => {
    try {
      for (const o of await expireOld()) {
        console.log(`Order #${o.id} expired, hold released`);
        notifyMerchant(o.merchant_id, `Order #${o.id} (INR ${o.inr_amount}) expired. Do not pay it.`).catch(() => {});
      }
    } catch (e) {
      console.error('Expiry job failed:', e);
    }
  }, 15_000);

  startBot();
  const port = Number(process.env.PORT) || config.port;

  app.listen(port, '0.0.0.0', () => {
    console.log(`\n*** ${BANNER} ***`);
    console.log(`Running on port ${port}`);
  });
}

main();
