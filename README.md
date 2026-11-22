# USDT to INR Desk - TEST BUILD - NO REAL MONEY

Private prototype for your own testing. Fake USDT, fake rupees, no blockchain connection, no real payments.
The server refuses to start with `NODE_ENV=production` and only listens on `localhost`.

**Do not put real users or real funds on this.** See "Before any real use" at the bottom.

## Run it

You need Node 20 or newer. All commands run inside this `desk/` folder.

```bash
npm install
```

```bash
cp .env.example .env
```

Start Postgres - pick ONE (leave it running in its own terminal window):

```bash
npm run db:embedded
```

(bundled Postgres, nothing else to install, data in `.pgdata/`) or, if you have Docker:

```bash
npm run db:up
```

Create tables, test accounts, two test merchants and the fake QR:

```bash
npm run seed
```

Start the app:

```bash
npm start
```

- Web app: http://localhost:3000
- Admin page: http://localhost:3000/admin.html (log in as the admin on the web app first)
- Logins: `SEED_USER_*` and `SEED_ADMIN_*` in `.env`

## Open it on your phone

The customer app is built for phones (Android Chrome, iPhone Safari).

1. Phone and computer on the same Wi-Fi.
2. `.env` has `HOST=0.0.0.0` (set `HOST=127.0.0.1` to go back to this computer only).
3. `npm start` prints two addresses. Use the **https** one (port 3443) for the live QR scanner:
   `https://192.168.x.x:3443`
4. The first time, the phone warns the connection is "not private" (it is a self-made test certificate).
   Android Chrome: **Advanced > Proceed**. iPhone Safari: **Show Details > visit this website**.
5. Log in, tap **Scan UPI QR to pay**, allow the camera. The QR is read automatically.
6. To use it like an app: Android Chrome menu > **Add to Home screen**; iPhone Safari Share > **Add to Home Screen**.

Notes:
- The plain `http://...:3000` address still works, but phones block the live camera there, so it falls back to
  taking a photo and offers a button to switch to the https address.
- Anyone on the same Wi-Fi can open the app while it runs. It is fake money, but use a network you trust.
- The admin page and admin API only answer on the computer running the desk, never over Wi-Fi.
- If the phone cannot connect: check both are on the same Wi-Fi (not guest/isolated), and allow incoming
  connections for `node` if the macOS firewall asks.

## Admin page

http://localhost:3000/admin.html (log in as the admin on the web app first).

- **Today**: orders paid, INR paid out, USDT collected, desk margin (spread), total owed to merchants.
- **Merchants**: **+ Add merchant** (name, phone, where to settle, note). **Details** shows their totals,
  settlement history, orders and Telegram link command. **Settle** records a full or part payment with a
  reference; you pay the merchant yourself by UPI/bank, this only updates the books.
- **Orders** and **Ledger balances** as before.

## Try the flow (no Telegram needed)

1. Log in as the test user. Click **+ 100 test USDT**.
2. Under "Withdraw by UPI QR" click **Use the fake test QR** (or upload `public/test-qr.png`, or scan it with the camera).
3. Check the amount, **Get quote** (locked 2 minutes), **Confirm**. The USDT moves to "on hold".
4. Log out, log in as the admin, open the admin page. On the order click **Approve**, then **Paid**
   (these buttons stand in for the merchant). Or **Decline** to release the hold. Or wait 5 minutes and it expires.
5. On the admin page the merchant now shows "Desk owes ₹500". **Record settlement** zeroes it.

## Connect your Telegram bot

1. In Telegram open **@BotFather**, send `/newbot`, follow the prompts, copy the token it gives you.
2. Open `.env` and set `TELEGRAM_BOT_TOKEN=` to that token. Keep it secret.
3. Restart the app (`Ctrl+C`, then `npm start`). It prints `Telegram bot @yourbot is running`.
4. Open your bot in Telegram, press Start, and send the link command shown on the admin page for a
   merchant, for example `/link 41F3285D`. That chat is now that merchant.
5. Create an order in the web app. The bot sends it with **Approve** / **Decline** buttons.
   After Approve: send the UTR number (or a receipt photo) in the chat, then press **Paid**.
6. `/balance` shows what the merchant has paid and what the desk owes them.

To test both merchants you need two Telegram accounts (one chat can only be one merchant).
Orders go to linked merchants first, then to whichever has the fewest open orders.

## Tests

```bash
npm test
```

Ledger tests, run against a separate throwaway database `desk_test`: balanced journals, hold and release,
no negative wallet, double-spend race, quote reuse, paid + settlement, expiry, whole-ledger zero sum.

```bash
npm run e2e
```

Drives the running server through the whole flow using the fake QR image.

## How it is built

| File | What it does |
| --- | --- |
| `sql/schema.sql` | users, merchants, accounts, journal, entries, orders, settings |
| `src/ledger.ts` | double-entry ledger: every journal sums to zero per currency, in one DB transaction |
| `src/orders.ts` | order lifecycle: create + hold, approve, decline, paid, expire |
| `src/rates.ts` | base rate and spread, admin-changeable |
| `src/upi.ts` | parses `upi://pay?...` QR text |
| `src/server.ts` | API, auth, admin endpoints, expiry job |
| `src/bot.ts` | Telegram merchant bot |
| `src/money.ts` | exact decimal math (no floats for money) |
| `public/` | web app and admin page |

### Ledger accounts

Balances are never stored; they are `SUM(entries.amount)`. Positive = credit.

| Account | Meaning of the balance |
| --- | --- |
| user `wallet` (USDT) | user's spendable funds. Can never go negative. |
| user `hold` (USDT) | funds locked in open orders |
| merchant `payable` (INR) | what the desk owes the merchant |
| house `external` (USDT) | negative = total test USDT deposited from outside |
| house `treasury` (USDT) | USDT the desk has earned from paid orders |
| house `payout_cost` (INR) | negative = total INR merchants paid out for the desk |
| house `settled` (INR) | total INR the desk has settled to merchants |

| Event | Entries |
| --- | --- |
| test deposit | external −, wallet + |
| order created | wallet −, hold + |
| declined / expired | hold −, wallet + |
| paid | hold −, treasury + (USDT) and payout_cost −, payable + (INR) |
| settlement | payable −, settled + |

### API

`POST /api/signup`, `POST /api/login`, `GET /api/me`, `GET /api/rate`, `POST /api/test-deposit`,
`POST /api/upi/parse`, `POST /api/quote`, `POST /api/orders`

Admin: `GET /api/admin/overview`, `POST /api/admin/rate` `{base, spread}`, `POST /api/admin/settle` `{merchant_id, note}`,
`POST /api/admin/merchants/:id/active`, `POST /api/admin/orders/:id/simulate` `{action}` (test only)

## Known limits of this test build

- Approved orders do not time out. If a merchant approves and never pays, cancel it from the admin page.
- Photo proofs are stored as Telegram file ids only; the admin page does not display them.
- Login tokens live in browser localStorage. Fine for local testing only.

## Before any real use (mandatory, KYC first)

Search the code for `TODO(` to find where each one hooks in.

1. **KYC** - identity verification for users and merchants, before they can transact
2. **AML** - sanctions and transaction screening, monitoring, suspicious activity reporting
3. **Limits** - per-user, per-merchant, per-day
4. **2FA** - for users, admins, withdrawals
5. **Real USDT deposit watcher** - addresses, confirmations, reorgs (replaces the test deposit button)
6. **Audit logging** - append-only record of every action
7. **Legal and regulatory review** - in India this includes VDA rules and FIU-IND registration, tax (TDS),
   and whether paying third-party UPI QRs through merchants' accounts is permitted at all. Get this
   answered by a lawyer before building further, not after.
8. **Security hardening** - rate limiting, HTTPS, CSRF/cookie handling, secrets management, a penetration test
