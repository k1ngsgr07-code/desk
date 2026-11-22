import 'dotenv/config';

const ival = (k: string, def: string) => (process.env[k] || def);

export const config = {
  // ---- database ----
  databaseUrl: process.env.DATABASE_URL || 'postgres://postgres:password@localhost:5432/desk',

  // ---- auth ----
  jwtSecret: process.env.JWT_SECRET || 'change-me-long-random-string',
  jwtExpiry: '12h',

  // ---- Telegram bot ----
  telegramToken: (() => {
    const t = process.env.TELEGRAM_BOT_TOKEN || '';
    return t && t !== 'your-token-from-BotFather' ? t : '';
  })(),

  // ---- rates ----
  baseRateInr: ival('BASE_RATE_INR', '88.00'),
  spreadPercent: ival('SPREAD_PERCENT', '1.5'),

  // ---- server ----
  port: Number(process.env.PORT || 3000),

  // ---- SMS OTP (Twilio) ----
  twilioSid: process.env.TWILIO_ACCOUNT_SID || '',
  twilioToken: process.env.TWILIO_AUTH_TOKEN || '',
  twilioFrom: process.env.TWILIO_PHONE_NUMBER || '',
  otpExpirySeconds: 300,
  maxOtpAttempts: 5,

  // ---- blockchain wallets ----
  walletEncryptionKey: process.env.WALLET_ENCRYPTION_KEY || 'change-me-32-char-key-here!!!!',
  bep20RpcUrl: process.env.BEP20_RPC_URL || 'https://bsc-dataseed.binance.org',
  trc20RpcUrl: process.env.TRC20_RPC_URL || 'https://api.trongrid.io',
  // Tatum API key (optional, used as primary block scanner)
  tatumApiKey: process.env.TATUM_API_KEY || '',

  // ---- deposits ----
  minDepositUsdt: 10,
  minConfirmationsBep20: 10,
  minConfirmationsTrc20: 19,
  depositScanIntervalSeconds: 30,
  usdtContractBep20: '0x55d398326f99059fF775485246999027B3197955',
  usdtContractTrc20: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',

  // ---- security ----
  autoBlockIpThreshold: 3,   // flag IPs when 3+ accounts share them
  maxLoginAttempts: 5,

  // ---- limits ----
  maxTestDepositUsdt: 10_000,
  maxOrderInr: 100_000,
  quoteTtlSeconds: 120,
  orderExpirySeconds: 300,

  // ---- URLs (for file uploads) ----
  appUrl: process.env.APP_URL || 'http://localhost:3000',
};