// Auth: Phone number OTP login (Twilio SMS), JWT sessions, signup/login flow.
import crypto from 'crypto';
import { pool } from './db';
import { config } from './config';
import { AppError } from './ledger';

/** Generate a 6-digit OTP and store it. */
async function sendOtp(phone: string, purpose: 'signup' | 'login'): Promise<string> {
  // Check rate limit: max 5 OTPs in the last 15 minutes
  const recent = await pool.query(
    `SELECT count(*)::int AS c FROM otp_codes WHERE phone=$1 AND created_at > now() - interval '15 minutes'`,
    [phone],
  );
  if (recent.rows[0].c >= config.maxOtpAttempts) {
    throw new AppError(429, 'Too many OTP requests. Please wait 15 minutes.');
  }

  // Expire old codes for this phone+purpose
  await pool.query(
    `UPDATE otp_codes SET used=true WHERE phone=$1 AND purpose=$2 AND used=false`,
    [phone, purpose],
  );

  const code = String(Math.floor(100000 + Math.random() * 900000));
  await pool.query(
    `INSERT INTO otp_codes(phone, code, purpose, expires_at) VALUES ($1,$2,$3, now() + interval '1 second' * $4)`,
    [phone, code, purpose, config.otpExpirySeconds],
  );

  // Send via Twilio if configured
  if (config.twilioSid && config.twilioToken && config.twilioFrom) {
    try {
      const auth = Buffer.from(`${config.twilioSid}:${config.twilioToken}`).toString('base64');
      const body = new URLSearchParams({
        To: phone,
        From: config.twilioFrom,
        Body: `Your Desk verification code is: ${code}. Valid for 5 minutes.`,
      });
      const resp = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${config.twilioSid}/Messages.json`,
        { method: 'POST', headers: { Authorization: `Basic ${auth}` }, body },
      );
      if (!resp.ok) {
        const err = await resp.text();
        console.error(`Twilio SMS failed for ${phone}: ${err}`);
        throw new AppError(500, 'Failed to send SMS. Try again.');
      }
    } catch (e) {
      if (e instanceof AppError) throw e;
      console.error(`Twilio error: ${e}`);
      throw new AppError(500, 'SMS service unavailable. Try again.');
    }
  } else {
    // No Twilio configured — log the OTP to console (dev mode)
    console.log(`\n📱 OTP for ${phone} (${purpose}): ${code}\n`);
  }

  return code;
}

/** Send OTP for signup or login. */
export async function requestOtp(phone: string, purpose: 'signup' | 'login') {
  // Validate phone: E.164 format (+country number)
  if (!/^\+[1-9]\d{6,14}$/.test(phone)) {
    throw new AppError(400, 'Enter a valid phone number with country code, e.g. +919876543210');
  }

  if (purpose === 'signup') {
    const exists = await pool.query('SELECT id, blocked FROM users WHERE phone=$1', [phone]);
    if (exists.rows[0]) {
      if (exists.rows[0].blocked) {
        throw new AppError(403, 'This phone number is blocked. Contact customer care.');
      }
      throw new AppError(409, 'This phone number is already registered. Please log in instead.');
    }
  } else {
    const exists = await pool.query('SELECT id, blocked, block_reason FROM users WHERE phone=$1', [phone]);
    if (!exists.rows[0]) {
      throw new AppError(404, 'No account found with this phone number. Please sign up first.');
    }
    if (exists.rows[0].blocked) {
      throw new AppError(403,
        `Account blocked: ${exists.rows[0].block_reason || 'Contact support'}. Please complete KYC to unlock.`,
      );
    }
  }

  await sendOtp(phone, purpose);
  return { ok: true, message: 'OTP sent' };
}

import jwt from 'jsonwebtoken';

function sign(userId: number) {
  return jwt.sign({ typ: 'login', uid: userId }, config.jwtSecret, { expiresIn: config.jwtExpiry } as any);
}

/** Verify OTP and create/return user session. */
export async function verifyOtp(
  phone: string,
  code: string,
  purpose: 'signup' | 'login',
  extra?: { email?: string; password?: string; ip?: string; device?: string },
) {
  const r = await pool.query(
    `SELECT id, code, used, expires_at FROM otp_codes
     WHERE phone=$1 AND purpose=$2 AND used=false
     ORDER BY id DESC LIMIT 1`,
    [phone, purpose],
  );
  const row = r.rows[0];
  if (!row) throw new AppError(400, 'No OTP found. Please request a new one.');
  if (row.used) throw new AppError(400, 'OTP already used.');
  if (new Date(row.expires_at) < new Date()) throw new AppError(400, 'OTP expired. Request a new one.');
  if (row.code !== code) throw new AppError(401, 'Wrong OTP.');

  // Mark used
  await pool.query('UPDATE otp_codes SET used=true WHERE id=$1', [row.id]);

  let userId: number;
  let isNew = false;
  if (purpose === 'signup') {
    // Create user
    const passwordHash = extra?.password
      ? await (await import('bcryptjs')).hash(extra.password, 10)
      : null;
    const email = extra?.email?.toLowerCase() || null;
    const referralCode = crypto.randomBytes(4).toString('hex').toUpperCase();
    const newUser = await pool.query(
      `INSERT INTO users(email, password_hash, phone, phone_verified, referral_code, created_ip)
       VALUES ($1,$2,$3,true,$4,$5) RETURNING id`,
      [email, passwordHash, phone, referralCode, extra?.ip || null],
    );
    userId = newUser.rows[0].id;
    isNew = true;
  } else {
    const user = await pool.query('SELECT id FROM users WHERE phone=$1', [phone]);
    userId = user.rows[0].id;
    await pool.query('UPDATE users SET phone_verified=true WHERE id=$1', [userId]);
  }

  // Optionally set password for existing email-less accounts
  if (purpose === 'login' && extra?.password) {
    const bcrypt = await import('bcryptjs');
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(extra.password, 10), userId]);
  }

  // Record login
  if (extra?.ip) {
    const { recordLogin } = await import('./security.js');
    await recordLogin(userId, { ip: extra.ip, device: extra.device, userAgent: '' });
  }

  const token = sign(userId);
  const userRow = await pool.query(
    'SELECT id, email, phone, full_name, is_admin, kyc_status, blocked FROM users WHERE id=$1',
    [userId],
  );
  return {
    token,
    user: userRow.rows[0],
    is_new: isNew,
  };
}

// Re-export the sign function for server use
export { sign };