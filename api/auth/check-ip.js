import { getAccessStatusByIpAsync, normalizeIp, getAccessRequestStatusAsync } from '../../src/services/telegramBot.js';

export default async function handler(req, res) {
  try {
    let clientIp = req.query.ip;

    if (!clientIp && req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch {}
      } else if (Buffer.isBuffer(body)) {
        try { body = JSON.parse(body.toString('utf-8')); } catch {}
      }
      clientIp = body?.clientIp || body?.ip;
    }

    // Comprehensive header-based IP discovery on Vercel
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

    const finalIp = normalizeIp(clientIp || serverIp || '127.0.0.1');

    // Also check if req.query.id or requestId is provided
    const requestId = req.query.id || req.query.requestId;
    let record = null;
    if (requestId) {
      record = await getAccessRequestStatusAsync(requestId);
    }
    if (!record || !record.status) {
      record = await getAccessStatusByIpAsync(finalIp);
    }

    if (record && record.status) {
      return res.status(200).json({
        success: true,
        ip: finalIp,
        matched: true,
        request: {
          id: record.id,
          cloudId: record.cloudId || record.id,
          name: record.name,
          reason: record.reason,
          status: record.status,
          token: record.token || null,
          approvedBy: record.approvedBy || null,
          rejectedBy: record.rejectedBy || null
        }
      });
    }

    return res.status(200).json({
      success: true,
      ip: finalIp,
      matched: false,
      status: 'UNREGISTERED'
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
