import { initTelegramBot, botInstance } from '../src/services/telegramBot.js';

export default async function handler(req, res) {
  // Always initialize bot instance in webhook mode
  const bot = botInstance || initTelegramBot();

  if (req.method === 'POST') {
    try {
      if (bot && req.body) {
        bot.processUpdate(req.body);
      }
      return res.status(200).send('OK');
    } catch (err) {
      console.error('[Vercel Webhook Error]:', err.message);
      return res.status(200).send('OK');
    }
  }

  // If accessed via GET
  return res.status(200).json({
    status: 'online',
    message: 'Telegram Webhook handler is active on Vercel'
  });
}
