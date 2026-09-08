import { createAccessRequest } from '../../src/services/telegramBot.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

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

    body = body || {};
    const { name, reason } = body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Your name is required to request access.' });
    }

    const clientIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'Unknown';
    const requestRecord = await createAccessRequest({
      name: name.trim(),
      reason: reason ? reason.trim() : 'Website deployment access request',
      ip: clientIp
    });

    return res.status(200).json({
      success: true,
      requestId: requestRecord.id,
      status: requestRecord.status,
      message: 'Authentication request sent to admin on Telegram.'
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
