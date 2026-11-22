-- PRODUCTION SCHEMA v2
-- Phone-auth, KYC, real USDT deposits (BEP20/TRC20), IP tracking, user blocking.
--
-- New tables added with IF NOT EXISTS so the existing migrate flow still works.
-- Run: npm run migrate (auto-runs on every server start)

-- ============================================================================
-- 1. Enhanced users table
-- ============================================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS country TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by INT REFERENCES users(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS blocked BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS block_reason TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS blocked_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_status TEXT DEFAULT 'none' CHECK (kyc_status IN ('none','pending','verified','rejected'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_reviewed_by INT REFERENCES users(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_reviewed_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_ip TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_device TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_ip TEXT;

-- ============================================================================
-- 2. OTP codes (phone verification, login)
-- ============================================================================
CREATE TABLE IF NOT EXISTS otp_codes (
  id SERIAL PRIMARY KEY,
  phone TEXT NOT NULL,
  code TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('signup','login')),
  used BOOLEAN DEFAULT false,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS otp_phone_idx ON otp_codes(phone, purpose, used);

-- ============================================================================
-- 3. Login history (IP + device tracking)
-- ============================================================================
CREATE TABLE IF NOT EXISTS login_history (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  ip TEXT NOT NULL,
  device TEXT,
  user_agent TEXT,
  country TEXT,
  city TEXT,
  login_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_history_user_idx ON login_history(user_id);
CREATE INDEX IF NOT EXISTS login_history_ip_idx ON login_history(ip);

-- ============================================================================
-- 4. KYC documents
-- ============================================================================
CREATE TABLE IF NOT EXISTS kyc_documents (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  doc_type TEXT NOT NULL CHECK (doc_type IN ('id_front','id_back','selfie','address_proof')),
  file_url TEXT NOT NULL,
  verified BOOLEAN DEFAULT false,
  notes TEXT,
  submitted_at TIMESTAMPTZ DEFAULT now(),
  reviewed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS kyc_docs_user_idx ON kyc_documents(user_id);

-- ============================================================================
-- 5. Blockchain wallets (master wallet per chain)
-- ============================================================================
CREATE TABLE IF NOT EXISTS wallets (
  id SERIAL PRIMARY KEY,
  chain TEXT NOT NULL CHECK (chain IN ('BEP20','TRC20')),
  label TEXT NOT NULL,
  address TEXT UNIQUE NOT NULL,
  private_key_encrypted TEXT NOT NULL,       -- AES-256-GCM encrypted with WALLET_ENCRYPTION_KEY
  balance_checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================================
-- 6. Per-user deposit addresses (derived from master wallet)
-- ============================================================================
CREATE TABLE IF NOT EXISTS deposit_addresses (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  chain TEXT NOT NULL CHECK (chain IN ('BEP20','TRC20')),
  address TEXT UNIQUE NOT NULL,
  derivation_index INT NOT NULL,
  wallet_id INT NOT NULL REFERENCES wallets(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (wallet_id, derivation_index)
);
CREATE INDEX IF NOT EXISTS deposit_addr_user_idx ON deposit_addresses(user_id);
CREATE INDEX IF NOT EXISTS deposit_addr_chain_idx ON deposit_addresses(chain, address);

-- ============================================================================
-- 7. Deposit transactions (incoming USDT detected on-chain)
-- ============================================================================
CREATE TABLE IF NOT EXISTS deposit_transactions (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  chain TEXT NOT NULL CHECK (chain IN ('BEP20','TRC20')),
  tx_hash TEXT NOT NULL,
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  amount NUMERIC(20,6) NOT NULL,
  block_number BIGINT,
  confirmations INT DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirming','credited','failed','orphaned')),
  credited_at TIMESTAMPTZ,
  journal_id INT REFERENCES journal(id),
  detected_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (chain, tx_hash)
);
CREATE INDEX IF NOT EXISTS deposit_tx_user_idx ON deposit_transactions(user_id);
CREATE INDEX IF NOT EXISTS deposit_tx_status_idx ON deposit_transactions(status);

-- ============================================================================
-- 8. User notes / admin actions log (block, unblock, KYC review)
-- ============================================================================
CREATE TABLE IF NOT EXISTS admin_actions (
  id SERIAL PRIMARY KEY,
  admin_id INT NOT NULL REFERENCES users(id),
  target_user_id INT REFERENCES users(id),
  action TEXT NOT NULL,
  detail TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_actions_target_idx ON admin_actions(target_user_id);

-- ============================================================================
-- 9. Duplicate IP tracking
-- ============================================================================
CREATE TABLE IF NOT EXISTS ip_registry (
  ip TEXT PRIMARY KEY,
  user_count INT DEFAULT 1,
  first_seen TIMESTAMPTZ DEFAULT now(),
  last_seen TIMESTAMPTZ DEFAULT now(),
  flagged BOOLEAN DEFAULT false
);

-- ============================================================================
-- 10. USDT token contract addresses (used by the blockchain scanner)
-- ============================================================================
CREATE TABLE IF NOT EXISTS token_contracts (
  chain TEXT NOT NULL,
  symbol TEXT NOT NULL,
  contract_address TEXT NOT NULL,
  decimals INT DEFAULT 6,
  PRIMARY KEY (chain, symbol)
);

-- Seed the known USDT contracts
INSERT INTO token_contracts(chain, symbol, contract_address, decimals) VALUES
  ('BEP20', 'USDT', '0x55d398326f99059fF775485246999027B3197955', 18),
  ('TRC20', 'USDT', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 6)
ON CONFLICT DO NOTHING;

-- ============================================================================
-- 11. System settings additions
-- ============================================================================
INSERT INTO settings(key, value) VALUES
  ('min_deposit_usdt', '10'),
  ('min_confirmations_bep20', '10'),
  ('min_confirmations_trc20', '19'),
  ('otp_expiry_seconds', '300'),
  ('max_otp_attempts', '5'),
  ('deposit_scan_interval_seconds', '30'),
  ('auto_block_ip_threshold', '3')
ON CONFLICT DO NOTHING;