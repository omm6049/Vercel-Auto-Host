import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import {
  deployToVercel,
  sanitizeProjectName,
  extractZipToVercelFiles,
  parseEnvFileContent
} from './vercel.js';

// In-memory conversation state per chat
export const userSessions = new Map();

// Global deployment history for the dashboard & bot
export const deploymentHistory = [];

// In-memory visitor access requests and approved session tokens
export const accessRequests = new Map();
export const activeSessionTokens = new Set();
export const registeredAdminChatIds = new Set();

// Pre-load admin chat ID if configured in environment
if (process.env.TELEGRAM_ADMIN_CHAT_ID) {
  registeredAdminChatIds.add(Number(process.env.TELEGRAM_ADMIN_CHAT_ID) || process.env.TELEGRAM_ADMIN_CHAT_ID);
}
if (process.env.ADMIN_CHAT_ID) {
  registeredAdminChatIds.add(Number(process.env.ADMIN_CHAT_ID) || process.env.ADMIN_CHAT_ID);
}

export let botInstance = null;

/**
 * Creates a new visitor authentication & access request and broadcasts approval buttons to Telegram Admin.
 */
export async function createAccessRequest({ name, reason, ip }) {
  const cleanName = (name || 'Anonymous Visitor').trim();
  const cleanReason = (reason || 'General inquiry & deployment access').trim();
  const requestId = `req_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;

  const record = {
    id: requestId,
    name: cleanName,
    reason: cleanReason,
    ip: ip || 'Unknown',
    status: 'PENDING', // 'PENDING' | 'APPROVED' | 'REJECTED'
    token: null,
    createdAt: Date.now()
  };

  accessRequests.set(requestId, record);

  const bot = botInstance || initTelegramBot();

  // Broadcast to Telegram admin(s) if bot is active
  if (bot && registeredAdminChatIds.size > 0) {
    const alertText =
      `🔐 *NEW WEBSITE ACCESS REQUEST*\n\n` +
      `👤 *Visitor Name:* ${cleanName}\n` +
      `🎯 *Reason for Contact:* ${cleanReason}\n` +
      `🌐 *Client IP:* \`${ip || 'Unknown'}\`\n` +
      `⏰ *Time:* ${new Date().toLocaleTimeString()}\n\n` +
      `👇 *Click below to grant or deny access to the deployment launchpad:*`;

    const replyMarkup = {
      inline_keyboard: [
        [
          { text: '✅ Approve Access', callback_data: `auth_approve:${requestId}` },
          { text: '❌ Reject Request', callback_data: `auth_reject:${requestId}` }
        ]
      ]
    };

    for (const adminChatId of registeredAdminChatIds) {
      try {
        await bot.sendMessage(adminChatId, alertText, {
          parse_mode: 'Markdown',
          reply_markup: replyMarkup
        });
      } catch (sendErr) {
        console.warn(`[Telegram Auth Alert Error to ${adminChatId}]:`, sendErr.message);
      }
    }
  } else {
    console.log(`[Auth Access Request created]: ${requestId} for "${cleanName}". (Awaiting Telegram approval or simulation)`);
  }

  return record;
}

/**
 * Returns current status of an access request.
 */
export function getAccessRequestStatus(requestId) {
  return accessRequests.get(requestId) || null;
}

/**
 * Approves an access request, generates a secure session token, and updates status.
 */
export function approveAccessRequest(requestId, approvedBy = 'Admin') {
  const record = accessRequests.get(requestId);
  if (!record) return null;

  const sessionToken = `tok_${Math.random().toString(36).substring(2)}_${Date.now().toString(36)}`;
  activeSessionTokens.add(sessionToken);

  record.status = 'APPROVED';
  record.token = sessionToken;
  record.approvedBy = approvedBy;
  record.approvedAt = Date.now();

  accessRequests.set(requestId, record);
  return record;
}

/**
 * Rejects an access request and updates status.
 */
export function rejectAccessRequest(requestId, rejectedBy = 'Admin') {
  const record = accessRequests.get(requestId);
  if (!record) return null;

  record.status = 'REJECTED';
  record.rejectedBy = rejectedBy;
  record.rejectedAt = Date.now();

  accessRequests.set(requestId, record);
  return record;
}

/**
 * Verifies if a session token is active and authorized.
 */
export function verifyAccessToken(token) {
  if (!token) return false;
  return activeSessionTokens.has(token);
}

/**
 * Revokes a session token on logout.
 */
export function revokeAccessToken(token) {
  if (!token) return false;
  return activeSessionTokens.delete(token);
}

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
 * Downloads a text file from Telegram with percentage progress updates
 */
async function downloadTelegramFileWithProgress(bot, chatId, fileId, fileName) {
  const progressMsg = await bot.sendMessage(
    chatId,
    `📥 *Uploading ${fileName}...*\nProgress: ${createProgressBar(20)}`,
    { parse_mode: 'Markdown' }
  );

  const fileLink = await bot.getFileLink(fileId);

  const progressSteps = [35, 65, 90, 100];
  for (const step of progressSteps.slice(0, -1)) {
    await sleep(150);
    try {
      await bot.editMessageText(
        `📥 *Uploading ${fileName}...*\nProgress: ${createProgressBar(step)}`,
        {
          chat_id: chatId,
          message_id: progressMsg.message_id,
          parse_mode: 'Markdown'
        }
      );
    } catch {}
  }

  const response = await axios.get(fileLink, {
    responseType: 'text',
    transformResponse: [(data) => data]
  });
  const fileContent = response.data;

  try {
    await bot.editMessageText(
      `📥 *Uploading ${fileName}...*\nProgress: ${createProgressBar(100)}\n\n✅ *File uploaded successfully!*`,
      {
        chat_id: chatId,
        message_id: progressMsg.message_id,
        parse_mode: 'Markdown'
      }
    );
  } catch {}

  return fileContent;
}

/**
 * Downloads binary buffer (e.g. .zip archive) from Telegram
 */
async function downloadTelegramBufferWithProgress(bot, chatId, fileId, fileName) {
  const progressMsg = await bot.sendMessage(
    chatId,
    `📥 *Uploading ${fileName}...*\nProgress: ${createProgressBar(20)}`,
    { parse_mode: 'Markdown' }
  );

  const fileLink = await bot.getFileLink(fileId);

  const progressSteps = [40, 75, 95, 100];
  for (const step of progressSteps.slice(0, -1)) {
    await sleep(150);
    try {
      await bot.editMessageText(
        `📥 *Uploading ${fileName}...*\nProgress: ${createProgressBar(step)}`,
        {
          chat_id: chatId,
          message_id: progressMsg.message_id,
          parse_mode: 'Markdown'
        }
      );
    } catch {}
  }

  const response = await axios.get(fileLink, {
    responseType: 'arraybuffer',
    timeout: 45000
  });
  const buffer = Buffer.from(response.data);

  try {
    await bot.editMessageText(
      `📥 *Uploading ${fileName}...*\nProgress: ${createProgressBar(100)}\n\n✅ *Archive uploaded successfully!*`,
      {
        chat_id: chatId,
        message_id: progressMsg.message_id,
        parse_mode: 'Markdown'
      }
    );
  } catch {}

  return buffer;
}

/**
 * Prompts user for environment variables step
 */
async function askEnvStep(bot, chatId, summaryText) {
  await sleep(250);
  await bot.sendMessage(
    chatId,
    `${summaryText}\n\n` +
    `📌 *Next Step: Environment Variables (.env)*\n` +
    `• Send a \`.env\` file as an attachment\n` +
    `• Or paste \`KEY=VALUE\` pairs directly in chat\n` +
    `• Or tap the button below / type \`skip\` to proceed without env variables.`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '⏭️ Skip .env (No Variables)', callback_data: 'skip_env' }]
        ]
      }
    }
  );
}

/**
 * Prompts user for website name step
 */
async function askNameStep(bot, chatId, summaryText = '') {
  await sleep(250);
  await bot.sendMessage(
    chatId,
    `${summaryText ? summaryText + '\n\n' : ''}` +
    `📌 *Final Step: Website Name*\n` +
    `What *Website Name* do you want for your site?\n` +
    `*(e.g., \`my-portfolio\`, \`awesome-shop\`, \`crypto-app\`)*\n\n` +
    `Your live site will be deployed at:\n` +
    `👉 \`https://<website-name>.vercel.app\``,
    { parse_mode: 'Markdown' }
  );
}

/**
 * Executes deployment to Vercel and sends live links
 */
async function executeDeployment(bot, chatId, session, rawName) {
  const sanitized = sanitizeProjectName(rawName);

  if (!sanitized || sanitized.length < 2) {
    await bot.sendMessage(
      chatId,
      '⚠️ Please provide a valid website name with at least 2 characters (e.g. `my-project`).',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  session.step = 'DEPLOYING';
  session.projectName = sanitized;

  const deployingMsg = await bot.sendMessage(
    chatId,
    `⏳ *Deploying \`${sanitized}\` to Vercel...*\n` +
    `⚙️ Configuring project & environment variables...\n` +
    `🚀 Packaging files and publishing to Vercel Edge CDN...`,
    { parse_mode: 'Markdown' }
  );

  try {
    const result = await deployToVercel({
      projectName: sanitized,
      files: session.files,
      zipBuffer: session.zipBuffer,
      htmlContent: session.htmlContent,
      cssContent: session.cssContent,
      jsContent: session.jsContent,
      envContent: session.envContent,
      envVariables: session.envVariables
    });

    // Store in deployment history
    const record = {
      id: result.deploymentId,
      projectName: result.projectName,
      canonicalUrl: result.canonicalUrl,
      directUrl: result.directUrl,
      createdAt: result.createdAt,
      source: 'Telegram Bot',
      fileCount: result.fileCount,
      envCount: result.envCount,
      chatId
    };
    deploymentHistory.push(record);

    // Delete user session on success
    userSessions.delete(chatId);

    // Success message
    await bot.editMessageText(
      `🎉 *Website Successfully Deployed to Vercel!*\n\n` +
      `🏷️ *Project Name:* \`${result.projectName}\`\n` +
      `📦 *Files Deployed:* \`${result.fileCount || '3'} files\`\n` +
      `🔐 *Env Variables:* \`${result.envCount || 0} configured\`\n\n` +
      `🌐 *Live Website URL:*\n👉 [${result.canonicalUrl}](${result.canonicalUrl})\n\n` +
      `⚡ *Direct Preview Link:*\n👉 [${result.directUrl}](${result.directUrl})\n\n` +
      `💡 *Mobile Tip:* If opening on mobile asks for Vercel login, disable _Vercel Authentication_ under *Project Settings ➔ Deployment Protection* in your Vercel Dashboard for 100% public direct access.`,
      {
        chat_id: chatId,
        message_id: deployingMsg.message_id,
        parse_mode: 'Markdown',
        disable_web_page_preview: false,
        reply_markup: {
          inline_keyboard: [
            [{ text: '🌐 Open Live Website', url: result.canonicalUrl }],
            [{ text: '⚡ Direct Preview', url: result.directUrl }]
          ]
        }
      }
    );
  } catch (err) {
    console.error('Deployment error:', err);
    session.step = 'AWAITING_NAME';

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

/**
 * Direct Async Update Handler for Webhook & Serverless Execution
 */
export async function processIncomingUpdate(update) {
  if (!update) return;

  const bot = botInstance || initTelegramBot();
  if (!bot) return;

  // Handle Callback Queries (e.g. [Approve Access], [Reject Request], [Skip .env])
  if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = cb.message?.chat?.id;
    const messageId = cb.message?.message_id;
    const data = cb.data;

    // Handle 1-Click Visitor Authentication Approvals
    if (data && data.startsWith('auth_approve:')) {
      const requestId = data.split(':')[1];
      const record = approveAccessRequest(requestId, cb.from?.first_name || 'Admin');

      try {
        await bot.answerCallbackQuery(cb.id, { text: `✅ Access APPROVED for ${record ? record.name : 'visitor'}!` });
      } catch {}

      if (chatId && messageId && record) {
        try {
          await bot.editMessageText(
            `✅ *ACCESS REQUEST APPROVED*\n\n` +
            `👤 *Visitor Name:* ${record.name}\n` +
            `🎯 *Reason for Contact:* ${record.reason}\n` +
            `🛡️ *Status:* Granted by ${cb.from?.first_name || 'Admin'} ✅\n` +
            `🕒 *Approved At:* ${new Date().toLocaleTimeString()}\n\n` +
            `_Website launchpad is now unlocked for this visitor._`,
            {
              chat_id: chatId,
              message_id: messageId,
              parse_mode: 'Markdown'
            }
          );
        } catch {}
      }
      return;
    }

    // Handle 1-Click Visitor Authentication Rejections
    if (data && data.startsWith('auth_reject:')) {
      const requestId = data.split(':')[1];
      const record = rejectAccessRequest(requestId, cb.from?.first_name || 'Admin');

      try {
        await bot.answerCallbackQuery(cb.id, { text: `❌ Access DECLINED for ${record ? record.name : 'visitor'}` });
      } catch {}

      if (chatId && messageId && record) {
        try {
          await bot.editMessageText(
            `❌ *ACCESS REQUEST DECLINED*\n\n` +
            `👤 *Visitor Name:* ${record.name}\n` +
            `🎯 *Reason for Contact:* ${record.reason}\n` +
            `🚫 *Status:* Rejected by ${cb.from?.first_name || 'Admin'}\n` +
            `🕒 *Declined At:* ${new Date().toLocaleTimeString()}`,
            {
              chat_id: chatId,
              message_id: messageId,
              parse_mode: 'Markdown'
            }
          );
        } catch {}
      }
      return;
    }

    if (data === 'skip_env' && chatId) {
      const session = userSessions.get(chatId);
      if (session && session.step === 'AWAITING_ENV') {
        session.step = 'AWAITING_NAME';
        session.envContent = null;
        try {
          await bot.answerCallbackQuery(cb.id, { text: 'Skipped .env configuration' });
        } catch {}
        await askNameStep(bot, chatId, '⏭️ *Skipped .env configuration.*');
      }
    }
    return;
  }

  const msg = update.message;
  if (!msg) return;

  const chatId = msg.chat.id;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('TELEGRAM_BOT_TOKEN missing in environment.');
    return;
  }

  // 1. /start command handler
  if (msg.text && msg.text.startsWith('/start')) {
    const userName = msg.from?.first_name || 'there';

    // Register this chat for instant access approval notifications
    registeredAdminChatIds.add(chatId);

    userSessions.set(chatId, {
      step: 'AWAITING_SOURCE',
      htmlContent: null,
      cssContent: null,
      jsContent: null,
      zipBuffer: null,
      files: null,
      envContent: null,
      envVariables: null,
      projectName: null,
      timestamp: Date.now()
    });

    await bot.sendMessage(
      chatId,
      `👋 *Hello ${userName}! Welcome to Vercel Auto Host Bot.*\n\n` +
      `Deploy your website to *Vercel* in 3 easy steps:\n\n` +
      `📦 *Option 1 (Recommended):* Send a \`.zip\` archive containing your full project (with \`index.html\` entrypoint).\n` +
      `📄 *Option 2:* Send individual files (\`index.html\` ➔ \`style.css\` ➔ \`logic.js\`).\n\n` +
      `📌 *Step 1:* Please upload your *.ZIP file* or *index.html* document to begin!`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // 2. /cancel command handler
  if (msg.text && msg.text.startsWith('/cancel')) {
    userSessions.delete(chatId);
    await bot.sendMessage(
      chatId,
      '❌ *Session cancelled.*\nType /start whenever you want to host a new website!',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // 3. /help command handler
  if (msg.text && msg.text.startsWith('/help')) {
    await bot.sendMessage(
      chatId,
      `📖 *Vercel Auto Host Bot Help*\n\n` +
      `• *Upload .ZIP:* Send any \`.zip\` project file. We auto-extract all folders, images, and HTML/CSS/JS.\n` +
      `• *Environment Variables:* Send \`.env\` or paste \`KEY=VALUE\` to configure Vercel variables automatically.\n` +
      `• /start - Start a new deployment\n` +
      `• /cancel - Reset current session\n` +
      `• /status - View recent deployments`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // 4. /status command handler
  if (msg.text && msg.text.startsWith('/status')) {
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
    return;
  }

  // 5. Handle document file uploads
  if (msg.document) {
    let session = userSessions.get(chatId);

    if (!session) {
      session = {
        step: 'AWAITING_SOURCE',
        htmlContent: null,
        cssContent: null,
        jsContent: null,
        zipBuffer: null,
        files: null,
        envContent: null,
        envVariables: null,
        projectName: null,
        timestamp: Date.now()
      };
      userSessions.set(chatId, session);
    }

    const doc = msg.document;
    const docName = (doc.file_name || '').toLowerCase();

    // Case A: ZIP Upload in AWAITING_SOURCE
    if (
      docName.endsWith('.zip') ||
      doc.mime_type === 'application/zip' ||
      doc.mime_type === 'application/x-zip-compressed' ||
      doc.mime_type === 'multipart/x-zip' ||
      doc.mime_type === 'application/octet-stream'
    ) {
      try {
        const buffer = await downloadTelegramBufferWithProgress(bot, chatId, doc.file_id, doc.file_name || 'project.zip');
        const extracted = extractZipToVercelFiles(buffer);

        if (!extracted.hasIndexHtml) {
          await bot.sendMessage(
            chatId,
            '⚠️ *Missing index.html:* Your ZIP archive must contain an `index.html` entrypoint file. Please check and re-upload your .zip file.',
            { parse_mode: 'Markdown' }
          );
          return;
        }

        session.zipBuffer = buffer;
        session.files = extracted.files;
        session.step = 'AWAITING_ENV';

        const summary = `✨ *ZIP extracted successfully!* (${extracted.fileCount} files found, \`index.html\` verified ✅)`;
        await askEnvStep(bot, chatId, summary);
      } catch (err) {
        console.error('ZIP extraction error:', err);
        await bot.sendMessage(chatId, `❌ Failed to process ZIP archive: ${err.message}. Please try again.`);
      }
      return;
    }

    // Case B: .env file upload during AWAITING_ENV
    if (session.step === 'AWAITING_ENV') {
      try {
        const envText = await downloadTelegramFileWithProgress(bot, chatId, doc.file_id, doc.file_name || '.env');
        const parsed = parseEnvFileContent(envText);
        session.envContent = envText;
        session.envVariables = parsed;
        session.step = 'AWAITING_NAME';

        const count = Object.keys(parsed).length;
        const summary = `🔐 *Configured ${count} environment variable${count === 1 ? '' : 's'} from \`${doc.file_name || '.env'}\`!* ✅`;
        await askNameStep(bot, chatId, summary);
      } catch (err) {
        console.error('Env download error:', err);
        await bot.sendMessage(chatId, `❌ Failed to process .env file: ${err.message}.`);
      }
      return;
    }

    // Case C: Single-file step: index.html
    if (session.step === 'AWAITING_SOURCE' || session.step === 'AWAITING_HTML') {
      if (docName.endsWith('.html') || docName.endsWith('.htm')) {
        try {
          session.htmlContent = await downloadTelegramFileWithProgress(bot, chatId, doc.file_id, doc.file_name || 'index.html');
          session.step = 'AWAITING_CSS';

          await sleep(250);
          await bot.sendMessage(
            chatId,
            `📌 *Step 2/4:* Great! Now please upload your *style.css* file (or type \`skip\` if none).`,
            { parse_mode: 'Markdown' }
          );
        } catch (err) {
          await bot.sendMessage(chatId, `❌ Failed to download file: ${err.message}`);
        }
        return;
      }
    }

    // Case D: Single-file step: style.css
    if (session.step === 'AWAITING_CSS') {
      if (docName.endsWith('.css')) {
        try {
          session.cssContent = await downloadTelegramFileWithProgress(bot, chatId, doc.file_id, doc.file_name || 'style.css');
          session.step = 'AWAITING_JS';

          await sleep(250);
          await bot.sendMessage(
            chatId,
            `📌 *Step 3/4:* Excellent! Now please upload your *logic.js* file (or type \`skip\` if none).`,
            { parse_mode: 'Markdown' }
          );
        } catch (err) {
          await bot.sendMessage(chatId, `❌ Failed to download file: ${err.message}`);
        }
        return;
      }
    }

    // Case E: Single-file step: logic.js
    if (session.step === 'AWAITING_JS') {
      if (docName.endsWith('.js')) {
        try {
          session.jsContent = await downloadTelegramFileWithProgress(bot, chatId, doc.file_id, doc.file_name || 'logic.js');
          session.step = 'AWAITING_ENV';

          const summary = `✨ *HTML, CSS, and JS files uploaded successfully!* ✅`;
          await askEnvStep(bot, chatId, summary);
        } catch (err) {
          await bot.sendMessage(chatId, `❌ Failed to download file: ${err.message}`);
        }
        return;
      }
    }
  }

  // 6. Handle plain text messages
  if (msg.text) {
    const session = userSessions.get(chatId);
    const text = msg.text.trim();

    if (!session) {
      await bot.sendMessage(
        chatId,
        '💡 Type /start to start uploading and hosting a new website!',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    if (session.step === 'AWAITING_SOURCE' || session.step === 'AWAITING_HTML') {
      await bot.sendMessage(
        chatId,
        '📌 Please upload your *.ZIP file* or *index.html* file as an attachment to get started.',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    if (session.step === 'AWAITING_CSS') {
      if (text.toLowerCase() === 'skip' || text.toLowerCase() === '/skip') {
        session.cssContent = '';
        session.step = 'AWAITING_JS';
        await bot.sendMessage(chatId, '📌 Skipped CSS. Now please upload your *logic.js* file (or type `skip`).', { parse_mode: 'Markdown' });
      } else {
        await bot.sendMessage(chatId, '📌 Please send your *style.css* file as an attachment (or type `skip`).', { parse_mode: 'Markdown' });
      }
      return;
    }

    if (session.step === 'AWAITING_JS') {
      if (text.toLowerCase() === 'skip' || text.toLowerCase() === '/skip') {
        session.jsContent = '';
        session.step = 'AWAITING_ENV';
        await askEnvStep(bot, chatId, '⏭️ Skipped JS.');
      } else {
        await bot.sendMessage(chatId, '📌 Please send your *logic.js* file as an attachment (or type `skip`).', { parse_mode: 'Markdown' });
      }
      return;
    }

    // Step: AWAITING_ENV (User typed 'skip' or pasted KEY=VALUE pairs)
    if (session.step === 'AWAITING_ENV') {
      if (text.toLowerCase() === 'skip' || text.toLowerCase() === '/skip' || text.toLowerCase() === 'none') {
        session.step = 'AWAITING_NAME';
        session.envContent = null;
        await askNameStep(bot, chatId, '⏭️ *Skipped .env configuration.*');
        return;
      }

      if (text.includes('=')) {
        const parsed = parseEnvFileContent(text);
        session.envContent = text;
        session.envVariables = parsed;
        session.step = 'AWAITING_NAME';

        const count = Object.keys(parsed).length;
        const summary = `🔐 *Configured ${count} environment variable${count === 1 ? '' : 's'}!* ✅`;
        await askNameStep(bot, chatId, summary);
        return;
      }

      await bot.sendMessage(
        chatId,
        '💡 Send a `.env` file, paste `KEY=VALUE` pairs, or type `skip` if not needed.',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // Final Step: Website Name processing & deployment
    if (session.step === 'AWAITING_NAME') {
      await executeDeployment(bot, chatId, session, text);
    }
  }
}

/**
 * Initializes the Telegram bot in either Polling mode (Local) or Webhook mode (Vercel Serverless)
 */
export function initTelegramBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token || token === 'your_telegram_bot_token_here') {
    console.warn('⚠️ [Telegram Bot]: TELEGRAM_BOT_TOKEN is not configured. Telegram bot skipped.');
    return null;
  }

  // Determine mode: Serverless (Vercel) vs Long Polling (Local machine)
  const isVercelServerless = process.env.VERCEL === '1' || process.env.USE_WEBHOOK === 'true';
  const usePolling = !isVercelServerless;

  if (botInstance) {
    return botInstance;
  }

  const bot = new TelegramBot(token, { polling: usePolling });
  botInstance = bot;

  console.log(`🤖 [Telegram Bot]: Bot initialized in ${usePolling ? 'Long Polling (Local)' : 'Webhook (Serverless)'} mode.`);

  if (usePolling) {
    bot.on('polling_error', (error) => {
      console.error('⚠️ [Telegram Polling Error]:', error.message || error);
    });

    bot.on('message', async (msg) => {
      await processIncomingUpdate({ message: msg });
    });

    bot.on('callback_query', async (query) => {
      await processIncomingUpdate({ callback_query: query });
    });
  }

  return bot;
}

/**
 * Registers Webhook URL with Telegram API
 */
export async function setBotWebhook(baseUrl) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is missing');

  const webhookEndpoint = `${baseUrl.replace(/\/+$/, '')}/api/webhook`;
  const url = `https://api.telegram.org/bot${token}/setWebhook?url=${encodeURIComponent(webhookEndpoint)}`;
  
  const res = await axios.get(url);
  return res.data;
}

/**
 * Retrieves current Webhook status from Telegram API
 */
export async function getBotWebhookInfo() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: false, description: 'TELEGRAM_BOT_TOKEN is missing' };

  try {
    const res = await axios.get(`https://api.telegram.org/bot${token}/getWebhookInfo`);
    return res.data;
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

