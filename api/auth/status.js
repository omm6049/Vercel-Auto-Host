import { getAccessRequestStatusAsync, getAccessStatusByIpAsync, normalizeIp } from '../../src/services/telegramBot.js';

export default async function handler(req, res) {
  try {
    const requestId = req.query.id || req.query.requestId;
    const cloudId = req.query.cloudId || null;
    let clientIp = req.query.ip;

    const headerIp = req.headers['x-forwarded-for'] || 
                     req.headers['x-real-ip'] || 
                     req.headers['cf-connecting-ip'] || 
                     req.headers['x-vercel-forwarded-for'] ||
                     req.headers['x-client-ip'] || 
                     req.socket?.remoteAddress;

    let serverIp = '';
    if (headerIp) {
      serverIp = typeof headerIp === 'string' ? headerIp.split(',')[0].trim() : String(headerIp);
    }
    const finalIp = normalizeIp(clientIp || serverIp || '');

    let record = null;
    if (requestId) {
      record = await getAccessRequestStatusAsync(requestId, cloudId);
    }

    if ((!record || record.status === 'PENDING') && finalIp) {
      const byIp = await getAccessStatusByIpAsync(finalIp);
      if (byIp && byIp.status && (byIp.status === 'APPROVED' || byIp.status === 'REJECTED')) {
        record = byIp;
      }
    }

    if (!record && finalIp) {
      record = await getAccessStatusByIpAsync(finalIp);
    }

    if (!record) {
      return res.status(200).json({
        success: true,
        request: {
          id: requestId || null,
          status: 'UNREGISTERED',
          token: null
        }
      });
    }

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


