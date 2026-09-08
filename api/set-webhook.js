import { setBotWebhook } from '../src/services/telegramBot.js';

export default async function handler(req, res) {
  try {
    const hostUrl = req.body?.url || (req.headers['x-forwarded-host'] ? `https://${req.headers['x-forwarded-host']}` : (req.headers.host ? `https://${req.headers.host}` : ''));
    const result = await setBotWebhook(hostUrl);
    res.status(200).json({
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
}
