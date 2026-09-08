import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import { initTelegramBot, deploymentHistory } from './services/telegramBot.js';
import { deployToVercel, verifyVercelCredentials, sanitizeProjectName } from './services/vercel.js';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const app = express();
const PORT = process.env.PORT || 3000;

// Setup Multer memory storage for web file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB per file
});

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// Serve static web dashboard
app.use(express.static(path.join(rootDir, 'public')));

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

  res.json({
    status: 'online',
    timestamp: new Date().toISOString(),
    telegram: {
      configured: hasTelegramToken,
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

// API: Deployment History
app.get('/api/history', (req, res) => {
  res.json({
    success: true,
    deployments: deploymentHistory.slice().reverse()
  });
});

// API: Web Direct Deployment (Multer or JSON)
app.post(
  '/api/deploy',
  upload.fields([
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

      // If files uploaded via form-data
      if (req.files?.htmlFile?.[0]) {
        htmlContent = req.files.htmlFile[0].buffer.toString('utf-8');
      }
      if (req.files?.cssFile?.[0]) {
        cssContent = req.files.cssFile[0].buffer.toString('utf-8');
      }
      if (req.files?.jsFile?.[0]) {
        jsContent = req.files.jsFile[0].buffer.toString('utf-8');
      }

      if (!htmlContent) {
        return res.status(400).json({
          success: false,
          error: 'index.html content is required.'
        });
      }

      const cleanName = sanitizeProjectName(projectName);

      const result = await deployToVercel({
        projectName: cleanName,
        htmlContent,
        cssContent,
        jsContent
      });

      const record = {
        id: result.deploymentId,
        projectName: result.projectName,
        canonicalUrl: result.canonicalUrl,
        directUrl: result.directUrl,
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

// Start server
app.listen(PORT, () => {
  console.log(`🌐 [Server]: Vercel Auto Host Web Dashboard is live at http://localhost:${PORT}`);
  // Start Telegram Bot
  initTelegramBot();
});
