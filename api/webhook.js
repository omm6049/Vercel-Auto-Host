import { processIncomingUpdate } from '../src/services/telegramBot.js';

export default async function handler(req, res) {
  if (req.method === 'POST') {
    try {
      if (req.body) {
        // Explicitly await the async processing before returning 200 OK
        await processIncomingUpdate(req.body);
      }
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('[Vercel Webhook Error]:', err.message);
      return res.status(200).json({ ok: false, error: err.message });
    }
  }

  // If accessed via GET in browser
  return res.status(200).json({
    status: 'online',
    message: 'Telegram Webhook handler is active on Vercel'
  });
}
