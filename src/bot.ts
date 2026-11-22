// Telegram merchant bot (grammY, long polling).
// Merchants connect their chat with "/link CODE" (code is shown on the admin page).
//
// TODO(2FA/SECURITY): link codes are simple shared secrets, fine for a test only.
// TODO(AUDIT): log every merchant action with chat id and timestamp.

import { Bot, InlineKeyboard } from 'grammy';
import { pool } from './db';
import { config } from './config';
import { AppError } from './ledger';
import { Order, approve, decline, markPaid, merchantSummary, setProof } from './orders';

let bot: Bot | null = null;
const TAG = '[Desk]';

async function merchantByChat(chatId: number) {
  const r = await pool.query('SELECT id, name FROM merchants WHERE telegram_chat_id=$1 AND active', [chatId]);
  return r.rows[0] as { id: number; name: string } | undefined;
}

function orderText(o: Order) {
  return [
    `${TAG}`,
    `Order #${o.id}`,
    `Payee: ${o.payee_name || '(no name)'}`,
    `VPA: ${o.payee_vpa}`,
    `Amount: INR ${o.inr_amount}`,
  ].join('\n');
}

/** Send a new order to its merchant with Approve / Decline buttons. No-op if the bot is off or the merchant is not linked. */
export async function notifyNewOrder(o: Order) {
  if (!bot) return;
  const r = await pool.query('SELECT telegram_chat_id FROM merchants WHERE id=$1', [o.merchant_id]);
  const chatId = r.rows[0]?.telegram_chat_id;
  if (!chatId) return;
  const kb = new InlineKeyboard().text('Approve', `a:${o.id}`).text('Decline', `d:${o.id}`);
  await bot.api
    .sendMessage(chatId, `${orderText(o)}\n\nApprove within 5 minutes or it expires.`, { reply_markup: kb })
    .catch((e) => console.error('Telegram send failed:', e.message));
}

export async function notifyMerchant(merchantId: number, text: string) {
  if (!bot) return;
  const r = await pool.query('SELECT telegram_chat_id FROM merchants WHERE id=$1', [merchantId]);
  const chatId = r.rows[0]?.telegram_chat_id;
  if (chatId) await bot.api.sendMessage(chatId, `${TAG}\n${text}`).catch((e) => console.error('Telegram send failed:', e.message));
}

export function startBot() {
  if (!config.telegramToken) {
    console.log('Telegram bot is OFF (set TELEGRAM_BOT_TOKEN in .env). Use the admin page to simulate the merchant.');
    return;
  }
  bot = new Bot(config.telegramToken);

  bot.command('start', (ctx) =>
    ctx.reply(`${TAG}\nMerchant bot for the test desk.\nSend /link YOUR-CODE to connect this chat, then /balance to see your totals.`),
  );

  bot.command('link', async (ctx) => {
    const code = ctx.match.trim();
    if (!code) return ctx.reply('Usage: /link YOUR-CODE');
    try {
      const r = await pool.query(
        'UPDATE merchants SET telegram_chat_id=$1 WHERE link_code=$2 AND active RETURNING name',
        [ctx.chat.id, code],
      );
      if (!r.rows[0]) return ctx.reply('Unknown code.');
      return ctx.reply(`${TAG}\nLinked. You are merchant "${r.rows[0].name}". New orders will arrive here.`);
    } catch (e: any) {
      if (e.code === '23505') return ctx.reply('This chat is already linked to another merchant.');
      throw e;
    }
  });

  bot.command('balance', async (ctx) => {
    const m = await merchantByChat(ctx.chat.id);
    if (!m) return ctx.reply('This chat is not linked. Send /link YOUR-CODE first.');
    const s = await merchantSummary(m.id);
    return ctx.reply(
      `${TAG}\n${m.name}\nOrders paid: ${s.paid_count}\nTotal paid out: INR ${s.paid_inr}\nDesk owes you: INR ${s.owed_inr}`,
    );
  });

  // Approve / Decline / Paid buttons
  bot.on('callback_query:data', async (ctx) => {
    const m = await merchantByChat(ctx.chat?.id ?? 0);
    const match = /^([adp]):(\d+)$/.exec(ctx.callbackQuery.data);
    if (!m || !match) return ctx.answerCallbackQuery({ text: 'Not allowed' });
    const id = Number(match[2]);
    try {
      if (match[1] === 'a') {
        const o = await approve(id, m.id);
        await ctx.editMessageText(
          `${orderText(o)}\n\nAPPROVED. Pay this UPI now, then send the UTR number (or a photo of the receipt) in this chat, then press Paid.`,
          { reply_markup: new InlineKeyboard().text('Paid', `p:${o.id}`) },
        );
      } else if (match[1] === 'd') {
        const o = await decline(id, m.id);
        await ctx.editMessageText(`${orderText(o)}\n\nDECLINED. The user's USDT was released.`);
      } else {
        const o = await markPaid(id, m.id);
        const s = await merchantSummary(m.id);
        await ctx.editMessageText(`${orderText(o)}\n\nPAID. Proof: ${o.proof}\nDesk now owes you INR ${s.owed_inr}.`);
      }
      await ctx.answerCallbackQuery();
    } catch (e) {
      await ctx.answerCallbackQuery({ text: e instanceof AppError ? e.message : 'Something went wrong', show_alert: true });
      if (!(e instanceof AppError)) console.error(e);
    }
  });

  // Payment proof: UTR text or a photo. Optional "#12 ..." prefix picks the order;
  // otherwise it goes to the merchant's oldest approved order that has no proof yet.
  bot.on(['message:text', 'message:photo'], async (ctx) => {
    const m = await merchantByChat(ctx.chat.id);
    if (!m) return ctx.reply('This chat is not linked. Send /link YOUR-CODE first.');
    const text = (ctx.message.text ?? ctx.message.caption ?? '').trim();
    const tagged = /^#(\d+)\s*/.exec(text);
    let orderId = tagged ? Number(tagged[1]) : null;
    if (!orderId) {
      const r = await pool.query(
        `SELECT id FROM orders WHERE merchant_id=$1 AND status='approved' ORDER BY (proof IS NOT NULL), updated_at LIMIT 1`,
        [m.id],
      );
      orderId = r.rows[0]?.id ?? null;
    }
    if (!orderId) return ctx.reply('No approved order is waiting for a proof.');
    const photo = ctx.message.photo?.at(-1)?.file_id;
    const note = text.replace(/^#\d+\s*/, '');
    const proof = photo ? `photo:${photo}${note ? ' ' + note : ''}` : `UTR ${note}`;
    if (!photo && note.length < 4) return ctx.reply('Send the UTR number or a photo of the payment receipt.');
    try {
      await setProof(orderId, proof, m.id);
      return ctx.reply(`Proof saved for order #${orderId}. Now press Paid on that order.`);
    } catch (e) {
      return ctx.reply(e instanceof AppError ? e.message : 'Could not save the proof.');
    }
  });

  bot.catch((err) => console.error('Bot error:', err.error));
  bot.start({ onStart: (me) => console.log(`Telegram bot @${me.username} is running`) }).catch((e) => {
    console.error('Telegram bot failed to start (check TELEGRAM_BOT_TOKEN):', e.message);
    bot = null;
  });
}
