// Blockchain: BEP20 (BSC) and TRC20 (Tron) USDT deposit handling.
// Uses ethers.js for BEP20 key generation, and native crypto for TRC20.
// Deposit monitoring via Tatum API with BSCScan/TronGrid fallbacks.
import crypto from 'crypto';
import { ethers } from 'ethers';
import { pool, tx } from './db';
import { config } from './config';
import { getAccount, post } from './ledger';
import { toMicro } from './money';

// ─── Encryption ───────────────────────────────────────────
const ALGO = 'aes-256-gcm';
const KEY = Buffer.from(config.walletEncryptionKey.padEnd(32, '0').slice(0, 32));

export function encrypt(text: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

export function decrypt(data: string): string {
  const [ivHex, tagHex, encHex] = data.split(':');
  const decipher = crypto.createDecipheriv(ALGO, KEY, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]).toString('utf8');
}

// ─── BEP20 address from private key ───────────────────────
function bep20AddressFromKey(privateKeyHex: string): string {
  const wallet = new ethers.Wallet(privateKeyHex);
  return wallet.address;
}

// ─── TRC20 address from private key ──────────────────────
// Tron uses the same secp256k1 curve as Ethereum but a different address format.
// Address = base58check(0x41 + keccak256(publicKey_without_04_prefix).last20bytes)
function trc20AddressFromKey(privateKeyHex: string): string {
  // Use ethers to get the uncompressed public key
  const signingKey = new ethers.SigningKey(privateKeyHex);
  const pubKeyUncompressed = signingKey.publicKey; // '0x04...'
  const pubKeyBytes = Buffer.from(pubKeyUncompressed.slice(4), 'hex'); // strip 0x04
  const hash = crypto.createHash('sha3-256').update(pubKeyBytes).digest();
  const addr = Buffer.concat([Buffer.from([0x41]), hash.subarray(-20)]);
  return base58checkEncode(addr);
}

function base58checkEncode(buf: Buffer): string {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const h1 = crypto.createHash('sha256').update(buf).digest();
  const checksum = crypto.createHash('sha256').update(h1).digest().subarray(0, 4);
  const data = Buffer.concat([buf, checksum]);

  // Convert to base58
  let num = 0n;
  for (const byte of data) num = (num << 8n) | BigInt(byte);
  let result = '';
  while (num > 0n) {
    result = ALPHABET[Number(num % 58n)] + result;
    num /= 58n;
  }
  // Leading zeros
  for (const byte of buf) {
    if (byte === 0) result = '1' + result;
    else break;
  }
  return result;
}

// ─── HD-style child key derivation ───────────────────────
function deriveChildKey(masterPrivateKeyHex: string, index: number): string {
  const hmac = crypto.createHmac('sha512', Buffer.from('Desk wallet v1'));
  const masterKeyBytes = Buffer.from(masterPrivateKeyHex.replace('0x', ''), 'hex');
  const idxBuf = Buffer.alloc(4);
  idxBuf.writeUInt32BE(index);
  hmac.update(Buffer.concat([masterKeyBytes, idxBuf]));
  return hmac.digest('hex').slice(0, 64); // 32 bytes = 64 hex chars
}

// ─── Master wallet ───────────────────────────────────────

export interface WalletInfo {
  id: number; chain: string; address: string;
}

export async function ensureMasterWallet(chain: 'BEP20' | 'TRC20'): Promise<WalletInfo> {
  const existing = await pool.query(
    'SELECT id, address FROM wallets WHERE chain=$1 AND label=$2', [chain, 'master'],
  );
  if (existing.rows[0]) return { id: existing.rows[0].id, chain, address: existing.rows[0].address };

  const wallet = ethers.Wallet.createRandom();
  const privateKey = wallet.privateKey; // 0x-prefixed
  let address: string;
  if (chain === 'BEP20') {
    address = wallet.address;
  } else {
    address = trc20AddressFromKey(privateKey);
  }

  const encKey = encrypt(privateKey);
  const r = await pool.query(
    `INSERT INTO wallets(chain, label, address, private_key_encrypted) VALUES ($1,'master',$2,$3) RETURNING id`,
    [chain, address, encKey],
  );
  console.log(`🔑 New ${chain} master wallet: ${address}`);
  return { id: r.rows[0].id, chain, address };
}

// ─── Per-user deposit addresses ──────────────────────────

export async function getDepositAddress(userId: number, chain: 'BEP20' | 'TRC20'): Promise<string> {
  const existing = await pool.query(
    'SELECT address FROM deposit_addresses WHERE user_id=$1 AND chain=$2', [userId, chain],
  );
  if (existing.rows[0]) return existing.rows[0].address;

  const wallet = await ensureMasterWallet(chain);
  const maxIdx = await pool.query(
    'SELECT COALESCE(MAX(derivation_index), -1) AS m FROM deposit_addresses WHERE wallet_id=$1', [wallet.id],
  );
  const index = Number(maxIdx.rows[0].m) + 1;

  const masterPk = decrypt(
    (await pool.query('SELECT private_key_encrypted FROM wallets WHERE id=$1', [wallet.id])).rows[0].private_key_encrypted,
  );
  const childKey = deriveChildKey(masterPk, index);
  const address = chain === 'BEP20' ? bep20AddressFromKey('0x' + childKey) : trc20AddressFromKey('0x' + childKey);

  await pool.query(
    `INSERT INTO deposit_addresses(user_id, chain, address, derivation_index, wallet_id) VALUES ($1,$2,$3,$4,$5)`,
    [userId, chain, address, index, wallet.id],
  );
  return address;
}

export async function getUserAddresses(userId: number) {
  const r = await pool.query(
    'SELECT chain, address, created_at FROM deposit_addresses WHERE user_id=$1 ORDER BY chain', [userId],
  );
  return r.rows;
}

// ─── Blockchain scanning (Tatum API + fallbacks) ──────────

async function fetchTatumTransactions(chain: 'BEP20' | 'TRC20', address: string): Promise<Array<{
  txHash: string; from: string; to: string; amount: string; blockNumber: number; confirmations: number;
}>> {
  if (!config.tatumApiKey) return [];
  const tatumChain = chain === 'BEP20' ? 'bsc' : 'tron';
  const tokenAddr = chain === 'BEP20' ? config.usdtContractBep20 : config.usdtContractTrc20;
  const url = `https://api.tatum.io/v3/blockchain/token/transaction/${tatumChain}/${tokenAddr}/${address}?pageSize=50`;

  try {
    const resp = await fetch(url, { headers: { 'x-api-key': config.tatumApiKey } });
    if (!resp.ok) return [];
    const data = (await resp.json()) as any[];
    return (data || []).map((tx: any) => ({
      txHash: tx.hash || tx.transactionHash || tx.txID || '',
      from: tx.from || tx.sender || tx.fromAddress || '',
      to: tx.to || tx.recipient || tx.toAddress || '',
      amount: String(tx.amount || tx.value || '0'),
      blockNumber: Number(tx.blockNumber || tx.block || 0),
      confirmations: Number(tx.confirmations || tx.confirmationNumber || 0),
    }));
  } catch { return []; }
}

async function fetchBscScanTransactions(address: string): Promise<Array<{
  txHash: string; from: string; to: string; amount: string; blockNumber: number; confirmations: number;
}>> {
  const key = process.env.BSCSCAN_API_KEY || '';
  const url = `https://api.bscscan.com/api?module=account&action=tokentx&contractaddress=${config.usdtContractBep20}&address=${address}&sort=desc&apikey=${key}`;
  try {
    const resp = await fetch(url);
    const data = (await resp.json()) as any;
    if (data.status !== '1') return [];
    return (data.result || []).map((tx: any) => ({
      txHash: tx.hash,
      from: tx.from,
      to: tx.to,
      amount: String(Number(tx.value) / 1e18),
      blockNumber: Number(tx.blockNumber),
      confirmations: Number(tx.confirmations || 0),
    }));
  } catch { return []; }
}

export async function scanChain(chain: 'BEP20' | 'TRC20'): Promise<number> {
  const addresses = await pool.query(
    `SELECT da.address, da.user_id FROM deposit_addresses da
     JOIN users u ON u.id = da.user_id
     WHERE da.chain=$1 AND u.blocked=false`, [chain],
  );
  if (!addresses.rows.length) return 0;

  let credited = 0;
  for (const row of addresses.rows) {
    let txs: Array<{ txHash: string; from: string; to: string; amount: string; blockNumber: number; confirmations: number }> = [];

    if (config.tatumApiKey) {
      txs = await fetchTatumTransactions(chain, row.address);
    } else if (chain === 'BEP20') {
      txs = await fetchBscScanTransactions(row.address);
    }

    for (const tx of txs) {
      if (Number(tx.amount) <= 0) continue;
      try {
        await processDeposit({
          userId: row.user_id, chain, txHash: tx.txHash,
          fromAddress: tx.from, toAddress: tx.to, amount: tx.amount,
          blockNumber: tx.blockNumber, confirmations: tx.confirmations,
        });
        credited++;
      } catch (e: any) {
        if (e.code !== '23505') console.error(`Deposit error (${tx.txHash.slice(0, 12)}):`, e.message);
      }
    }
  }
  return credited;
}

async function processDeposit(dep: {
  userId: number; chain: string; txHash: string; fromAddress: string;
  toAddress: string; amount: string; blockNumber: number; confirmations: number;
}) {
  const minConf = dep.chain === 'BEP20' ? config.minConfirmationsBep20 : config.minConfirmationsTrc20;
  const amount = Number(dep.amount);
  if (amount < config.minDepositUsdt) return;

  return tx(async (c) => {
    const existing = await c.query(
      'SELECT id, status FROM deposit_transactions WHERE chain=$1 AND tx_hash=$2',
      [dep.chain, dep.txHash],
    );

    if (existing.rows[0]) {
      const ex = existing.rows[0];
      if (ex.status === 'credited') return;

      const newStatus = dep.confirmations >= minConf ? 'confirming' : 'pending';
      await c.query(
        `UPDATE deposit_transactions SET confirmations=$1, block_number=$2, status=$3 WHERE id=$4`,
        [dep.confirmations, dep.blockNumber, newStatus, ex.id],
      );

      if (dep.confirmations >= minConf) {
        await creditDeposit(c, ex.id, dep.userId, dep.chain, dep.txHash, amount);
      }
      return;
    }

    const status = dep.confirmations >= minConf ? 'confirming' : 'pending';
    const r = await c.query(
      `INSERT INTO deposit_transactions(user_id, chain, tx_hash, from_address, to_address, amount, block_number, confirmations, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [dep.userId, dep.chain, dep.txHash, dep.fromAddress, dep.toAddress, amount, dep.blockNumber, dep.confirmations, status],
    );

    if (dep.confirmations >= minConf) {
      await creditDeposit(c, r.rows[0].id, dep.userId, dep.chain, dep.txHash, amount);
    }
  });
}

async function creditDeposit(c: any, depositId: number, userId: number, chain: string, txHash: string, amount: number) {
  const external = await getAccount(c, 'house', null, 'USDT', 'external');
  const wallet = await getAccount(c, 'user', userId, 'USDT', 'wallet');
  const usdtMicro = toMicro(amount.toFixed(6));

  const journalId = await post(c, 'deposit', `chain:${chain}:${txHash.slice(0, 16)}`, [
    { account: external, amount: -usdtMicro },
    { account: wallet, amount: usdtMicro },
  ]);

  await c.query(
    `UPDATE deposit_transactions SET status='credited', credited_at=now(), journal_id=$1 WHERE id=$2`,
    [journalId, depositId],
  );
  console.log(`✅ Credited ${amount} USDT (${chain}) to user #${userId}`);
}

export async function getDepositHistory(userId: number, limit = 50) {
  const r = await pool.query(
    `SELECT id, chain, tx_hash, from_address, to_address, amount, confirmations, status, credited_at, detected_at
     FROM deposit_transactions WHERE user_id=$1 ORDER BY id DESC LIMIT $2`,
    [userId, limit],
  );
  return r.rows;
}

export async function getAllDeposits(limit = 100) {
  const r = await pool.query(
    `SELECT dt.*, u.email, u.phone FROM deposit_transactions dt
     JOIN users u ON u.id=dt.user_id ORDER BY dt.id DESC LIMIT $1`, [limit],
  );
  return r.rows;
}