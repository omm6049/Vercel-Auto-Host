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
  verifyAccessToken,
  revokeAccessToken,
  approveAccessRequest
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
    const { name, reason } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Your name is required to request access.' });
    }

    const clientIp = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'Unknown';
    const requestRecord = await createAccessRequest({
      name: name.trim(),
      reason: reason ? reason.trim() : 'Website deployment access request',
      ip: clientIp
    });

    res.json({
      success: true,
      requestId: requestRecord.id,
      status: requestRecord.status,
      message: 'Authentication request sent to admin on Telegram.'
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: Poll Status of an Access Request
app.get('/api/auth/status', (req, res) => {
  const requestId = req.query.id || req.query.requestId;
  if (!requestId) {
    return res.status(400).json({ success: false, error: 'requestId parameter is required' });
  }

  const record = getAccessRequestStatus(requestId);
  if (!record) {
    return res.status(404).json({ success: false, error: 'Access request not found or expired' });
  }

  res.json({
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
});

// API: Verify Session Token
app.post('/api/auth/verify', (req, res) => {
  const token = req.body.token || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
  const isValid = verifyAccessToken(token);

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
app.post('/api/auth/simulate-approve', (req, res) => {
  const { requestId } = req.body;
  if (!requestId) return res.status(400).json({ success: false, error: 'requestId is required' });

  const record = approveAccessRequest(requestId, 'Simulation Mode');
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

