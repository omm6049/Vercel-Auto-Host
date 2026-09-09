import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import {
  initTelegramBot,
  botInstance,
  deploymentHistory,
  setBotWebhook,
  getBotWebhookInfo,
  createAccessRequest,
  getAccessRequestStatus,
  getAccessRequestStatusAsync,
  getAccessStatusByIpAsync,
  verifyAccessToken,
  verifyAccessTokenAsync,
  revokeAccessToken,
  approveAccessRequest,
  rejectAccessRequest,
  normalizeIp
} from './services/telegramBot.js';
import { deployToVercel, verifyVercelCredentials, sanitizeProjectName } from './services/vercel.js';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const app = express();
const PORT = process.env.PORT || 3000;

// Setup Multer memory storage for web file uploads (supporting zip, env, and code files)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB per file
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Serve static web dashboard
app.use(express.static(path.join(rootDir, 'public')));

// Initialize bot on startup
initTelegramBot();

// =========================================================================
// Telegram Webhook Endpoints (For Vercel Serverless 24/7 Hosting)
// =========================================================================

// Endpoint for receiving updates from Telegram
app.post('/api/webhook', (req, res) => {
  try {
    if (botInstance && req.body) {
      botInstance.processUpdate(req.body);
    }
    res.status(200).send('OK');
  } catch (err) {
    console.error('[Webhook Error]:', err.message);
    res.status(200).send('OK'); // Always return 200 to Telegram
  }
});

// Endpoint to set Webhook URL with Telegram
app.post('/api/set-webhook', async (req, res) => {
  try {
    const hostUrl = req.body.url || (req.headers['x-forwarded-host'] ? `https://${req.headers['x-forwarded-host']}` : `http://localhost:${PORT}`);
    const result = await setBotWebhook(hostUrl);
    res.json({
      success: true,
      result,
      webhookUrl: `${hostUrl.replace(/\/+$/, '')}/api/webhook`
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.response?.data?.description || err.message
    });
  }
});

// Endpoint to check Webhook Info
app.get('/api/webhook-info', async (req, res) => {
  try {
    const info = await getBotWebhookInfo();
    res.json(info);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// =========================================================================
// General API Endpoints
// =========================================================================

// API: System Status
app.get('/api/status', async (req, res) => {
  const vercelAuth = await verifyVercelCredentials();
  const hasTelegramToken = Boolean(
    process.env.TELEGRAM_BOT_TOKEN &&
    process.env.TELEGRAM_BOT_TOKEN !== 'your_telegram_bot_token_here'
  );
  const hasBlobToken = Boolean(
    process.env.BLOB_READ_WRITE_TOKEN &&
    process.env.BLOB_READ_WRITE_TOKEN !== 'your_blob_token_here'
  );

  const isVercelServerless = process.env.VERCEL === '1' || process.env.USE_WEBHOOK === 'true';

  res.json({
    status: 'online',
    timestamp: new Date().toISOString(),
    isVercel: isVercelServerless,
    telegram: {
      configured: hasTelegramToken,
      mode: isVercelServerless ? 'Webhook (Serverless)' : 'Long Polling',
      status: hasTelegramToken ? 'active' : 'token_missing'
    },
    vercel: {
      configured: Boolean(process.env.VERCEL_TOKEN),
      authenticated: vercelAuth.valid,
      user: vercelAuth.user || null,
      error: vercelAuth.reason || null
    },
    blobStorage: {
      configured: hasBlobToken
    },
    totalDeployments: deploymentHistory.length
  });
});

// =========================================================================
// Visitor Authentication & Telegram 1-Click Access Request Endpoints
// =========================================================================

// API: Submit Authentication / Access Request
app.post('/api/auth/request', async (req, res) => {
  try {
    const { name, reason, clientIp: browserIp, clientTime, clientTimezone, deviceInfo } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Your name is required to request access.' });
    }

    const headerIp = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.ip || req.socket?.remoteAddress;
    let serverIp = 'Unknown';
    if (headerIp) {
      serverIp = typeof headerIp === 'string' ? headerIp.split(',')[0].trim() : String(headerIp);
      if (serverIp.startsWith('::ffff:')) serverIp = serverIp.replace('::ffff:', '');
    }

    let finalIp = 'Unknown';
    if (browserIp && browserIp !== 'Unknown' && !browserIp.startsWith('127.')) {
      finalIp = browserIp;
    } else if (serverIp && serverIp !== 'Unknown' && !serverIp.startsWith('127.') && serverIp !== '::1') {
      finalIp = serverIp;
    } else {
      finalIp = browserIp || serverIp || '127.0.0.1 (Localhost)';
    }

    const hostUrl = req.headers['x-forwarded-host'] ? `https://${req.headers['x-forwarded-host']}` : (req.headers.host ? `http://${req.headers.host}` : null);

    const requestRecord = await createAccessRequest({
      name: name.trim(),
      reason: reason ? reason.trim() : 'Website deployment access request',
      ip: finalIp,
      clientTime,
      clientTimezone,
      deviceInfo,
      hostUrl
    });

    res.json({
      success: true,
      requestId: requestRecord.id,
      cloudId: requestRecord.cloudId || null,
      status: requestRecord.status,
      message: 'Authentication request sent to admin on Telegram.'
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: Poll Status of an Access Request
app.get('/api/auth/status', async (req, res) => {
  const requestId = req.query.id || req.query.requestId;
  const cloudId = req.query.cloudId || null;
  if (!requestId) {
    return res.status(400).json({ success: false, error: 'requestId parameter is required' });
  }

  const record = (await getAccessRequestStatusAsync(requestId, cloudId)) || {
    id: requestId,
    cloudId: cloudId || null,
    name: 'Visitor',
    reason: 'Access Request',
    status: 'PENDING',
    token: null
  };

  res.json({
    success: true,
    request: {
      id: record.id,
      cloudId: record.cloudId || cloudId || null,
      name: record.name,
      reason: record.reason,
      status: record.status,
      token: record.token || null,
      approvedBy: record.approvedBy || null,
      rejectedBy: record.rejectedBy || null
    }
  });
});

// API: 1-Click Approve / Decline Link (Browser & Telegram direct links)
app.get('/api/auth/approve-link', async (req, res) => {
  try {
    const requestId = req.query.id || req.query.requestId;
    const action = (req.query.action || 'approve').toLowerCase();

    if (!requestId) {
      return res.status(400).send('<h3>Invalid Request: Missing request ID</h3>');
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
          <a class="btn" href="/">Go to Main Website</a>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// API: Check IP Status (Auto-Login & Auto-Block)
app.all('/api/auth/check-ip', async (req, res) => {
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
});

// API: Verify Session Token
app.post('/api/auth/verify', async (req, res) => {
  const token = req.body.token || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
  const isValid = await verifyAccessTokenAsync(token);

  res.json({
    success: true,
    valid: isValid
  });
});

// API: Revoke Session Token / Logout
app.post('/api/auth/logout', (req, res) => {
  const token = req.body.token || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
  if (token) {
    revokeAccessToken(token);
  }
  res.json({ success: true, message: 'Logged out successfully' });
});

// API: Dev / Simulation Instant Approval (Useful for testing / when Telegram bot is offline)
app.post('/api/auth/simulate-approve', async (req, res) => {
  const { requestId } = req.body;
  if (!requestId) return res.status(400).json({ success: false, error: 'requestId is required' });

  const record = await approveAccessRequest(requestId, 'Simulation Mode');
  if (!record) return res.status(404).json({ success: false, error: 'Request not found' });

  res.json({ success: true, record });
});


// API: Deployment History
app.get('/api/history', (req, res) => {
  res.json({
    success: true,
    deployments: deploymentHistory.slice().reverse()
  });
});

// API: Web Direct Deployment (Supports ZIP archive, .env files, and individual files)
app.post(
  '/api/deploy',
  upload.fields([
    { name: 'zipFile', maxCount: 1 },
    { name: 'envFile', maxCount: 1 },
    { name: 'htmlFile', maxCount: 1 },
    { name: 'cssFile', maxCount: 1 },
    { name: 'jsFile', maxCount: 1 }
  ]),
  async (req, res) => {
    try {
      let projectName = req.body.projectName;
      let htmlContent = req.body.htmlContent || '';
      let cssContent = req.body.cssContent || '';
      let jsContent = req.body.jsContent || '';
      let envContent = req.body.envContent || '';
      let zipBuffer = null;

      if (req.body.zipBase64) {
        const cleanBase64 = typeof req.body.zipBase64 === 'string' && req.body.zipBase64.includes(',')
          ? req.body.zipBase64.split(',')[1]
          : req.body.zipBase64;
        zipBuffer = Buffer.from(cleanBase64, 'base64');
      } else if (req.files?.zipFile?.[0]) {
        zipBuffer = req.files.zipFile[0].buffer;
      }
      if (req.files?.envFile?.[0]) {
        envContent = req.files.envFile[0].buffer.toString('utf-8');
      }
      if (req.files?.htmlFile?.[0]) {
        htmlContent = req.files.htmlFile[0].buffer.toString('utf-8');
      }
      if (req.files?.cssFile?.[0]) {
        cssContent = req.files.cssFile[0].buffer.toString('utf-8');
      }
      if (req.files?.jsFile?.[0]) {
        jsContent = req.files.jsFile[0].buffer.toString('utf-8');
      }

      if (!zipBuffer && !htmlContent && !req.body.files) {
        return res.status(400).json({
          success: false,
          error: 'Either a .ZIP file or index.html content is required.'
        });
      }

      const cleanName = sanitizeProjectName(projectName || `site-${Date.now().toString(36)}`);

      const result = await deployToVercel({
        projectName: cleanName,
        zipBuffer,
        files: req.body.files,
        htmlContent,
        cssContent,
        jsContent,
        envContent,
        envVariables: req.body.envVariables
      });

      const record = {
        id: result.deploymentId,
        projectName: result.projectName,
        canonicalUrl: result.canonicalUrl,
        directUrl: result.directUrl,
        fileCount: result.fileCount,
        envCount: result.envCount,
        createdAt: result.createdAt,
        source: 'Web Dashboard'
      };
      deploymentHistory.push(record);

      res.json({
        success: true,
        deployment: result
      });
    } catch (error) {
      console.error('[Web Deploy Error]:', error.message);
      res.status(500).json({
        success: false,
        error: error.message || 'Deployment failed.'
      });
    }
  }
);

// Function to start server with automatic port retry if busy
function startServer(portToTry) {
  const server = app.listen(portToTry, () => {
    console.log(`🌐 [Server]: Vercel Auto Host Web Dashboard is live at http://localhost:${portToTry}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`⚠️ [Port Busy]: Port ${portToTry} is already in use. Retrying on port ${Number(portToTry) + 1}...`);
      startServer(Number(portToTry) + 1);
    } else {
      console.error('❌ Server error:', err);
    }
  });
}

// Start server if not running purely as serverless function
if (process.env.VERCEL !== '1') {
  startServer(PORT);
}

export default app;

