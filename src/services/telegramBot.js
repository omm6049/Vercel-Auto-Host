import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
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

// In-memory visitor access requests and session tokens
export const accessRequests = new Map();
export const revokedSessionTokens = new Set();
export const registeredAdminChatIds = new Set();

// Default admin chat ID from user session + environment
const DEFAULT_ADMIN_CHAT_ID = '8531059191';
registeredAdminChatIds.add(DEFAULT_ADMIN_CHAT_ID);

// Pre-load admin chat ID if configured in environment
if (process.env.TELEGRAM_ADMIN_CHAT_ID) {
  registeredAdminChatIds.add(process.env.TELEGRAM_ADMIN_CHAT_ID.trim());
}
if (process.env.ADMIN_CHAT_ID) {
  registeredAdminChatIds.add(process.env.ADMIN_CHAT_ID.trim());
}

// Secret key for HMAC token signing (stateless cross-lambda validation)
const AUTH_SECRET = process.env.TELEGRAM_BOT_TOKEN || process.env.VERCEL_TOKEN || 'vercel_autohost_secure_salt_2026';

// Persistent Store Paths in /tmp (survives across serverless executions on the same instance)
const STORE_DIR = os.tmpdir();
const REQUESTS_STORE_FILE = path.join(STORE_DIR, 'vercel_autohost_requests.json');
const ADMIN_CHATS_FILE = path.join(STORE_DIR, 'vercel_autohost_admins.json');
const CLOUD_SYNC_URL = 'https://api.restful-api.dev/objects';

/**
 * Loads persisted access requests from /tmp
 */
function loadRequestsFromDisk() {
  try {
    if (fs.existsSync(REQUESTS_STORE_FILE)) {
      const data = JSON.parse(fs.readFileSync(REQUESTS_STORE_FILE, 'utf-8'));
      if (Array.isArray(data)) {
        for (const item of data) {
          if (item && item.id) {
            accessRequests.set(item.id, item);
          }
        }
      }
    }
  } catch {}
}

/**
 * Saves access requests to /tmp
 */
function saveRequestsToDisk() {
  try {
    const list = Array.from(accessRequests.values());
    fs.writeFileSync(REQUESTS_STORE_FILE, JSON.stringify(list), 'utf-8');
  } catch {}
}

/**
 * Syncs an access request to the global cloud store (cross-lambda sync)
 */
async function syncRequestToCloud(record) {
  if (!record || !record.id) return;
  try {
    if (!record._cloudId) {
      // Create new cloud object
      const res = await axios.post(CLOUD_SYNC_URL, {
        name: `autohost_auth_${record.id}`,
        data: {
          id: record.id,
          name: record.name,
          reason: record.reason,
          ip: record.ip,
          status: record.status,
          token: record.token || null,
          approvedBy: record.approvedBy || null,
          createdAt: record.createdAt || Date.now(),
          updatedAt: Date.now()
        }
      }, { timeout: 3500 });
      if (res.data?.id) {
        record._cloudId = res.data.id;
        accessRequests.set(record.id, record);
        saveRequestsToDisk();
      }
    } else {
      // Update existing cloud object
      await axios.put(`${CLOUD_SYNC_URL}/${record._cloudId}`, {
        name: `autohost_auth_${record.id}`,
        data: {
          id: record.id,
          name: record.name,
          reason: record.reason,
          ip: record.ip,
          status: record.status,
          token: record.token || null,
          approvedBy: record.approvedBy || null,
          createdAt: record.createdAt || Date.now(),
          updatedAt: Date.now()
        }
      }, { timeout: 3500 });
    }
  } catch (err) {
    // Graceful fallback - cloud sync error should never break local flow
    console.warn('[Cloud Sync Notice]:', err.message);
  }
}

/**
 * Fetches status from cloud if pending or not in local memory
 */
async function fetchRequestFromCloud(requestId) {
  if (!requestId) return null;
  try {
    const local = accessRequests.get(requestId);
    if (local && local._cloudId) {
      const res = await axios.get(`${CLOUD_SYNC_URL}/${local._cloudId}`, { timeout: 3000 });
      if (res.data?.data) {
        const cloudData = { ...res.data.data, _cloudId: res.data.id };
        accessRequests.set(requestId, cloudData);
        saveRequestsToDisk();
        return cloudData;
      }
    }
  } catch {}
  return null;
}

/**
 * Loads and saves admin chat IDs to /tmp
 */
function loadAdminChatsFromDisk() {
  try {
    if (fs.existsSync(ADMIN_CHATS_FILE)) {
      const data = JSON.parse(fs.readFileSync(ADMIN_CHATS_FILE, 'utf-8'));
      if (Array.isArray(data)) {
        for (const id of data) {
          registeredAdminChatIds.add(String(id));
        }
      }
    }
  } catch {}
}

function saveAdminChatToDisk(chatId) {
  try {
    registeredAdminChatIds.add(String(chatId));
    const list = Array.from(registeredAdminChatIds);
    fs.writeFileSync(ADMIN_CHATS_FILE, JSON.stringify(list), 'utf-8');
  } catch {}
}

// Initialize from disk
loadRequestsFromDisk();
loadAdminChatsFromDisk();

/**
 * Signs a stateless session token with HMAC-SHA256
 */
export function signSessionToken(payload) {
  const payloadStr = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', AUTH_SECRET).update(payloadStr).digest('base64url');
  return `tok.${payloadStr}.${signature}`;
}

/**
 * Auto-discovers admin chat IDs from environment, disk, or Telegram API getUpdates
 */
async function discoverAdminChatIds() {
  loadAdminChatsFromDisk();

  // Always ensure default admin chat ID is registered
  registeredAdminChatIds.add(DEFAULT_ADMIN_CHAT_ID);

  if (process.env.TELEGRAM_ADMIN_CHAT_ID) {
    registeredAdminChatIds.add(process.env.TELEGRAM_ADMIN_CHAT_ID.trim());
  }

  // Query Telegram getUpdates to find recent users who messaged the bot
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (token && token !== 'your_telegram_bot_token_here') {
    try {
      const res = await axios.get(`https://api.telegram.org/bot${token}/getUpdates?limit=10`, { timeout: 3000 });
      if (res.data?.ok && Array.isArray(res.data.result)) {
        for (const update of res.data.result) {
          const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id;
          if (chatId) {
            saveAdminChatToDisk(chatId);
          }
        }
      }
    } catch {}
  }

  return Array.from(registeredAdminChatIds);
}

export let botInstance = null;

/**
 * Creates a new visitor authentication & access request and broadcasts approval buttons to Telegram Admin.
 */
export async function createAccessRequest({ name, reason, ip, clientTime, clientTimezone, deviceInfo }) {
  loadRequestsFromDisk();

  const cleanName = (name || 'Anonymous Visitor').trim();
  const cleanReason = (reason || 'General inquiry & deployment access').trim();
  const cleanIp = ip || 'Unknown';
  
  // Format exact time with timezone
  const cleanTime = clientTime || new Date().toLocaleString('en-US', {
    timeZone: clientTimezone || 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'medium',
    hour12: true
  });
  const tzLabel = clientTimezone ? ` (${clientTimezone})` : '';
  const cleanDevice = deviceInfo || 'Web Browser';

  const requestId = `req_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;

  const record = {
    id: requestId,
    name: cleanName,
    reason: cleanReason,
    ip: cleanIp,
    time: `${cleanTime}${tzLabel}`,
    device: cleanDevice,
    status: 'PENDING', // 'PENDING' | 'APPROVED' | 'REJECTED'
    token: null,
    createdAt: Date.now()
  };

  accessRequests.set(requestId, record);
  saveRequestsToDisk();

  // Sync to global cloud store for multi-container lambdas
  syncRequestToCloud(record).catch(() => {});

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const adminChatIds = await discoverAdminChatIds();

  const fallbackApproveUrl = `https://vercel-auto-host.vercel.app/api/auth/approve-link?id=${requestId}&action=approve`;
  const fallbackRejectUrl = `https://vercel-auto-host.vercel.app/api/auth/approve-link?id=${requestId}&action=reject`;

  // Broadcast to Telegram admin(s)
  if (token && adminChatIds.length > 0) {
    const alertHtml =
      `🔐 <b>NEW WEBSITE ACCESS REQUEST</b>\n\n` +
      `👤 <b>Visitor Name:</b> ${escapeHtml(cleanName)}\n` +
      `🎯 <b>Reason for Contact:</b> ${escapeHtml(cleanReason)}\n` +
      `🌐 <b>Client IP:</b> <code>${escapeHtml(cleanIp)}</code>\n` +
      `⏰ <b>Exact Time:</b> ${escapeHtml(cleanTime)}${escapeHtml(tzLabel)}\n` +
      `💻 <b>Device / Browser:</b> ${escapeHtml(cleanDevice)}\n\n` +
      `👇 <b>Choose an option to approve or decline access:</b>`;

    const replyMarkup = {
      inline_keyboard: [
        [
          { text: '✅ Approve Access', callback_data: `auth_approve:${requestId}` },
          { text: '❌ Reject Request', callback_data: `auth_reject:${requestId}` }
        ],
        [
          { text: '⚡ 1-Tap Browser Approval', url: fallbackApproveUrl }
        ]
      ]
    };

    for (const adminChatId of adminChatIds) {
      try {
        await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
          chat_id: adminChatId,
          text: alertHtml,
          parse_mode: 'HTML',
          reply_markup: replyMarkup
        }, { timeout: 4000 });
        console.log(`[Telegram Auth Alert]: Sent approval request to admin ${adminChatId}`);
      } catch (sendErr) {
        console.warn(`[Telegram Auth Alert Error to ${adminChatId}]:`, sendErr.message);
      }
    }
  }

  return record;
}


/**
 * Returns current status of an access request (sync fallback).
 */
export function getAccessRequestStatus(requestId) {
  loadRequestsFromDisk();
  const record = accessRequests.get(requestId);
  if (record) return record;

  // Always return valid PENDING object instead of null (prevents 404s)
  return {
    id: requestId,
    name: 'Visitor',
    reason: 'Access verification',
    status: 'PENDING',
    token: null
  };
}

/**
 * Returns current status of an access request with asynchronous cloud verification.
 */
export async function getAccessRequestStatusAsync(requestId) {
  loadRequestsFromDisk();
  let record = accessRequests.get(requestId);

  if (!record || record.status === 'PENDING') {
    const cloudRecord = await fetchRequestFromCloud(requestId);
    if (cloudRecord) record = cloudRecord;
  }

  if (record) return record;

  return {
    id: requestId,
    name: 'Visitor',
    reason: 'Access verification',
    status: 'PENDING',
    token: null
  };
}

/**
 * Approves an access request, generates a secure session token, and updates status.
 */
export async function approveAccessRequest(requestId, approvedBy = 'Admin') {
  loadRequestsFromDisk();

  let record = accessRequests.get(requestId);
  if (!record) {
    record = {
      id: requestId,
      name: 'Authorized Visitor',
      reason: 'Approved via Telegram',
      ip: 'Unknown',
      status: 'PENDING',
      createdAt: Date.now()
    };
  }

  // Generate stateless HMAC-signed token
  const sessionToken = signSessionToken({
    requestId,
    name: record.name,
    approvedBy,
    approvedAt: Date.now()
  });

  record.status = 'APPROVED';
  record.token = sessionToken;
  record.approvedBy = approvedBy;
  record.approvedAt = Date.now();

  accessRequests.set(requestId, record);
  saveRequestsToDisk();

  // Sync to cloud store
  await syncRequestToCloud(record);

  return record;
}

/**
 * Rejects an access request and updates status.
 */
export async function rejectAccessRequest(requestId, rejectedBy = 'Admin') {
  loadRequestsFromDisk();

  let record = accessRequests.get(requestId);
  if (!record) {
    record = {
      id: requestId,
      name: 'Visitor',
      reason: 'Rejected via Telegram',
      ip: 'Unknown',
      status: 'PENDING',
      createdAt: Date.now()
    };
  }

  record.status = 'REJECTED';
  record.rejectedBy = rejectedBy;
  record.rejectedAt = Date.now();

  accessRequests.set(requestId, record);
  saveRequestsToDisk();

  // Sync to cloud store
  await syncRequestToCloud(record);

  return record;
}

/**
 * Verifies if a session token is active and authorized.
 */
export function verifyAccessToken(token) {
  if (!token || typeof token !== 'string') return false;

  if (revokedSessionTokens.has(token)) return false;

  // Handle stateless HMAC token (format: tok.<base64Payload>.<signature>)
  if (token.startsWith('tok.')) {
    const parts = token.split('.');
    if (parts.length === 3) {
      const payloadStr = parts[1];
      const signature = parts[2];
      const expectedSig = crypto.createHmac('sha256', AUTH_SECRET).update(payloadStr).digest('base64url');

      if (crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) {
        try {
          const payload = JSON.parse(Buffer.from(payloadStr, 'base64url').toString('utf-8'));
          return Boolean(payload && payload.requestId);
        } catch {
          return false;
        }
      }
    }
  }

  // Handle legacy/memory tokens
  return false;
}

/**
 * Revokes a session token on logout.
 */
export function revokeAccessToken(token) {
  if (!token) return false;
  revokedSessionTokens.add(token);
  return true;
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

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Direct Async Update Handler for Webhook & Serverless Execution
 */
export async function processIncomingUpdate(update) {
  if (!update) return;

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const bot = botInstance || initTelegramBot();

  // Handle Callback Queries (e.g. [Approve Access], [Reject Request], [Skip .env])
  if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = cb.message?.chat?.id;
    const messageId = cb.message?.message_id;
    const data = cb.data;

    // Handle 1-Click Visitor Authentication Approvals
    if (data && data.startsWith('auth_approve:')) {
      const requestId = data.split(':')[1];
      const record = await approveAccessRequest(requestId, cb.from?.first_name || 'Admin');

      if (token) {
        try {
          await axios.post(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
            callback_query_id: cb.id,
            text: `✅ Access APPROVED for ${record ? record.name : 'visitor'}!`,
            show_alert: false
          }, { timeout: 3500 });
        } catch {}

        if (chatId && messageId && record) {
          try {
            await axios.post(`https://api.telegram.org/bot${token}/editMessageText`, {
              chat_id: chatId,
              message_id: messageId,
              text: `✅ <b>ACCESS REQUEST APPROVED</b>\n\n` +
                    `👤 <b>Visitor Name:</b> ${escapeHtml(record.name)}\n` +
                    `🎯 <b>Reason for Contact:</b> ${escapeHtml(record.reason)}\n` +
                    `🛡️ <b>Status:</b> Granted by ${escapeHtml(cb.from?.first_name || 'Admin')} ✅\n` +
                    `🕒 <b>Approved At:</b> ${new Date().toLocaleTimeString()}\n\n` +
                    `<i>Website launchpad is now unlocked for this visitor.</i>`,
              parse_mode: 'HTML'
            }, { timeout: 3500 });
          } catch (e) {
            console.warn('[Edit message error]:', e.message);
          }
        }
      }
      return;
    }

    // Handle 1-Click Visitor Authentication Rejections
    if (data && data.startsWith('auth_reject:')) {
      const requestId = data.split(':')[1];
      const record = await rejectAccessRequest(requestId, cb.from?.first_name || 'Admin');

      if (token) {
        try {
          await axios.post(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
            callback_query_id: cb.id,
            text: `❌ Access DECLINED for ${record ? record.name : 'visitor'}`,
            show_alert: false
          }, { timeout: 3500 });
        } catch {}

        if (chatId && messageId && record) {
          try {
            await axios.post(`https://api.telegram.org/bot${token}/editMessageText`, {
              chat_id: chatId,
              message_id: messageId,
              text: `❌ <b>ACCESS REQUEST DECLINED</b>\n\n` +
                    `👤 <b>Visitor Name:</b> ${escapeHtml(record.name)}\n` +
                    `🎯 <b>Reason for Contact:</b> ${escapeHtml(record.reason)}\n` +
                    `🚫 <b>Status:</b> Rejected by ${escapeHtml(cb.from?.first_name || 'Admin')}\n` +
                    `🕒 <b>Declined At:</b> ${new Date().toLocaleTimeString()}`,
              parse_mode: 'HTML'
            }, { timeout: 3500 });
          } catch (e) {
            console.warn('[Edit message error]:', e.message);
          }
        }
      }
      return;
    }

    if (data === 'skip_env' && chatId && bot) {
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
      `• /start - Start a new deployment & register admin\n` +
      `• /approve <id> - Manually approve an access request\n` +
      `• /reject <id> - Manually decline an access request\n` +
      `• /cancel - Reset current session\n` +
      `• /status - View recent deployments`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // Handle manual /approve or /reject command
  if (msg.text && (msg.text.startsWith('/approve') || msg.text.startsWith('/reject'))) {
    const parts = msg.text.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const targetRequestId = parts[1];

    if (!targetRequestId) {
      await bot.sendMessage(chatId, `💡 Usage: \`${cmd} <requestId>\` (e.g. \`${cmd} req_12345\`)`, { parse_mode: 'Markdown' });
      return;
    }

    if (cmd === '/approve') {
      const record = await approveAccessRequest(targetRequestId, msg.from?.first_name || 'Admin');
      await bot.sendMessage(chatId, `✅ *Approved access for:* \`${record.name}\` (ID: \`${targetRequestId}\`)\nWebsite launchpad is now unlocked!`, { parse_mode: 'Markdown' });
    } else {
      const record = await rejectAccessRequest(targetRequestId, msg.from?.first_name || 'Admin');
      await bot.sendMessage(chatId, `🚫 *Declined request for:* \`${record.name}\` (ID: \`${targetRequestId}\`)`, { parse_mode: 'Markdown' });
    }
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

