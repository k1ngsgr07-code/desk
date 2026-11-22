// Parse the text inside a UPI QR code: upi://pay?pa=<vpa>&pn=<name>&am=<amount>&cu=INR
import { AppError } from './ledger';

export type UpiQr = { vpa: string; name: string; amount: string | null };

export function parseUpi(payload: string): UpiQr {
  const text = String(payload || '').trim();
  if (text.length > 1000) throw new AppError(400, 'QR text is too long');
  if (!/^upi:\/\/pay\?/i.test(text)) throw new AppError(400, 'Not a UPI payment QR (expected upi://pay?...)');

  const params = new URLSearchParams(text.slice(text.indexOf('?') + 1));
  const vpa = (params.get('pa') || '').trim();
  if (!/^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z0-9.\-]{2,64}$/.test(vpa)) throw new AppError(400, 'QR has no valid payee VPA');

  const cu = (params.get('cu') || 'INR').toUpperCase();
  if (cu !== 'INR') throw new AppError(400, 'Only INR QRs are supported');

  const name = (params.get('pn') || '').trim().slice(0, 100);
  const am = (params.get('am') || '').trim();
  const amount = /^\d{1,7}(\.\d{1,2})?$/.test(am) && Number(am) > 0 ? am : null;
  return { vpa, name, amount };
}
