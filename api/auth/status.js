import { getAccessRequestStatusAsync } from '../../src/services/telegramBot.js';

export default async function handler(req, res) {
  try {
    const requestId = req.query.id || req.query.requestId;
    const cloudId = req.query.cloudId || null;
    if (!requestId) {
      return res.status(400).json({ success: false, error: 'requestId parameter is required' });
    }

    const record = await getAccessRequestStatusAsync(requestId, cloudId);

    return res.status(200).json({
      success: true,
      request: {
        id: record.id || requestId,
        cloudId: record.cloudId || cloudId || null,
        name: record.name || 'Visitor',
        reason: record.reason || 'Access Request',
        status: record.status || 'PENDING',
        token: record.token || null,
        approvedBy: record.approvedBy || null,
        rejectedBy: record.rejectedBy || null
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

