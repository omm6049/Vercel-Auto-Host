import { approveAccessRequest } from '../../src/services/telegramBot.js';

export default async function handler(req, res) {
  try {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch {}
    } else if (Buffer.isBuffer(body)) {
      try { body = JSON.parse(body.toString('utf-8')); } catch {}
    }
    body = body || {};

    const { requestId } = body;
    if (!requestId) {
      return res.status(400).json({ success: false, error: 'requestId is required' });
    }

    const record = approveAccessRequest(requestId, 'Simulation Mode');
    if (!record) {
      return res.status(404).json({ success: false, error: 'Request not found' });
    }

    return res.status(200).json({ success: true, record });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
