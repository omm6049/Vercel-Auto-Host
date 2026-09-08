import { getAccessRequestStatus } from '../../src/services/telegramBot.js';

export default async function handler(req, res) {
  try {
    const requestId = req.query.id || req.query.requestId;
    if (!requestId) {
      return res.status(400).json({ success: false, error: 'requestId parameter is required' });
    }

    const record = getAccessRequestStatus(requestId);
    if (!record) {
      return res.status(404).json({ success: false, error: 'Access request not found or expired' });
    }

    return res.status(200).json({
      success: true,
      request: {
        id: record.id,
        name: record.name,
        reason: record.reason,
        status: record.status,
        token: record.token || null,
        approvedBy: record.approvedBy || null
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
