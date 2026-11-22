-- TEST BUILD - NO REAL MONEY
-- Every money movement is a journal whose entries sum to zero (per currency).
-- Balances are never stored; they are always SUM(entries.amount).

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  is_admin BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
  -- TODO(KYC): kyc_status, verified identity reference. Required before any real user.
);

CREATE TABLE IF NOT EXISTS merchants (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  telegram_chat_id BIGINT UNIQUE,
  link_code TEXT UNIQUE,          -- merchant sends "/link CODE" to the bot to connect their chat
  active BOOLEAN DEFAULT true
  -- TODO(KYC): merchants need KYB / identity verification too.
);

-- accounts: one per user USDT wallet + hold, one per merchant payable, plus house accounts
CREATE TABLE IF NOT EXISTS accounts (
  id SERIAL PRIMARY KEY,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('user', 'merchant', 'house')),
  owner_id INT,                   -- NULL for house accounts
  currency TEXT NOT NULL CHECK (currency IN ('USDT', 'INR')),
  label TEXT NOT NULL,
  UNIQUE NULLS NOT DISTINCT (owner_type, owner_id, currency, label)
);

CREATE TABLE IF NOT EXISTS journal (
  id SERIAL PRIMARY KEY,
  kind TEXT NOT NULL,             -- deposit, order_hold, order_settle, order_release, merchant_settlement
  ref TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS entries (
  id SERIAL PRIMARY KEY,
  journal_id INT NOT NULL REFERENCES journal(id),
  account_id INT NOT NULL REFERENCES accounts(id),
  amount NUMERIC(20,6) NOT NULL   -- positive credit, negative debit
);
CREATE INDEX IF NOT EXISTS entries_account_idx ON entries(account_id);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  merchant_id INT NOT NULL REFERENCES merchants(id),
  quote_id TEXT UNIQUE NOT NULL,  -- a locked quote can be used for exactly one order
  upi_payload TEXT NOT NULL,      -- raw text from the scanned QR
  payee_vpa TEXT,
  payee_name TEXT,
  inr_amount NUMERIC(20,2) NOT NULL,
  usdt_amount NUMERIC(20,6) NOT NULL,
  rate NUMERIC(10,4) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'paid', 'declined', 'expired')),
  proof TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status);

-- runtime settings the admin can change (base_rate_inr, spread_percent)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Added after the first version (safe to run again)
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS settle_to TEXT;   -- where the desk sends this merchant's settlement (UPI id / bank)
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS note TEXT;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE orders ADD COLUMN IF NOT EXISTS base_rate NUMERIC(10,4);  -- rate before spread, to work out the desk's margin

-- TODO(AUDIT): append-only audit_log table (who did what, when, from where).
