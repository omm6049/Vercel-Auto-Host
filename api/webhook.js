import { processIncomingUpdate } from '../src/services/telegramBot.js';

export default async function handler(req, res) {
  if (req.method === 'POST') {
    try {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch {}
      } else if (Buffer.isBuffer(body)) {
        try { body = JSON.parse(body.toString('utf-8')); } catch {}
      }

      if (!body || (typeof body === 'object' && Object.keys(body).length === 0)) {
        try {
          const buffers = [];
          for await (const chunk of req) buffers.push(chunk);
          if (buffers.length > 0) body = JSON.parse(Buffer.concat(buffers).toString('utf-8'));
        } catch {}
      }

      if (body) {
        await processIncomingUpdate(body);
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

