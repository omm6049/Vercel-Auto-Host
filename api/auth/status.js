import { getAccessRequestStatusAsync } from '../../src/services/telegramBot.js';

export default async function handler(req, res) {
  try {
    const requestId = req.query.id || req.query.requestId;
    if (!requestId) {
      return res.status(400).json({ success: false, error: 'requestId parameter is required' });
    }

    const record = await getAccessRequestStatusAsync(requestId);

    return res.status(200).json({
      success: true,
      request: {
        id: record.id || requestId,
        name: record.name || 'Visitor',
        reason: record.reason || 'Access Request',
        status: record.status || 'PENDING',
        token: record.token || null,
        approvedBy: record.approvedBy || null
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

