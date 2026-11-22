// Seeds one test user, one admin, two test merchants, and a fake UPI QR image.
// Logins come from .env (SEED_*). Safe to run again.
import path from 'path';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import QRCode from 'qrcode';
import './config';
import { pool } from './db';
import { migrate } from './migrate';

export const FAKE_UPI = 'upi://pay?pa=teststore@upi&pn=Test%20Chai%20Stall&am=500.00&cu=INR';

async function upsertUser(email: string, password: string, isAdmin: boolean) {
  await pool.query(
    `INSERT INTO users(email, password_hash, is_admin) VALUES ($1,$2,$3)
     ON CONFLICT (email) DO UPDATE SET password_hash=EXCLUDED.password_hash, is_admin=EXCLUDED.is_admin`,
    [email.toLowerCase(), await bcrypt.hash(password, 10), isAdmin],
  );
}

export async function seedMain() {
  await migrate();
  const env = process.env;
  const userEmail = env.SEED_USER_EMAIL || 'user@desk.test';
  const adminEmail = env.SEED_ADMIN_EMAIL || 'admin@desk.test';
  await upsertUser(userEmail, env.SEED_USER_PASSWORD || 'testuser123', false);
  await upsertUser(adminEmail, env.SEED_ADMIN_PASSWORD || 'testadmin123', true);

  for (const name of ['Test Merchant A', 'Test Merchant B']) {
    const exists = await pool.query('SELECT 1 FROM merchants WHERE name=$1', [name]);
    if (!exists.rows[0]) {
      await pool.query('INSERT INTO merchants(name, link_code) VALUES ($1,$2)', [
        name,
        crypto.randomBytes(4).toString('hex').toUpperCase(),
      ]);
    }
  }

  await QRCode.toFile(path.join(__dirname, '..', 'public', 'test-qr.png'), FAKE_UPI, { width: 400, margin: 2 });

  const m = await pool.query('SELECT name, link_code FROM merchants ORDER BY id');
  console.log('Seeded (TEST BUILD - NO REAL MONEY):');
  console.log(`  user:  ${userEmail}   (password: SEED_USER_PASSWORD in .env)`);
  console.log(`  admin: ${adminEmail}  (password: SEED_ADMIN_PASSWORD in .env)`);
  for (const row of m.rows) console.log(`  merchant: ${row.name}  ->  in Telegram send:  /link ${row.link_code}`);
  console.log('  fake QR: public/test-qr.png');
}

if (require.main === module) {
  seedMain()
    .catch((e) => {
      console.error('Seed failed:', e.message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
