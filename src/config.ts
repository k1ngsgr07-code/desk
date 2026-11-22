import 'dotenv/config';

export const BANNER = 'USDT to INR Desk';

const token = process.env.TELEGRAM_BOT_TOKEN || '';

export const config = {
  databaseUrl: process.env.DATABASE_URL || 'postgres://postgres:password@localhost:5432/desk',
  jwtSecret: process.env.JWT_SECRET || 'change-me-long-random-string',
  telegramToken: token && token !== 'your-token-from-BotFather' ? token : '',
  baseRateInr: process.env.BASE_RATE_INR || '88.00',
  spreadPercent: process.env.SPREAD_PERCENT || '1.5',
  port: Number(process.env.PORT || 3000),
  // 127.0.0.1 = this computer only. 0.0.0.0 = also phones on the same Wi-Fi (test only).
  host: process.env.HOST || '127.0.0.1',
  httpsPort: Number(process.env.HTTPS_PORT || 3443), // used only when HOST=0.0.0.0 (live camera needs https)

  quoteTtlSeconds: 120,        // a quote is locked for 2 minutes
  orderExpirySeconds: 300,     // pending orders expire after 5 minutes
  // TODO(LIMITS): real per-user, per-day and per-merchant limits. These are test caps only.
  maxTestDepositUsdt: 10_000,
  maxOrderInr: 100_000,
};
