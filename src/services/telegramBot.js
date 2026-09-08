import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import { deployToVercel, sanitizeProjectName } from './vercel.js';

// In-memory conversation state per chat
const userSessions = new Map();

// Global deployment history for the dashboard & bot
export const deploymentHistory = [];

/**
 * Creates a visual ASCII progress bar
 */
function createProgressBar(percent) {
  const totalBars = 10;
  const filledBars = Math.round((percent / 100) * totalBars);
  const emptyBars = totalBars - filledBars;
  return `[${'█'.repeat(filledBars)}${'░'.repeat(emptyBars)}] ${percent}%`;
}

/**
 * Delays execution for ms milliseconds
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Downloads a file from Telegram with simulated/chunked percentage progress updates
 */
async function downloadTelegramFileWithProgress(bot, chatId, fileId, fileName) {
  const progressMsg = await bot.sendMessage(
    chatId,
    `📥 *Uploading ${fileName}...*\nProgress: ${createProgressBar(10)}`,
    { parse_mode: 'Markdown' }
  );

  const fileLink = await bot.getFileLink(fileId);

  // Progressive steps for visual feedback
  const progressSteps = [25, 50, 75, 90, 100];
  for (const step of progressSteps.slice(0, -1)) {
    await sleep(250);
    try {
      await bot.editMessageText(
        `📥 *Uploading ${fileName}...*\nProgress: ${createProgressBar(step)}`,
        {
          chat_id: chatId,
          message_id: progressMsg.message_id,
          parse_mode: 'Markdown'
        }
      );
    } catch {
      // Ignore edit rate-limit errors
    }
  }

  // Fetch actual file content as utf-8 string
  const response = await axios.get(fileLink, {
    responseType: 'text',
    transformResponse: [(data) => data]
  });
  const fileContent = response.data;

  // Final 100% update & success confirmation
  try {
    await bot.editMessageText(
      `📥 *Uploading ${fileName}...*\nProgress: ${createProgressBar(100)}\n\n✅ *File Uploaded successfully!*`,
      {
        chat_id: chatId,
        message_id: progressMsg.message_id,
        parse_mode: 'Markdown'
      }
    );
  } catch {
    // Ignore edit errors
  }

  return fileContent;
}

/**
 * Initializes and starts the Telegram bot
 */
export function initTelegramBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token || token === 'your_telegram_bot_token_here') {
    console.warn('⚠️ [Telegram Bot]: TELEGRAM_BOT_TOKEN is not set or using placeholder in .env. Bot polling skipped.');
    return null;
  }

  const bot = new TelegramBot(token, { polling: true });
  console.log('🤖 [Telegram Bot]: Bot initialized and polling for messages...');

  // Error listener
  bot.on('polling_error', (error) => {
    console.error('⚠️ [Telegram Polling Error]:', error.message || error);
  });

  // /start command handler
  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userName = msg.from.first_name || 'there';

    userSessions.set(chatId, {
      step: 'AWAITING_HTML',
      htmlContent: null,
      cssContent: null,
      jsContent: null,
      projectName: null,
      timestamp: Date.now()
    });

    await bot.sendMessage(
      chatId,
      `👋 *Hello ${userName}! Welcome to Vercel Auto Host Bot.*\n\n` +
      `I will help you deploy your website to *Vercel* in 4 simple steps:\n` +
      `1️⃣ Send \`index.html\`\n` +
      `2️⃣ Send \`style.css\`\n` +
      `3️⃣ Send \`logic.js\`\n` +
      `4️⃣ Enter your desired Website Name\n\n` +
      `📌 *Step 1/4:* Please send your *index.html* file as a document.`,
      { parse_mode: 'Markdown' }
    );
  });

  // /cancel command handler
  bot.onText(/\/cancel/, async (msg) => {
    const chatId = msg.chat.id;
    userSessions.delete(chatId);
    await bot.sendMessage(
      chatId,
      '❌ *Session cancelled.*\nType /start whenever you want to host a new website!',
      { parse_mode: 'Markdown' }
    );
  });

  // /status command handler
  bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    const userDeployments = deploymentHistory.filter((d) => d.chatId === chatId);

    if (userDeployments.length === 0) {
      await bot.sendMessage(
        chatId,
        'ℹ️ *You have no active deployments yet.*\nSend /start to deploy your first website!',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    let report = `📊 *Your Recent Deployments (${userDeployments.length}):*\n\n`;
    userDeployments.slice(-5).reverse().forEach((d, idx) => {
      report += `${idx + 1}. *${d.projectName}*\n🔗 [${d.canonicalUrl}](${d.canonicalUrl})\n🕒 ${new Date(d.createdAt).toLocaleString()}\n\n`;
    });

    await bot.sendMessage(chatId, report, { parse_mode: 'Markdown', disable_web_page_preview: true });
  });

  // /help command handler
  bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    await bot.sendMessage(
      chatId,
      `📖 *Vercel Auto Host Bot Help*\n\n` +
      `• /start - Start deploying a website (HTML -> CSS -> JS -> Name)\n` +
      `• /cancel - Reset and cancel current upload\n` +
      `• /status - View your recent deployments\n` +
      `• /help - Show this guide\n\n` +
      `💡 *Tip:* You can send your files as documents or attachments. We automatically connect \`style.css\` and \`logic.js\` with your \`index.html\` so your site works instantly on \`<name>.vercel.app\`!`,
      { parse_mode: 'Markdown' }
    );
  });

  // Handle document file uploads
  bot.on('document', async (msg) => {
    const chatId = msg.chat.id;
    const session = userSessions.get(chatId);

    if (!session) {
      await bot.sendMessage(
        chatId,
        '💡 Please type /start first to begin hosting your website.',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const doc = msg.document;
    const docName = (doc.file_name || '').toLowerCase();

    // Step 1: index.html
    if (session.step === 'AWAITING_HTML') {
      if (!docName.endsWith('.html') && !docName.endsWith('.htm')) {
        await bot.sendMessage(
          chatId,
          '⚠️ *Invalid file format.* Please send an HTML file (e.g. `index.html`).',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      try {
        session.htmlContent = await downloadTelegramFileWithProgress(bot, chatId, doc.file_id, doc.file_name || 'index.html');
        session.step = 'AWAITING_CSS';

        await sleep(300);
        await bot.sendMessage(
          chatId,
          `📌 *Step 2/4:* Great! Now please upload your *style.css* file.`,
          { parse_mode: 'Markdown' }
        );
      } catch (err) {
        console.error('File download error:', err);
        await bot.sendMessage(chatId, `❌ Failed to download file: ${err.message}. Please try again.`);
      }
      return;
    }

    // Step 2: style.css
    if (session.step === 'AWAITING_CSS') {
      if (!docName.endsWith('.css')) {
        await bot.sendMessage(
          chatId,
          '⚠️ *Invalid file format.* Please send a CSS file (e.g. `style.css`).',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      try {
        session.cssContent = await downloadTelegramFileWithProgress(bot, chatId, doc.file_id, doc.file_name || 'style.css');
        session.step = 'AWAITING_JS';

        await sleep(300);
        await bot.sendMessage(
          chatId,
          `📌 *Step 3/4:* Excellent! Now please upload your *logic.js* file.`,
          { parse_mode: 'Markdown' }
        );
      } catch (err) {
        console.error('File download error:', err);
        await bot.sendMessage(chatId, `❌ Failed to download file: ${err.message}. Please try again.`);
      }
      return;
    }

    // Step 3: logic.js
    if (session.step === 'AWAITING_JS') {
      if (!docName.endsWith('.js')) {
        await bot.sendMessage(
          chatId,
          '⚠️ *Invalid file format.* Please send a JavaScript file (e.g. `logic.js`).',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      try {
        session.jsContent = await downloadTelegramFileWithProgress(bot, chatId, doc.file_id, doc.file_name || 'logic.js');
        session.step = 'AWAITING_NAME';

        await sleep(300);
        await bot.sendMessage(
          chatId,
          `✨ *All 3 files uploaded successfully!*\n` +
          `• \`index.html\` ✅\n` +
          `• \`style.css\` ✅\n` +
          `• \`logic.js\` ✅\n\n` +
          `📌 *Step 4/4:* What *Website Name* do you want for your site?\n` +
          `*(e.g., \`my-portfolio\`, \`awesome-shop\`, \`crypto-hub\`)*\n\n` +
          `Your site will be accessible at: \`https://<website-name>.vercel.app\``,
          { parse_mode: 'Markdown' }
        );
      } catch (err) {
        console.error('File download error:', err);
        await bot.sendMessage(chatId, `❌ Failed to download file: ${err.message}. Please try again.`);
      }
      return;
    }
  });

  // Handle plain text messages (for website name input or general guidance)
  bot.on('message', async (msg) => {
    if (msg.document || (msg.text && msg.text.startsWith('/'))) return;

    const chatId = msg.chat.id;
    const session = userSessions.get(chatId);

    if (!session) {
      await bot.sendMessage(
        chatId,
        '💡 Type /start to start uploading and hosting a new website!',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    if (session.step === 'AWAITING_HTML') {
      await bot.sendMessage(chatId, '📌 Please send your *index.html* file as an attachment/document.', { parse_mode: 'Markdown' });
      return;
    }

    if (session.step === 'AWAITING_CSS') {
      await bot.sendMessage(chatId, '📌 Please send your *style.css* file as an attachment/document.', { parse_mode: 'Markdown' });
      return;
    }

    if (session.step === 'AWAITING_JS') {
      await bot.sendMessage(chatId, '📌 Please send your *logic.js* file as an attachment/document.', { parse_mode: 'Markdown' });
      return;
    }

    // Step 4: Website Name processing & deployment
    if (session.step === 'AWAITING_NAME') {
      const rawName = msg.text.trim();
      const sanitized = sanitizeProjectName(rawName);

      if (!sanitized || sanitized.length < 2) {
        await bot.sendMessage(
          chatId,
          '⚠️ Please provide a valid website name with at least 2 letters (e.g. `my-project`).',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      session.step = 'DEPLOYING';
      session.projectName = sanitized;

      const deployingMsg = await bot.sendMessage(
        chatId,
        `⏳ *Connecting files & deploying \`${sanitized}\` to Vercel...*\n` +
        `🔗 Auto-linking \`style.css\` & \`logic.js\` with \`index.html\`...`,
        { parse_mode: 'Markdown' }
      );

      try {
        const result = await deployToVercel({
          projectName: sanitized,
          htmlContent: session.htmlContent,
          cssContent: session.cssContent,
          jsContent: session.jsContent
        });

        // Store in deployment history
        const record = {
          id: result.deploymentId,
          projectName: result.projectName,
          canonicalUrl: result.canonicalUrl,
          directUrl: result.directUrl,
          createdAt: result.createdAt,
          source: 'Telegram Bot',
          chatId
        };
        deploymentHistory.push(record);

        // Delete user session on success
        userSessions.delete(chatId);

        // Success message
        await bot.editMessageText(
          `🎉 *Website Successfully Deployed to Vercel!*\n\n` +
          `🏷️ *Project Name:* \`${result.projectName}\`\n` +
          `🌐 *Live Website URL:*\n👉 [${result.canonicalUrl}](${result.canonicalUrl})\n\n` +
          `⚡ *Direct Deployment Link:*\n👉 [${result.directUrl}](${result.directUrl})\n\n` +
          `✨ *Connected Components:*\n` +
          `• \`index.html\` (Root Entrypoint)\n` +
          `• \`style.css\` (Styles Linked)\n` +
          `• \`logic.js\` (Scripts Linked)\n\n` +
          `🚀 Tap the link above to test your live website!`,
          {
            chat_id: chatId,
            message_id: deployingMsg.message_id,
            parse_mode: 'Markdown',
            disable_web_page_preview: false,
            reply_markup: {
              inline_keyboard: [
                [{ text: '🌐 Open Website', url: result.canonicalUrl }],
                [{ text: '⚡ Direct Preview', url: result.directUrl }]
              ]
            }
          }
        );
      } catch (err) {
        console.error('Deployment error:', err);
        session.step = 'AWAITING_NAME'; // Allow retry

        await bot.editMessageText(
          `❌ *Deployment Error:*\n${err.message}\n\n` +
          `Please enter another website name or check your \`.env\` VERCEL_TOKEN credentials.`,
          {
            chat_id: chatId,
            message_id: deployingMsg.message_id,
            parse_mode: 'Markdown'
          }
        );
      }
    }
  });

  return bot;
}
