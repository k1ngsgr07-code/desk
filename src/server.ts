// API server — USDT to INR Desk (production build).
// Phone OTP auth, real USDT deposits (BEP20/TRC20), KYC, IP tracking, user blocking.
import path from 'path';
import crypto from 'crypto';
import express, { NextFunction, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from './config';
import { pool } from './db';
import { AppError, settleMerchant } from './ledger';
import { fmt, toMicro } from './money';
import { getRate, setRate, usdtForInr } from './rates';
import { parseUpi } from './upi';
import { Quote, approve, createOrder, decline, expireOld, markPaid, merchantSummary, setProof } from './orders';
import { notifyMerchant, notifyNewOrder, startBot } from './bot';
import { migrate } from './migrate';
import { seedMain } from './seed';
import { requestOtp, verifyOtp, sign } from './auth';
import { assertNotBlocked, blockUser, unblockUser, ipSiblings, duplicateIpReport, recordLogin } from './security';
import { assertKyc, submitKyc, getKycStatus, reviewKyc, getPendingKyc } from './kyc';
import { getDepositAddress, getUserAddresses, getDepositHistory, getAllDeposits, scanChain, ensureMasterWallet } from './blockchain';

const app = express();
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/vendor/jsQR.js', (_req, res) => res.sendFile(require.resolve('jsqr/dist/jsQR.js')));

// ─── helpers ──────────────────────────────────────────────

type Authed = Request & { user: { id: number; email: string | null; phone: string | null; is_admin: boolean } };

function str(v: unknown, what: string, max = 200): string {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new AppError(400, `Invalid ${what}`);
  return v.trim();
}
function intParam(v: unknown, what: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new AppError(400, `Invalid ${what}`);
  return n;
}

function getClientIp(req: Request): string {
  return (req.headers['x-forwarded-for'] as string || req.socket.remoteAddress || '127.0.0.1').split(',')[0].trim();
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
  const r = await pool.query('SELECT id, email, phone, is_admin FROM users WHERE id=$1', [uid]);
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

// ─── 1. Auth — Phone OTP ──────────────────────────────────

app.post('/api/auth/request-otp', async (req, res) => {
  const phone = str(req.body?.phone, 'phone number', 20);
  const purpose = ['signup', 'login'].includes(req.body?.purpose) ? req.body.purpose : 'login';
  const result = await requestOtp(phone, purpose);
  res.json(result);
});

app.post('/api/auth/verify-otp', async (req, res) => {
  const phone = str(req.body?.phone, 'phone number', 20);
  const code = str(req.body?.code, 'OTP code', 10);
  const purpose = ['signup', 'login'].includes(req.body?.purpose) ? req.body.purpose : 'login';
  const ip = getClientIp(req);
  const device = String(req.body?.device || req.headers['user-agent'] || '');
  const extra = { ip, device };

  const result = await verifyOtp(phone, code, purpose, extra);

  // Check for duplicate IP
  const { checkIpDuplicate } = await import('./security.js');
  await checkIpDuplicate(ip, result.user.id);

  res.json(result);
});

// Legacy email auth (kept for backward compatibility)
app.post('/api/auth/login-email', async (req, res) => {
  const email = str(req.body?.email, 'email').toLowerCase();
  const password = str(req.body?.password, 'password', 100);
  const r = await pool.query('SELECT id, password_hash, is_admin, blocked, block_reason FROM users WHERE email=$1', [email]);
  if (!r.rows[0]) throw new AppError(401, 'Wrong email or password');
  if (r.rows[0].blocked) {
    throw new AppError(403, `Account blocked: ${r.rows[0].block_reason || 'Contact support'}`);
  }
  const ok = await bcrypt.compare(password, r.rows[0].password_hash);
  if (!ok) throw new AppError(401, 'Wrong email or password');

  await recordLogin(r.rows[0].id, { ip: getClientIp(req), device: req.headers['user-agent'] as string });

  res.json({ token: sign(r.rows[0].id), email, is_admin: r.rows[0].is_admin });
});

// Legacy email signup
app.post('/api/signup', async (req, res) => {
  const email = str(req.body?.email, 'email').toLowerCase();
  const password = str(req.body?.password, 'password', 100);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError(400, 'Invalid email');
  if (password.length < 8) throw new AppError(400, 'Password must be at least 8 characters');
  try {
    const r = await pool.query(
      'INSERT INTO users(email, password_hash) VALUES ($1,$2) RETURNING id',
      [email, await bcrypt.hash(password, 10)],
    );
    await recordLogin(r.rows[0].id, { ip: getClientIp(req), device: req.headers['user-agent'] as string });
    res.json({ token: sign(r.rows[0].id), email, is_admin: false });
  } catch (e: any) {
    if (e.code === '23505') throw new AppError(409, 'Email already registered');
    throw e;
  }
});

// ─── 2. User profile ──────────────────────────────────────

app.get('/api/me', auth, async (req, res) => {
  const u = (req as Authed).user;
  const user = await pool.query(
    `SELECT id, email, phone, full_name, country, city, kyc_status, blocked, block_reason,
            referral_code, created_at, last_login_at
     FROM users WHERE id=$1`,
    [u.id],
  );
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
  const addresses = await getUserAddresses(u.id);
  res.json({
    ...user.rows[0],
    usdt_balance: by.wallet || '0.000000',
    usdt_on_hold: by.hold || '0.000000',
    rate: rate.rate,
    orders: orders.rows,
    deposit_addresses: addresses,
  });
});

app.put('/api/me', auth, async (req, res) => {
  const u = (req as Authed).user;
  const fields: string[] = [];
  const values: any[] = [];
  let idx = 1;

  const settable = ['full_name', 'country', 'city'];
  for (const key of settable) {
    if (req.body?.[key] !== undefined) {
      fields.push(`${key}=$${idx}`);
      values.push(String(req.body[key]).slice(0, 100));
      idx++;
    }
  }
  if (fields.length) {
    await pool.query(`UPDATE users SET ${fields.join(',')} WHERE id=$${idx}`, [...values, u.id]);
  }
  res.json({ ok: true });
});

// ─── 3. USDT Deposits ─────────────────────────────────────

app.get('/api/deposit/addresses', auth, async (req, res) => {
  const u = (req as Authed).user;
  const bep20 = await getDepositAddress(u.id, 'BEP20');
  const trc20 = await getDepositAddress(u.id, 'TRC20');
  res.json({
    bep20: { address: bep20, network: 'BSC (BEP20)', min_deposit: config.minDepositUsdt },
    trc20: { address: trc20, network: 'Tron (TRC20)', min_deposit: config.minDepositUsdt },
  });
});

app.get('/api/deposits', auth, async (req, res) => {
  const u = (req as Authed).user;
  const deposits = await getDepositHistory(u.id);
  res.json({ deposits });
});

// Admin: trigger manual scan
app.post('/api/admin/scan-deposits', admin, async (_req, res) => {
  const bep20Count = await scanChain('BEP20');
  const trc20Count = await scanChain('TRC20');
  res.json({ bep20_processed: bep20Count, trc20_processed: trc20Count });
});

// Admin: all deposits
app.get('/api/admin/deposits', admin, async (_req, res) => {
  const deposits = await getAllDeposits();
  res.json({ deposits });
});

// ─── 4. Rate ──────────────────────────────────────────────

app.get('/api/rate', async (_req, res) => {
  const r = await getRate();
  res.json({ rate: r.rate, base: r.base, spread: r.spread });
});

// ─── 5. Withdraw by UPI QR ────────────────────────────────

app.post('/api/upi/parse', auth, async (req, res) => {
  await assertNotBlocked((req as Authed).user.id);
  res.json(parseUpi(str(req.body?.payload, 'QR text', 1000)));
});

app.post('/api/quote', auth, async (req, res) => {
  const u = (req as Authed).user;
  await assertNotBlocked(u.id);
  await assertKyc(u.id);

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
  const token = jwt.sign({ typ: 'quote', uid: u.id, q }, config.jwtSecret, { expiresIn: config.quoteTtlSeconds });
  res.json({ quote: token, expires_in: config.quoteTtlSeconds, vpa: q.vpa, name: q.name, inr: q.inr, usdt: q.usdt, rate: q.rate });
});

app.post('/api/orders', auth, async (req, res) => {
  const u = (req as Authed).user;
  await assertNotBlocked(u.id);
  await assertKyc(u.id);

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

// ─── 6. KYC ───────────────────────────────────────────────

app.get('/api/kyc', auth, async (req, res) => {
  const u = (req as Authed).user;
  const result = await getKycStatus(u.id);
  res.json(result);
});

app.post('/api/kyc/submit', auth, async (req, res) => {
  const u = (req as Authed).user;
  const docs = req.body?.documents;
  if (!Array.isArray(docs) || !docs.length) throw new AppError(400, 'At least one document is required');
  for (const d of docs) {
    if (!d.type || !d.url) throw new AppError(400, 'Each document needs type and url');
  }
  const result = await submitKyc(u.id, docs);
  res.json(result);
});

// Admin: KYC review list
app.get('/api/admin/kyc/pending', admin, async (_req, res) => {
  const pending = await getPendingKyc();
  res.json({ pending });
});

// Admin: Review a user's KYC
app.post('/api/admin/kyc/review', admin, async (req, res) => {
  const adminUser = (req as Authed).user;
  const targetUserId = intParam(req.body?.user_id, 'user');
  const decision = req.body?.decision;
  if (!['verified', 'rejected'].includes(decision)) throw new AppError(400, 'Decision must be verified or rejected');
  const notes = String(req.body?.notes || '').slice(0, 300);
  const result = await reviewKyc(adminUser.id, targetUserId, decision, notes);
  res.json(result);
});

// ─── 7. Block/unblock users ───────────────────────────────

app.post('/api/admin/users/:id/block', admin, async (req, res) => {
  const adminUser = (req as Authed).user;
  const targetId = intParam(req.params.id, 'user');
  const reason = str(req.body?.reason || 'Blocked by admin', 'reason', 300);
  await blockUser(adminUser.id, targetId, reason);
  res.json({ ok: true, blocked: true });
});

app.post('/api/admin/users/:id/unblock', admin, async (req, res) => {
  const adminUser = (req as Authed).user;
  const targetId = intParam(req.params.id, 'user');
  const note = String(req.body?.note || 'Unblocked by admin').slice(0, 300);
  await unblockUser(adminUser.id, targetId, note);
  res.json({ ok: true, blocked: false });
});

// ─── 8. IP duplicate detection ────────────────────────────

app.get('/api/admin/ip-duplicates', admin, async (_req, res) => {
  const report = await duplicateIpReport();
  res.json({ duplicates: report });
});

app.get('/api/admin/ip-siblings/:ip', admin, async (req, res) => {
  const ip = String(req.params.ip);
  const siblings = await ipSiblings(ip);
  res.json({ ip, users: siblings });
});

// ─── 9. User list (admin) ─────────────────────────────────

app.get('/api/admin/users', admin, async (req, res) => {
  const limit = Math.min(Number((req.query as any).limit) || 50, 200);
  const offset = Number((req.query as any).offset) || 0;
  const users = await pool.query(
    `SELECT id, email, phone, full_name, country, city, kyc_status, blocked, block_reason,
            is_admin, referral_code, last_login_ip, last_login_at, created_at
     FROM users ORDER BY id DESC LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  const total = await pool.query('SELECT count(*)::int AS c FROM users');
  res.json({ users: users.rows, total: total.rows[0].c });
});

app.get('/api/admin/users/:id', admin, async (req, res) => {
  const id = intParam(req.params.id, 'user');
  const user = await pool.query(
    `SELECT u.*,
            (SELECT json_agg(json_build_object('ip', lh.ip, 'device', lh.device, 'country', lh.country, 'login_at', lh.login_at)
             FROM login_history lh WHERE lh.user_id=u.id ORDER BY lh.login_at DESC LIMIT 20) AS login_history,
            (SELECT json_agg(json_build_object('id', k.id, 'type', k.doc_type, 'url', k.file_url, 'verified', k.verified, 'submitted', k.submitted_at))
             FROM kyc_documents k WHERE k.user_id=u.id) AS kyc_documents,
            (SELECT json_agg(json_build_object('chain', da.chain, 'address', da.address, 'created', da.created_at))
             FROM deposit_addresses da WHERE da.user_id=u.id) AS deposit_addresses
     FROM users u WHERE u.id=$1`,
    [id],
  );
  if (!user.rows[0]) throw new AppError(404, 'User not found');
  res.json({ user: user.rows[0] });
});

// ─── 10. Admin overview (enhanced) ────────────────────────

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
    `SELECT o.id, u.email, u.phone, m.name AS merchant, o.payee_vpa, o.payee_name, o.inr_amount, o.usdt_amount, o.rate,
            o.status, o.proof, o.created_at
     FROM orders o JOIN users u ON u.id=o.user_id JOIN merchants m ON m.id=o.merchant_id
     ORDER BY o.id DESC LIMIT 100`,
  );
  const merchants = await pool.query(`SELECT ${MERCHANT_COLS}, ${MERCHANT_STATS} FROM merchants m ORDER BY m.id`);
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
  const check = await pool.query(
    `SELECT a.currency, COALESCE(SUM(e.amount),0)::text AS total
     FROM entries e JOIN accounts a ON a.id=e.account_id GROUP BY a.currency`,
  );
  const rate = await getRate();
  const userStats = await pool.query(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE kyc_status='pending')::int AS kyc_pending,
            count(*) FILTER (WHERE blocked)::int AS blocked,
            count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS new_today
     FROM users`,
  );
  const depositStats = await pool.query(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE status='credited')::int AS credited,
            COALESCE(SUM(amount) FILTER (WHERE status='credited'),0)::numeric(20,2)::text AS total_credited
     FROM deposit_transactions`,
  );
  const ipDuplicates = await pool.query(
    `SELECT count(*)::int AS flagged FROM ip_registry WHERE flagged=true`,
  );

  res.json({
    rate: { base: rate.base, spread: rate.spread, user_rate: rate.rate },
    today: today.rows[0],
    orders: orders.rows,
    merchants: merchants.rows,
    balances: balances.rows,
    ledger_check: check.rows,
    telegram: !!config.telegramToken,
    users: userStats.rows[0],
    deposits: depositStats.rows[0],
    ip_duplicates: ipDuplicates.rows[0].flagged,
  });
});

app.post('/api/admin/rate', admin, async (req, res) => {
  const r = await setRate(String(req.body?.base ?? ''), String(req.body?.spread ?? ''));
  res.json({ base: r.base, spread: r.spread, user_rate: r.rate });
});

// ─── merchants ────────────────────────────────────────────

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
    `SELECT o.id, u.email, u.phone, o.payee_vpa, o.payee_name, o.inr_amount, o.usdt_amount, o.status, o.proof, o.created_at
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
      id: s.id, created_at: s.created_at, inr: s.inr,
      note: String(s.ref || '').replace(/^merchant:\d+\s*/, ''),
    })),
  });
});

app.post('/api/admin/merchants/:id/active', admin, async (req, res) => {
  await pool.query('UPDATE merchants SET active=$1 WHERE id=$2',
    [!!req.body?.active, intParam(req.params.id, 'merchant')]);
  res.json({ ok: true });
});

app.post('/api/admin/merchants/:id/relink', admin, async (req, res) => {
  const r = await pool.query('UPDATE merchants SET telegram_chat_id=NULL, link_code=$1 WHERE id=$2 RETURNING link_code', [
    newLinkCode(), intParam(req.params.id, 'merchant'),
  ]);
  if (!r.rows[0]) throw new AppError(404, 'Merchant not found');
  res.json(r.rows[0]);
});

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

// ─── errors ───────────────────────────────────────────────

app.use('/api', (_req, _res) => { throw new AppError(404, 'Not found'); });
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof AppError) return res.status(err.status).json({ error: err.message });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

// ─── start ────────────────────────────────────────────────

async function main() {
  await migrate();
  try { await seedMain(); } catch (e: any) { console.warn('Seed skipped:', e.message); }
  await pool.query('SELECT 1 FROM orders LIMIT 1').catch(() => {
    console.error('Database not ready.'); process.exit(1);
  });

  // Ensure master wallets exist for deposits
  try {
    await ensureMasterWallet('BEP20');
    await ensureMasterWallet('TRC20');
  } catch (e: any) {
    console.warn('Wallet init skipped (may need secp256k1):', e.message);
  }

  // Order expiry job
  setInterval(async () => {
    try {
      for (const o of await expireOld()) {
        console.log(`Order #${o.id} expired`);
        notifyMerchant(o.merchant_id, `Order #${o.id} (INR ${o.inr_amount}) expired. Do not pay it.`).catch(() => {});
      }
    } catch (e) { console.error('Expiry job failed:', e); }
  }, 15_000);

  // Deposit scanner
  setInterval(async () => {
    try {
      await scanChain('BEP20');
      await scanChain('TRC20');
    } catch (e: any) { console.error('Deposit scan failed:', e.message); }
  }, config.depositScanIntervalSeconds * 1000);

  startBot();

  const port = Number(process.env.PORT) || config.port;
  app.listen(port, '0.0.0.0', () => {
    console.log(`\n*** USDT to INR Desk ***`);
    console.log(`Running on port ${port}`);
    console.log(`Deposits: BEP20 + TRC20 (scan every ${config.depositScanIntervalSeconds}s)`);
    console.log(`Phone auth: ${config.twilioSid ? 'Twilio SMS' : 'DEV (console)'}`);
  });
}

main().catch((e) => { console.error('Fatal startup error:', e); process.exit(1); });