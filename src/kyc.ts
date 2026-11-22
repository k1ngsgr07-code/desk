// KYC: Identity verification document upload and admin review.
import { pool } from './db';
import { AppError } from './ledger';

export type KycDocument = {
  id: number;
  user_id: number;
  doc_type: string;
  file_url: string;
  verified: boolean;
  notes: string | null;
  submitted_at: string;
  reviewed_at: string | null;
};

/** Upload KYC documents for a user. */
export async function submitKyc(
  userId: number,
  documents: Array<{ type: string; url: string }>,
) {
  // Check current status
  const user = await pool.query('SELECT kyc_status FROM users WHERE id=$1', [userId]);
  if (!user.rows[0]) throw new AppError(404, 'User not found');
  if (user.rows[0].kyc_status === 'verified') throw new AppError(400, 'KYC already verified');
  if (user.rows[0].kyc_status === 'pending') throw new AppError(400, 'KYC review already in progress');

  for (const doc of documents) {
    if (!['id_front', 'id_back', 'selfie', 'address_proof'].includes(doc.type)) {
      throw new AppError(400, `Invalid document type: ${doc.type}`);
    }
    await pool.query(
      `INSERT INTO kyc_documents(user_id, doc_type, file_url) VALUES ($1,$2,$3)`,
      [userId, doc.type, doc.url],
    );
  }

  await pool.query(`UPDATE users SET kyc_status='pending' WHERE id=$1`, [userId]);
  return { status: 'pending' };
}

/** Get KYC status and documents for a user. */
export async function getKycStatus(userId: number) {
  const user = await pool.query('SELECT kyc_status, blocked, block_reason FROM users WHERE id=$1', [userId]);
  if (!user.rows[0]) throw new AppError(404, 'User not found');

  const docs = await pool.query(
    'SELECT id, doc_type, file_url, verified, notes, submitted_at, reviewed_at FROM kyc_documents WHERE user_id=$1 ORDER BY id',
    [userId],
  );

  return {
    status: user.rows[0].kyc_status,
    blocked: user.rows[0].blocked,
    block_reason: user.rows[0].block_reason,
    documents: docs.rows,
  };
}

/** Admin: review a KYC submission. */
export async function reviewKyc(
  adminId: number,
  targetUserId: number,
  decision: 'verified' | 'rejected',
  notes: string,
) {
  const user = await pool.query(
    'SELECT id, kyc_status FROM users WHERE id=$1',
    [targetUserId],
  );
  if (!user.rows[0]) throw new AppError(404, 'User not found');
  if (user.rows[0].kyc_status !== 'pending') {
    throw new AppError(400, `Cannot review: user KYC status is "${user.rows[0].kyc_status}"`);
  }

  await pool.query(
    `UPDATE users SET kyc_status=$1, kyc_reviewed_by=$2, kyc_reviewed_at=now() WHERE id=$3`,
    [decision, adminId, targetUserId],
  );
  await pool.query(
    `UPDATE kyc_documents SET verified=$1, reviewed_at=now(), notes=$2 WHERE user_id=$3 AND verified=false`,
    [decision === 'verified', notes || null, targetUserId],
  );
  await pool.query(
    `INSERT INTO admin_actions(admin_id, target_user_id, action, detail) VALUES ($1,$2,$3,$4)`,
    [adminId, targetUserId, `kyc_${decision}`, notes],
  );

  // If rejected, block the user
  if (decision === 'rejected') {
    await pool.query(
      `UPDATE users SET blocked=true, block_reason=$1, blocked_at=now() WHERE id=$2`,
      [`KYC rejected: ${notes || 'Documents not acceptable'}`, targetUserId],
    );
  }

  return { status: decision };
}

/** Admin: get all pending KYC reviews. */
export async function getPendingKyc(limit = 50) {
  const r = await pool.query(
    `SELECT u.id, u.email, u.phone, u.full_name, u.country, u.city, u.kyc_status, u.created_at,
            (SELECT json_agg(json_build_object('id', k.id, 'type', k.doc_type, 'url', k.file_url, 'submitted', k.submitted_at))
             FROM kyc_documents k WHERE k.user_id=u.id) AS documents
     FROM users u
     WHERE u.kyc_status IN ('pending','rejected')
     ORDER BY u.kyc_status='pending' DESC, u.created_at DESC
     LIMIT $1`,
    [limit],
  );
  return r.rows;
}

/** Assert user has completed KYC. */
export async function assertKyc(userId: number) {
  const r = await pool.query('SELECT kyc_status, blocked FROM users WHERE id=$1', [userId]);
  if (!r.rows[0]) throw new AppError(404, 'User not found');
  if (r.rows[0].kyc_status !== 'verified') {
    throw new AppError(403, 'KYC verification required. Please submit your documents for review.');
  }
}