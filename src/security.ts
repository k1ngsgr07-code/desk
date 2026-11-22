// Security: IP tracking, duplicate detection, user blocking, login history.
import { pool } from './db';
import { AppError } from './ledger';

export type LoginInfo = {
  ip: string;
  device?: string;
  userAgent?: string;
  country?: string;
  city?: string;
};

/** Record a login in history and update the user's last-ip fields. */
export async function recordLogin(userId: number, info: LoginInfo) {
  await pool.query(
    `INSERT INTO login_history(user_id, ip, device, user_agent, country, city)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [userId, info.ip, info.device || null, info.userAgent || null, info.country || null, info.city || null],
  );
  await pool.query(
    `UPDATE users SET last_login_ip=$1, last_login_at=now(), last_login_device=$2 WHERE id=$3`,
    [info.ip, info.device || null, userId],
  );
}

/** Check if this IP has too many accounts. Returns true if flagged. */
export async function checkIpDuplicate(ip: string, userId: number): Promise<boolean> {
  await pool.query(
    `INSERT INTO ip_registry(ip, user_count, first_seen, last_seen)
     VALUES ($1, 1, now(), now())
     ON CONFLICT (ip) DO UPDATE SET
       user_count = ip_registry.user_count + 1,
       last_seen = now()`,
    [ip],
  );
  const r = await pool.query('SELECT user_count, flagged FROM ip_registry WHERE ip=$1', [ip]);
  if (!r.rows[0]) return false;
  const count = Number(r.rows[0].user_count);
  // Mark IP as flagged if it crosses the threshold
  if (count >= 3 && !r.rows[0].flagged) {
    await pool.query("UPDATE ip_registry SET flagged=true WHERE ip=$1", [ip]);
    // Optionally auto-block all users on this IP
    const users = await pool.query('SELECT id FROM users WHERE last_login_ip=$1 AND blocked=false', [ip]);
    for (const u of users.rows) {
      if (u.id !== userId) {
        await pool.query(
          `UPDATE users SET blocked=true, block_reason=$1, blocked_at=now() WHERE id=$2`,
          [`Auto-blocked: 3+ accounts from same IP (${ip})`, u.id],
        );
      }
    }
    return true;
  }
  return r.rows[0].flagged;
}

/** Block a user from all transactions. Admin-only. */
export async function blockUser(adminId: number, targetId: number, reason: string) {
  await pool.query(
    `UPDATE users SET blocked=true, block_reason=$1, blocked_at=now() WHERE id=$2`,
    [reason, targetId],
  );
  await pool.query(
    `INSERT INTO admin_actions(admin_id, target_user_id, action, detail) VALUES ($1,$2,'block',$3)`,
    [adminId, targetId, reason],
  );
}

/** Unblock a user. Admin-only. */
export async function unblockUser(adminId: number, targetId: number, note: string) {
  await pool.query(
    `UPDATE users SET blocked=false, block_reason=NULL, blocked_at=NULL WHERE id=$2`,
    [targetId],
  );
  await pool.query(
    `INSERT INTO admin_actions(admin_id, target_user_id, action, detail) VALUES ($1,$2,'unblock',$3)`,
    [adminId, targetId, note],
  );
}

/** Check if a user is blocked. Throws AppError with the reason if blocked. */
export async function assertNotBlocked(userId: number) {
  const r = await pool.query('SELECT blocked, block_reason FROM users WHERE id=$1', [userId]);
  if (r.rows[0]?.blocked) {
    throw new AppError(403,
      `Account blocked: ${r.rows[0].block_reason || 'Contact support'}. Please complete KYC or contact customer care.`,
    );
  }
}

/** Get all accounts sharing the same IP. */
export async function ipSiblings(ip: string) {
  const r = await pool.query(
    `SELECT u.id, u.email, u.phone, u.full_name, u.blocked, u.kyc_status, u.last_login_at
     FROM users u WHERE u.last_login_ip=$1 ORDER BY u.id`,
    [ip],
  );
  return r.rows;
}

/** Get duplicate IP report for admin. */
export async function duplicateIpReport() {
  const r = await pool.query(
    `SELECT ip, user_count, flagged, first_seen, last_seen
     FROM ip_registry WHERE user_count >= 2
     ORDER BY user_count DESC, last_seen DESC`,
  );
  return r.rows;
}