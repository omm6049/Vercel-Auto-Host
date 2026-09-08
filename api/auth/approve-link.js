import { approveAccessRequest, rejectAccessRequest, verifyAccessToken } from '../../src/services/telegramBot.js';

export default async function handler(req, res) {
  try {
    const requestId = req.query.id || req.query.requestId;
    const action = (req.query.action || 'approve').toLowerCase();

    if (!requestId) {
      return res.status(400).send(`
        <!DOCTYPE html>
        <html>
        <head><title>Invalid Request</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
        <body style="font-family:sans-serif; background:#0f172a; color:#f8fafc; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0;">
          <div style="background:#1e293b; padding:2rem; border-radius:12px; border:1px solid #ef4444; max-width:400px; text-align:center;">
            <h2 style="color:#ef4444; margin-top:0;">⚠️ Invalid Request</h2>
            <p>Missing request ID parameter.</p>
          </div>
        </body>
        </html>
      `);
    }

    let record;
    if (action === 'reject') {
      record = await rejectAccessRequest(requestId, 'Admin (Link)');
    } else {
      record = await approveAccessRequest(requestId, 'Admin (Link)');
    }

    const isApproved = record.status === 'APPROVED';

    return res.status(200).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>${isApproved ? 'Access Approved' : 'Request Declined'}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #090d16; color: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 1rem; }
          .card { background: #131d2e; border: 1px solid ${isApproved ? '#10b981' : '#ef4444'}; border-radius: 16px; padding: 2.5rem; max-width: 440px; text-align: center; box-shadow: 0 20px 40px rgba(0,0,0,0.5); }
          .icon { font-size: 3.5rem; margin-bottom: 1rem; }
          h2 { margin: 0 0 0.5rem; font-size: 1.6rem; color: ${isApproved ? '#34d399' : '#f87171'}; }
          p { color: #94a3b8; font-size: 0.95rem; line-height: 1.5; margin: 0 0 1.5rem; }
          .badge { display: inline-block; background: rgba(255,255,255,0.06); padding: 0.5rem 1rem; border-radius: 8px; font-family: monospace; font-size: 0.85rem; color: #cbd5e1; margin-bottom: 1.5rem; }
          .btn { display: inline-block; background: #0070f3; color: #fff; text-decoration: none; padding: 0.75rem 1.5rem; border-radius: 8px; font-weight: 600; font-size: 0.95rem; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="icon">${isApproved ? '🎉' : '🚫'}</div>
          <h2>${isApproved ? 'Access Granted Successfully!' : 'Access Request Declined'}</h2>
          <p>${isApproved ? `Visitor <strong>${record.name}</strong> now has full access to the deployment launchpad.` : `Access for <strong>${record.name}</strong> has been rejected.`}</p>
          <div class="badge">Request ID: ${requestId}</div>
          <br>
          <a class="btn" href="https://vercel-auto-host.vercel.app">Go to Main Website</a>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
