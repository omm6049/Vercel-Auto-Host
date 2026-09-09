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
    const { name, reason, clientIp: browserIp, clientTime, clientTimezone, deviceInfo } = body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Your name is required to request access.' });
    }

    // Comprehensive header-based IP discovery
    const headerIp = req.headers['x-forwarded-for'] || 
                     req.headers['x-real-ip'] || 
                     req.headers['cf-connecting-ip'] || 
                     req.headers['x-vercel-forwarded-for'] ||
                     req.headers['x-client-ip'] || 
                     req.socket?.remoteAddress;

    let serverIp = 'Unknown';
    if (headerIp) {
      serverIp = typeof headerIp === 'string' ? headerIp.split(',')[0].trim() : String(headerIp);
      if (serverIp.startsWith('::ffff:')) serverIp = serverIp.replace('::ffff:', '');
    }

    // Determine the most accurate public IP
    let finalIp = 'Unknown';
    if (browserIp && browserIp !== 'Unknown' && !browserIp.startsWith('127.')) {
      finalIp = browserIp;
    } else if (serverIp && serverIp !== 'Unknown' && !serverIp.startsWith('127.') && serverIp !== '::1') {
      finalIp = serverIp;
    } else {
      finalIp = browserIp || serverIp || '127.0.0.1 (Localhost)';
    }

    const hostUrl = req.headers['x-forwarded-host'] ? `https://${req.headers['x-forwarded-host']}` : (req.headers.host ? `https://${req.headers.host}` : null);

    const requestRecord = await createAccessRequest({
      name: name.trim(),
      reason: reason ? reason.trim() : 'Website deployment access request',
      ip: finalIp,
      clientTime,
      clientTimezone,
      deviceInfo,
      hostUrl
    });

    return res.status(200).json({
      success: true,
      requestId: requestRecord.id,
      cloudId: requestRecord.cloudId || null,
      status: requestRecord.status,
      message: 'Authentication request sent to admin on Telegram.'
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

