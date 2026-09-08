import { revokeAccessToken } from '../../src/services/telegramBot.js';

export default async function handler(req, res) {
  try {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch {}
    } else if (Buffer.isBuffer(body)) {
      try { body = JSON.parse(body.toString('utf-8')); } catch {}
    }
    body = body || {};

    const token = body.token || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
    if (token) {
      revokeAccessToken(token);
    }

    return res.status(200).json({ success: true, message: 'Logged out successfully' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
