import { verifyVercelCredentials } from '../src/services/vercel.js';
import { deploymentHistory } from '../src/services/telegramBot.js';

export default async function handler(req, res) {
  const vercelAuth = await verifyVercelCredentials();
  const hasTelegramToken = Boolean(
    process.env.TELEGRAM_BOT_TOKEN &&
    process.env.TELEGRAM_BOT_TOKEN !== 'your_telegram_bot_token_here'
  );
  const hasBlobToken = Boolean(
    process.env.BLOB_READ_WRITE_TOKEN &&
    process.env.BLOB_READ_WRITE_TOKEN !== 'your_blob_token_here'
  );

  res.status(200).json({
    status: 'online',
    timestamp: new Date().toISOString(),
    isVercel: true,
    telegram: {
      configured: hasTelegramToken,
      mode: 'Webhook (Vercel Serverless)',
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
}
