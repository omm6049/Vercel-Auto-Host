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

const EDGE_CONFIG_ID = process.env.EDGE_CONFIG_ID || 'ecfg_1pxbtp8zonmlvthxsjn9klii7pvr';
const VERCEL_TOKEN = process.env.VERCEL_TOKEN;

/**
 * Normalizes an IP address (strips IPv6 prefixes, trims whitespace)
 */
export function normalizeIp(ip) {
  if (!ip || typeof ip !== 'string') return '';
  let clean = ip.trim();
  if (clean.startsWith('::ffff:')) {
    clean = clean.replace('::ffff:', '');
  }
  if (clean === '::1') {
    clean = '127.0.0.1';
  }
  return clean;
}

/**
 * Reads a single record from Vercel Edge Config
 */
async function getEdgeConfigRecord(id) {
  if (!VERCEL_TOKEN || !EDGE_CONFIG_ID || !id) return null;
  try {
    const cleanKey = `req_${id.replace(/^req_/, '')}`;
    const res = await axios.get(`https://api.vercel.com/v1/edge-config/${EDGE_CONFIG_ID}/item/${encodeURIComponent(cleanKey)}`, {
      headers: { Authorization: `Bearer ${VERCEL_TOKEN}` },
      timeout: 3000
    });
    if (res.data && res.data.value) {
      return res.data.value;
    }
  } catch (err) {}
  return null;
}

/**
 * Reads master requests list from Vercel Edge Config
 */
async function getEdgeConfigMasterList() {
  if (!VERCEL_TOKEN || !EDGE_CONFIG_ID) return [];
  try {
    const res = await axios.get(`https://api.vercel.com/v1/edge-config/${EDGE_CONFIG_ID}/item/master_list`, {
      headers: { Authorization: `Bearer ${VERCEL_TOKEN}` },
      timeout: 3000
    });
    if (res.data && Array.isArray(res.data.value)) {
      return res.data.value;
    }
  } catch (err) {}
  return [];
}

/**
 * Synchronizes local memory and disk cache from Vercel Edge Config
 */
export async function syncFromCloudStore() {
  loadRequestsFromDisk();
  try {
    const list = await getEdgeConfigMasterList();
    if (Array.isArray(list) && list.length > 0) {
      for (const item of list) {
        if (item && item.id) {
          accessRequests.set(item.id, item);
          if (item.cloudId) {
            accessRequests.set(item.cloudId, item);
          }
          if (item.status === 'REJECTED' && item.token) {
            revokedSessionTokens.add(item.token);
          }
        }
      }
      saveRequestsToDisk();
    }
  } catch (err) {}
}

/**
 * Looks up the latest visitor status by client IP address across Edge Config and local cache
 */
export async function getAccessStatusByIpAsync(rawIp) {
  const ip = normalizeIp(rawIp);
  if (!ip) return null;

  loadRequestsFromDisk();

  // 1. Direct Edge Config key lookup by IP
  if (VERCEL_TOKEN && EDGE_CONFIG_ID) {
    try {
      const cleanIpKey = `ip_${ip.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
      const res = await axios.get(`https://api.vercel.com/v1/edge-config/${EDGE_CONFIG_ID}/item/${encodeURIComponent(cleanIpKey)}`, {
        headers: { Authorization: `Bearer ${VERCEL_TOKEN}` },
        timeout: 3000
      });
      if (res.data && res.data.value) {
        const cloudRecord = res.data.value;
        accessRequests.set(cloudRecord.id, cloudRecord);
        if (cloudRecord.status === 'REJECTED' && cloudRecord.token) {
          revokedSessionTokens.add(cloudRecord.token);
        }
        saveRequestsToDisk();
        return cloudRecord;
      }
    } catch {}
  }

  // 2. In-memory / disk lookup
  const all = getAllAccessRequests();
  const found = all.find(r => r && normalizeIp(r.ip) === ip);
  if (found) return found;

  // 3. Fallback: sync from Edge Config master list
  await syncFromCloudStore();
  const refreshed = getAllAccessRequests().find(r => r && normalizeIp(r.ip) === ip);
  return refreshed || null;
}

/**
 * Upserts a single access request record and updates the master list & IP index in Vercel Edge Config
 */
export async function syncRecordToCloudStore(record) {
  if (!record || !record.id) return;
  
  accessRequests.set(record.id, record);
  if (record.cloudId) {
    accessRequests.set(record.cloudId, record);
  }
  saveRequestsToDisk();

  if (!VERCEL_TOKEN || !EDGE_CONFIG_ID) return;

  try {
    const map = new Map();
    for (const r of accessRequests.values()) {
      if (r && r.id) map.set(r.id, r);
    }
    const allList = Array.from(map.values());
    const cleanKey = `req_${record.id.replace(/^req_/, '')}`;

    const items = [
      { operation: 'upsert', key: cleanKey, value: record },
      { operation: 'upsert', key: 'master_list', value: allList }
    ];

    if (record.ip && record.ip !== 'Unknown') {
      const cleanIp = normalizeIp(record.ip);
      if (cleanIp) {
        const cleanIpKey = `ip_${cleanIp.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        items.push({ operation: 'upsert', key: cleanIpKey, value: record });
      }
    }

    await axios.patch(`https://api.vercel.com/v1/edge-config/${EDGE_CONFIG_ID}/items`, {
      items
    }, {
      headers: { Authorization: `Bearer ${VERCEL_TOKEN}`, 'Content-Type': 'application/json' },
      timeout: 3500
    });
  } catch (err) {
    console.warn('[Edge Config Push Notice]:', err.response?.data?.error?.message || err.message);
  }
}

/**
 * Deletes an access request from Vercel Edge Config
 */
export async function deleteRecordFromCloudStore(id) {
  if (!id) return;
  let targetRecord = accessRequests.get(id);
  const map = new Map();
  for (const r of accessRequests.values()) {
    if (r && r.id && r.id !== id && r.cloudId !== id) map.set(r.id, r);
  }
  const allList = Array.from(map.values());
  const cleanKey = `req_${id.replace(/^req_/, '')}`;

  if (VERCEL_TOKEN && EDGE_CONFIG_ID) {
    try {
      const items = [
        { operation: 'delete', key: cleanKey },
        { operation: 'upsert', key: 'master_list', value: allList }
      ];
      if (targetRecord && targetRecord.ip && targetRecord.ip !== 'Unknown') {
        const cleanIp = normalizeIp(targetRecord.ip);
        if (cleanIp) {
          const cleanIpKey = `ip_${cleanIp.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
          items.push({ operation: 'delete', key: cleanIpKey });
        }
      }

      await axios.patch(`https://api.vercel.com/v1/edge-config/${EDGE_CONFIG_ID}/items`, {
        items
      }, {
        headers: { Authorization: `Bearer ${VERCEL_TOKEN}`, 'Content-Type': 'application/json' },
        timeout: 3500
      });
    } catch (err) {}
  }
}

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
            if (item.cloudId) {
              accessRequests.set(item.cloudId, item);
            }
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
 * Automatically cleans up and unpins any legacy raw JSON state store messages from the admin chat
 */
async function cleanLegacyPinnedStateStore() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  const adminChatIds = Array.from(registeredAdminChatIds);

  for (const adminChatId of adminChatIds) {
    try {
      const chatInfo = await axios.get(`https://api.telegram.org/bot${token}/getChat?chat_id=${adminChatId}`, { timeout: 3000 });
      const pinned = chatInfo.data?.result?.pinned_message;
      if (pinned && pinned.text && pinned.text.startsWith('⚙️ Vercel Auto Host State Store:')) {
        await axios.post(`https://api.telegram.org/bot${token}/unpinChatMessage`, {
          chat_id: adminChatId,
          message_id: pinned.message_id
        }, { timeout: 3000 }).catch(() => {});

        await axios.post(`https://api.telegram.org/bot${token}/deleteMessage`, {
          chat_id: adminChatId,
          message_id: pinned.message_id
        }, { timeout: 3000 }).catch(() => {});
        console.log(`[Telegram Cleanup]: Removed legacy raw JSON state store message from chat ${adminChatId}`);
      }
    } catch {}
  }
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
 * Displays only TWO options in Telegram: Approve Access or Reject Access.
 */
export async function createAccessRequest({ name, reason, ip, clientTime, clientTimezone, deviceInfo, hostUrl }) {
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
    cloudId: requestId,
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
  await syncRecordToCloudStore(record);

  // Auto-register webhook on Vercel if hostUrl provided
  if (hostUrl && (process.env.VERCEL === '1' || process.env.USE_WEBHOOK === 'true')) {
    setBotWebhook(hostUrl).catch(() => {});
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const adminChatIds = await discoverAdminChatIds();

  // Clean any legacy raw JSON state store pinned messages from previous versions
  cleanLegacyPinnedStateStore().catch(() => {});

  const targetId = requestId;

  // Broadcast to Telegram admin(s) - ONLY TWO BUTTONS: Approve Access or Reject Access
  if (token && adminChatIds.length > 0) {
    const alertHtml =
      `🔐 <b>NEW WEBSITE ACCESS REQUEST</b>\n\n` +
      `👤 <b>Visitor Name:</b> ${escapeHtml(cleanName)}\n` +
      `🎯 <b>Reason for Contact:</b> ${escapeHtml(cleanReason)}\n` +
      `🌐 <b>Client IP:</b> <code>${escapeHtml(cleanIp)}</code>\n` +
      `⏰ <b>Exact Time:</b> ${escapeHtml(cleanTime)}${escapeHtml(tzLabel)}\n` +
      `💻 <b>Device / Browser:</b> ${escapeHtml(cleanDevice)}\n\n` +
      `👇 <b>Choose an option to approve or reject access:</b>`;

    const replyMarkup = {
      inline_keyboard: [
        [
          { text: '✅ Approve Access', callback_data: `auth_approve:${targetId}` },
          { text: '❌ Reject Access', callback_data: `auth_reject:${targetId}` }
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
    cloudId: null,
    name: 'Visitor',
    reason: 'Access verification',
    status: 'PENDING',
    token: null
  };
}

/**
 * Returns current status of an access request with asynchronous cloud & store verification.
 */
export async function getAccessRequestStatusAsync(requestId, cloudId = null) {
  loadRequestsFromDisk();

  let record = accessRequests.get(requestId) || (cloudId ? accessRequests.get(cloudId) : null);

  const targetId = requestId || cloudId;
  const cloudRecord = await getEdgeConfigRecord(targetId);
  if (cloudRecord && cloudRecord.status) {
    record = cloudRecord;
    accessRequests.set(record.id, record);
    if (record.cloudId) accessRequests.set(record.cloudId, record);
    if (record.status === 'REJECTED' && record.token) {
      revokedSessionTokens.add(record.token);
    }
    saveRequestsToDisk();
    return record;
  }

  if (record) return record;

  await syncFromCloudStore();
  record = accessRequests.get(requestId) || (cloudId ? accessRequests.get(cloudId) : null);
  if (record) return record;

  return {
    id: requestId,
    cloudId: cloudId || null,
    name: 'Visitor',
    reason: 'Access verification',
    status: 'PENDING',
    token: null
  };
}

/**
 * Approves an access request, generates a secure HMAC session token, and updates status.
 */
export async function approveAccessRequest(targetId, approvedBy = 'Admin') {
  loadRequestsFromDisk();

  let record = accessRequests.get(targetId);
  if (!record) {
    const cloudRecord = await getEdgeConfigRecord(targetId);
    if (cloudRecord) record = cloudRecord;
  }

  if (!record) {
    record = {
      id: targetId.startsWith('req_') ? targetId : `req_${targetId}`,
      cloudId: targetId,
      name: 'Authorized Visitor',
      reason: 'Approved via Telegram',
      ip: 'Unknown',
      status: 'PENDING',
      createdAt: Date.now()
    };
  }

  // Generate stateless HMAC-signed token
  const sessionToken = signSessionToken({
    requestId: record.id,
    cloudId: record.cloudId || null,
    name: record.name,
    approvedBy,
    approvedAt: Date.now()
  });

  record.status = 'APPROVED';
  record.token = sessionToken;
  record.approvedBy = approvedBy;
  record.approvedAt = Date.now();

  accessRequests.set(record.id, record);
  if (record.cloudId) {
    accessRequests.set(record.cloudId, record);
  }
  saveRequestsToDisk();

  await syncRecordToCloudStore(record);

  return record;
}

/**
 * Rejects an access request and updates status to REJECTED.
 */
export async function rejectAccessRequest(targetId, rejectedBy = 'Admin') {
  loadRequestsFromDisk();

  let record = accessRequests.get(targetId);
  if (!record) {
    const cloudRecord = await getEdgeConfigRecord(targetId);
    if (cloudRecord) record = cloudRecord;
  }

  if (!record) {
    record = {
      id: targetId.startsWith('req_') ? targetId : `req_${targetId}`,
      cloudId: targetId,
      name: 'Visitor',
      reason: 'Rejected via Telegram',
      ip: 'Unknown',
      status: 'PENDING',
      createdAt: Date.now()
    };
  }

  if (record.token) {
    revokeAccessToken(record.token);
  }

  record.status = 'REJECTED';
  record.token = null;
  record.rejectedBy = rejectedBy;
  record.rejectedAt = Date.now();

  accessRequests.set(record.id, record);
  if (record.cloudId) {
    accessRequests.set(record.cloudId, record);
  }
  saveRequestsToDisk();

  await syncRecordToCloudStore(record);

  return record;
}

/**
 * Verifies if a session token is active and authorized.
 */
export function verifyAccessToken(token) {
  if (!token || typeof token !== 'string') return false;

  loadRequestsFromDisk();

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
          if (!payload || !payload.requestId) return false;

          const record = accessRequests.get(payload.requestId);
          if (record && record.status === 'REJECTED') {
            return false;
          }
          return true;
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
 * Asynchronously verifies if a session token is active and not revoked across global Edge Config
 */
export async function verifyAccessTokenAsync(token) {
  if (!token || typeof token !== 'string') return false;

  loadRequestsFromDisk();

  if (revokedSessionTokens.has(token)) return false;

  if (token.startsWith('tok.')) {
    const parts = token.split('.');
    if (parts.length === 3) {
      const payloadStr = parts[1];
      const signature = parts[2];
      const expectedSig = crypto.createHmac('sha256', AUTH_SECRET).update(payloadStr).digest('base64url');

      if (crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) {
        try {
          const payload = JSON.parse(Buffer.from(payloadStr, 'base64url').toString('utf-8'));
          if (!payload || !payload.requestId) return false;

          // Check real-time cloud store for cross-container revocation
          const cloudRecord = await getEdgeConfigRecord(payload.requestId);
          if (cloudRecord) {
            accessRequests.set(cloudRecord.id, cloudRecord);
            if (cloudRecord.status === 'REJECTED') {
              revokedSessionTokens.add(token);
              return false;
            }
            if (cloudRecord.status === 'APPROVED') {
              return true;
            }
          }

          const record = accessRequests.get(payload.requestId);
          if (record && record.status === 'REJECTED') {
            return false;
          }
          return true;
        } catch {
          return false;
        }
      }
    }
  }

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
 * Retrieves all unique visitor access requests
 */
export function getAllAccessRequests() {
  loadRequestsFromDisk();
  const map = new Map();
  for (const record of accessRequests.values()) {
    if (record && record.id) {
      map.set(record.id, record);
    }
  }
  return Array.from(map.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

/**
 * Retrieves all active / approved visitors
 */
export function getActiveUsersList() {
  return getAllAccessRequests().filter(r => r.status === 'APPROVED');
}

/**
 * Retrieves all blocked / rejected visitors
 */
export function getBlockedUsersList() {
  return getAllAccessRequests().filter(r => r.status === 'REJECTED');
}

/**
 * Deletes an access request record and revokes its session token
 */
export async function deleteAccessRequest(targetId) {
  loadRequestsFromDisk();
  let record = accessRequests.get(targetId);
  if (!record) {
    record = await getEdgeConfigRecord(targetId);
  }

  if (record) {
    if (record.token) {
      revokeAccessToken(record.token);
    }
    accessRequests.delete(record.id);
    if (record.cloudId) {
      accessRequests.delete(record.cloudId);
    }
    saveRequestsToDisk();
    await deleteRecordFromCloudStore(targetId);
  }
  return record;
}

/**
 * Telegram persistent bottom shortcut keyboard (next to attachment clip)
 */
export const ADMIN_KEYBOARD_SHORTCUTS = {
  keyboard: [
    [{ text: '🚀 Deploy New Website' }],
    [{ text: '👥 Active Users' }, { text: '🚫 Blocked Users' }],
    [{ text: '🔄 /start' }]
  ],
  resize_keyboard: true,
  is_persistent: true
};

/**
 * Registers official bot commands with Telegram
 */
export async function registerBotCommands() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || token === 'your_telegram_bot_token_here') return;
  try {
    await axios.post(`https://api.telegram.org/bot${token}/setMyCommands`, {
      commands: [
        { command: 'start', description: '🏠 Open Main Dashboard & Actions' },
        { command: 'deploy', description: '🚀 Deploy a new website to Vercel' },
        { command: 'active_users', description: '👥 View & manage active approved users' },
        { command: 'blocked_users', description: '🚫 View & manage blocked users' },
        { command: 'status', description: '📊 View recent deployment history' },
        { command: 'cancel', description: '❌ Cancel current workflow' }
      ]
    }, { timeout: 3500 });
  } catch (err) {
    console.warn('[Telegram Commands Registration Notice]:', err.message);
  }
}

/**
 * Inline Markup for Main Menu
 */
function getMainMenuMarkup() {
  return {
    inline_keyboard: [
      [{ text: '🚀 Deploy New Website', callback_data: 'cmd_deploy' }],
      [
        { text: '👥 Approved Users', callback_data: 'cmd_active_users' },
        { text: '🚫 Blocked Users', callback_data: 'cmd_blocked_users' }
      ]
    ]
  };
}

/**
 * Sends or updates the Main Menu Dashboard
 */
async function sendMainMenu(chatId, userName = 'Admin', messageId = null) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  const text =
    `👋 <b>Hello ${escapeHtml(userName)}!</b>\n\n` +
    `⚡ <b>Vercel Auto Host Control Panel</b>\n` +
    `Select an option below to manage website deployments and visitor access:\n\n` +
    `• 🚀 <b>Deploy New Website:</b> Upload .zip or HTML files & publish to Vercel\n` +
    `• 👥 <b>Approved Users:</b> View active users, details, and access control\n` +
    `• 🚫 <b>Blocked Users:</b> View blocked users & reactivate access`;

  if (messageId) {
    try {
      await axios.post(`https://api.telegram.org/bot${token}/editMessageText`, {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML',
        reply_markup: getMainMenuMarkup()
      }, { timeout: 4000 });
      return;
    } catch {}
  }

  await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    reply_markup: {
      ...getMainMenuMarkup(),
      ...ADMIN_KEYBOARD_SHORTCUTS
    }
  }, { timeout: 4000 });
}

/**
 * Starts the deployment workflow
 */
async function startDeployWorkflow(chatId, messageId = null) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;

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

  const text =
    `🚀 <b>DEPLOY NEW WEBSITE TO VERCEL</b>\n\n` +
    `📦 <b>Option 1 (Recommended):</b> Send your full <b>.ZIP file</b> (with <code>index.html</code> entrypoint).\n` +
    `📄 <b>Option 2:</b> Send individual source files (<code>index.html</code> ➔ <code>style.css</code> ➔ <code>logic.js</code>).\n\n` +
    `📌 <b>Step 1:</b> Please upload your <b>.ZIP file</b> or <b>index.html</b> document now!`;

  if (messageId) {
    try {
      await axios.post(`https://api.telegram.org/bot${token}/editMessageText`, {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔙 Back to Menu', callback_data: 'cmd_main_menu' }]
          ]
        }
      }, { timeout: 4000 });
      return;
    } catch {}
  }

  await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔙 Back to Menu', callback_data: 'cmd_main_menu' }]
      ]
    }
  }, { timeout: 4000 });
}

/**
 * Sends the Active / Approved Users list
 */
async function sendActiveUsersList(chatId, messageId = null) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  await syncFromCloudStore();
  const users = getActiveUsersList();
  let text = `👥 <b>ACTIVE & APPROVED USERS (${users.length})</b>\n\n`;

  const inline_keyboard = [];

  if (users.length === 0) {
    text += `<i>No active approved users found. When visitors request access from the website and are approved, they will appear here.</i>`;
  } else {
    text += `Select any user below to view full visitor details, remove, or block access:\n`;
    for (const user of users.slice(0, 12)) {
      const targetId = user.cloudId || user.id;
      const userLabel = `👤 ${user.name} • ${user.time ? user.time.split(',')[0] : 'Active'}`;
      inline_keyboard.push([{ text: userLabel, callback_data: `user_detail:${targetId}` }]);
    }
  }

  inline_keyboard.push([
    { text: '➕ Deploy Website', callback_data: 'cmd_deploy' },
    { text: '🚫 Blocked Users', callback_data: 'cmd_blocked_users' }
  ]);
  inline_keyboard.push([
    { text: '🔙 Main Menu', callback_data: 'cmd_main_menu' }
  ]);

  if (messageId) {
    try {
      await axios.post(`https://api.telegram.org/bot${token}/editMessageText`, {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard }
      }, { timeout: 4000 });
      return;
    } catch {}
  }

  await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard }
  }, { timeout: 4000 });
}

/**
 * Sends the Blocked Users list
 */
async function sendBlockedUsersList(chatId, messageId = null) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  await syncFromCloudStore();
  const users = getBlockedUsersList();
  let text = `🚫 <b>BLOCKED USERS (${users.length})</b>\n\n`;

  const inline_keyboard = [];

  if (users.length === 0) {
    text += `<i>No blocked users found. Users whose access is declined or blocked will appear here.</i>`;
  } else {
    text += `Select any blocked visitor below to view full details, remove, or reactivate access:\n`;
    for (const user of users.slice(0, 12)) {
      const targetId = user.cloudId || user.id;
      const userLabel = `🚫 ${user.name} • ${user.time ? user.time.split(',')[0] : 'Blocked'}`;
      inline_keyboard.push([{ text: userLabel, callback_data: `blocked_detail:${targetId}` }]);
    }
  }

  inline_keyboard.push([
    { text: '👥 Active Users', callback_data: 'cmd_active_users' },
    { text: '➕ Deploy Website', callback_data: 'cmd_deploy' }
  ]);
  inline_keyboard.push([
    { text: '🔙 Main Menu', callback_data: 'cmd_main_menu' }
  ]);

  if (messageId) {
    try {
      await axios.post(`https://api.telegram.org/bot${token}/editMessageText`, {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard }
      }, { timeout: 4000 });
      return;
    } catch {}
  }

  await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard }
  }, { timeout: 4000 });
}

/**
 * Sends detailed information for an Active user
 */
async function sendActiveUserDetail(chatId, messageId, targetId) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  loadRequestsFromDisk();
  let record = accessRequests.get(targetId);
  if (!record) {
    record = await getEdgeConfigRecord(targetId);
  }

  if (!record) {
    await sendActiveUsersList(chatId, messageId);
    return;
  }

  const text =
    `👤 <b>VISITOR DETAILS: ACTIVE USER</b>\n\n` +
    `🏷️ <b>Name:</b> ${escapeHtml(record.name)}\n` +
    `🎯 <b>Access Reason:</b> ${escapeHtml(record.reason)}\n` +
    `🌐 <b>IP Address:</b> <code>${escapeHtml(record.ip || 'Unknown')}</code>\n` +
    `⏰ <b>Request Time:</b> ${escapeHtml(record.time || 'Unknown')}\n` +
    `💻 <b>Device / Browser:</b> ${escapeHtml(record.device || 'Web Browser')}\n` +
    `🛡️ <b>Status:</b> ✅ Active & Approved\n` +
    `👑 <b>Approved By:</b> ${escapeHtml(record.approvedBy || 'Admin')}\n` +
    `🔑 <b>Session Token:</b> <code>${record.token ? 'Active (HMAC Signed)' : 'None'}</code>\n\n` +
    `👇 <b>Manage this user's access:</b>`;

  const inline_keyboard = [
    [
      { text: '🗑️ Remove User', callback_data: `user_remove:${targetId}` },
      { text: '🚫 Block Access', callback_data: `user_block:${targetId}` }
    ],
    [
      { text: '🔙 Back to Active Users', callback_data: 'cmd_active_users' }
    ]
  ];

  if (messageId) {
    try {
      await axios.post(`https://api.telegram.org/bot${token}/editMessageText`, {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard }
      }, { timeout: 4000 });
      return;
    } catch {}
  }

  await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard }
  }, { timeout: 4000 });
}

/**
 * Sends detailed information for a Blocked user
 */
async function sendBlockedUserDetail(chatId, messageId, targetId) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  loadRequestsFromDisk();
  let record = accessRequests.get(targetId);
  if (!record) {
    record = await getEdgeConfigRecord(targetId);
  }

  if (!record) {
    await sendBlockedUsersList(chatId, messageId);
    return;
  }

  const text =
    `🚫 <b>VISITOR DETAILS: BLOCKED USER</b>\n\n` +
    `🏷️ <b>Name:</b> ${escapeHtml(record.name)}\n` +
    `🎯 <b>Access Reason:</b> ${escapeHtml(record.reason)}\n` +
    `🌐 <b>IP Address:</b> <code>${escapeHtml(record.ip || 'Unknown')}</code>\n` +
    `⏰ <b>Request Time:</b> ${escapeHtml(record.time || 'Unknown')}\n` +
    `💻 <b>Device / Browser:</b> ${escapeHtml(record.device || 'Web Browser')}\n` +
    `🚫 <b>Status:</b> ❌ Blocked by Admin\n` +
    `👑 <b>Blocked By:</b> ${escapeHtml(record.rejectedBy || 'Admin')}\n\n` +
    `👇 <b>Manage this user's access:</b>`;

  const inline_keyboard = [
    [
      { text: '🗑️ Remove User', callback_data: `user_remove:${targetId}` },
      { text: '✅ Activate Access', callback_data: `user_activate:${targetId}` }
    ],
    [
      { text: '🔙 Back to Blocked Users', callback_data: 'cmd_blocked_users' }
    ]
  ];

  if (messageId) {
    try {
      await axios.post(`https://api.telegram.org/bot${token}/editMessageText`, {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard }
      }, { timeout: 4000 });
      return;
    } catch {}
  }

  await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard }
  }, { timeout: 4000 });
}

/**
 * Direct Async Update Handler for Webhook & Serverless Execution
 */
export async function processIncomingUpdate(update) {
  if (!update) return;

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const bot = botInstance || initTelegramBot();

  // Handle Callback Queries (e.g. [Approve Access], [Reject Request], [Skip .env], [User Actions])
  if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = cb.message?.chat?.id;
    const messageId = cb.message?.message_id;
    const data = cb.data;

    // 1. Navigation Actions
    if (data === 'cmd_main_menu') {
      await sendMainMenu(chatId, cb.from?.first_name || 'Admin', messageId);
      try { await axios.post(`https://api.telegram.org/bot${token}/answerCallbackQuery`, { callback_query_id: cb.id }); } catch {}
      return;
    }

    if (data === 'cmd_deploy') {
      await startDeployWorkflow(chatId, messageId);
      try { await axios.post(`https://api.telegram.org/bot${token}/answerCallbackQuery`, { callback_query_id: cb.id }); } catch {}
      return;
    }

    if (data === 'cmd_active_users') {
      await sendActiveUsersList(chatId, messageId);
      try { await axios.post(`https://api.telegram.org/bot${token}/answerCallbackQuery`, { callback_query_id: cb.id }); } catch {}
      return;
    }

    if (data === 'cmd_blocked_users') {
      await sendBlockedUsersList(chatId, messageId);
      try { await axios.post(`https://api.telegram.org/bot${token}/answerCallbackQuery`, { callback_query_id: cb.id }); } catch {}
      return;
    }

    // 2. User Detail Views
    if (data && data.startsWith('user_detail:')) {
      const targetId = data.substring('user_detail:'.length);
      await sendActiveUserDetail(chatId, messageId, targetId);
      try { await axios.post(`https://api.telegram.org/bot${token}/answerCallbackQuery`, { callback_query_id: cb.id }); } catch {}
      return;
    }

    if (data && data.startsWith('blocked_detail:')) {
      const targetId = data.substring('blocked_detail:'.length);
      await sendBlockedUserDetail(chatId, messageId, targetId);
      try { await axios.post(`https://api.telegram.org/bot${token}/answerCallbackQuery`, { callback_query_id: cb.id }); } catch {}
      return;
    }

    // 3. User Management Actions (Remove, Block, Activate)
    if (data && data.startsWith('user_remove:')) {
      const targetId = data.substring('user_remove:'.length);
      const record = await deleteAccessRequest(targetId);
      if (token) {
        try {
          await axios.post(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
            callback_query_id: cb.id,
            text: `🗑️ User ${record ? record.name : ''} removed successfully!`,
            show_alert: false
          }, { timeout: 3500 });
        } catch {}
      }
      await sendActiveUsersList(chatId, messageId);
      return;
    }

    if (data && data.startsWith('user_block:')) {
      const targetId = data.substring('user_block:'.length);
      const record = await rejectAccessRequest(targetId, cb.from?.first_name || 'Admin');
      if (token) {
        try {
          await axios.post(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
            callback_query_id: cb.id,
            text: `🚫 Access BLOCKED for ${record ? record.name : 'visitor'}!`,
            show_alert: false
          }, { timeout: 3500 });
        } catch {}
      }
      await sendBlockedUserDetail(chatId, messageId, targetId);
      return;
    }

    if (data && data.startsWith('user_activate:')) {
      const targetId = data.substring('user_activate:'.length);
      const record = await approveAccessRequest(targetId, cb.from?.first_name || 'Admin');
      if (token) {
        try {
          await axios.post(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
            callback_query_id: cb.id,
            text: `✅ Access ACTIVATED for ${record ? record.name : 'visitor'}!`,
            show_alert: false
          }, { timeout: 3500 });
        } catch {}
      }
      await sendActiveUserDetail(chatId, messageId, targetId);
      return;
    }

    // 4. Handle 1-Click Visitor Authentication Approvals
    if (data && data.startsWith('auth_approve:')) {
      const targetId = data.substring('auth_approve:'.length);
      const record = await approveAccessRequest(targetId, cb.from?.first_name || 'Admin');

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
                    `🎯 <b>Reason:</b> ${escapeHtml(record.reason)}\n` +
                    `🛡️ <b>Status:</b> Approved by ${escapeHtml(cb.from?.first_name || 'Admin')} ✅\n` +
                    `🕒 <b>Approved At:</b> ${new Date().toLocaleTimeString()}\n\n` +
                    `<i>Website deployment launchpad is now unlocked for this visitor.</i>`,
              parse_mode: 'HTML',
              reply_markup: {
                inline_keyboard: [
                  [{ text: '👥 View Active Users', callback_data: 'cmd_active_users' }],
                  [{ text: '🚫 Block Access', callback_data: `user_block:${targetId}` }]
                ]
              }
            }, { timeout: 3500 });
          } catch (e) {
            console.warn('[Edit message error]:', e.message);
          }
        }
      }
      return;
    }

    // 5. Handle 1-Click Visitor Authentication Rejections
    if (data && data.startsWith('auth_reject:')) {
      const targetId = data.substring('auth_reject:'.length);
      const record = await rejectAccessRequest(targetId, cb.from?.first_name || 'Admin');

      if (token) {
        try {
          await axios.post(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
            callback_query_id: cb.id,
            text: `❌ Access REJECTED for ${record ? record.name : 'visitor'}`,
            show_alert: false
          }, { timeout: 3500 });
        } catch {}

        if (chatId && messageId && record) {
          try {
            await axios.post(`https://api.telegram.org/bot${token}/editMessageText`, {
              chat_id: chatId,
              message_id: messageId,
              text: `❌ <b>ACCESS REQUEST REJECTED</b>\n\n` +
                    `👤 <b>Visitor Name:</b> ${escapeHtml(record.name)}\n` +
                    `🎯 <b>Reason:</b> ${escapeHtml(record.reason)}\n` +
                    `🚫 <b>Status:</b> Blocked by Admin (${escapeHtml(cb.from?.first_name || 'Admin')}) ❌\n` +
                    `🕒 <b>Rejected At:</b> ${new Date().toLocaleTimeString()}\n\n` +
                    `<i>Access to the deployment launchpad has been blocked.</i>`,
              parse_mode: 'HTML',
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🚫 View Blocked Users', callback_data: 'cmd_blocked_users' }],
                  [{ text: '✅ Unblock / Activate', callback_data: `user_activate:${targetId}` }]
                ]
              }
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

  const rawText = (msg.text || '').trim();

  // Register admin chatId
  registeredAdminChatIds.add(String(chatId));
  saveAdminChatToDisk(chatId);

  // 1. /start command or "🔄 /start"
  if (rawText.startsWith('/start') || rawText === '🔄 /start') {
    const userName = msg.from?.first_name || 'there';
    await sendMainMenu(chatId, userName);
    return;
  }

  // 2. Deploy Website ("🚀 Deploy New Website" or "/deploy")
  if (rawText === '🚀 Deploy New Website' || rawText.startsWith('/deploy')) {
    await startDeployWorkflow(chatId);
    return;
  }

  // 3. Active Users ("👥 Active Users", "Approved User", "Active User", "/active_users", "/approved_users")
  if (
    rawText === '👥 Active Users' ||
    rawText.toLowerCase() === 'active user' ||
    rawText.toLowerCase() === 'active users' ||
    rawText.toLowerCase() === 'approved user' ||
    rawText.toLowerCase() === 'approved users' ||
    rawText.startsWith('/active_users') ||
    rawText.startsWith('/approved_users')
  ) {
    await sendActiveUsersList(chatId);
    return;
  }

  // 4. Blocked Users ("🚫 Blocked Users", "Blocked User", "/blocked_users")
  if (
    rawText === '🚫 Blocked Users' ||
    rawText.toLowerCase() === 'blocked user' ||
    rawText.toLowerCase() === 'blocked users' ||
    rawText.startsWith('/blocked_users')
  ) {
    await sendBlockedUsersList(chatId);
    return;
  }

  // 5. /cancel command handler
  if (rawText.startsWith('/cancel')) {
    userSessions.delete(chatId);
    await bot.sendMessage(
      chatId,
      '❌ *Current action cancelled.*\nUse the menu buttons below anytime!',
      {
        parse_mode: 'Markdown',
        reply_markup: ADMIN_KEYBOARD_SHORTCUTS
      }
    );
    return;
  }

  // 6. /help command handler
  if (rawText.startsWith('/help')) {
    await bot.sendMessage(
      chatId,
      `📖 *Vercel Auto Host Bot Help*\n\n` +
      `• *Deploy Website:* Upload a \`.zip\` file with your website.\n` +
      `• *Active Users:* View, inspect, remove, or block approved website visitors.\n` +
      `• *Blocked Users:* View, inspect, remove, or unblock/activate declined visitors.\n` +
      `• /start - Open main menu & shortcuts\n` +
      `• /deploy - Launch new website deployment\n` +
      `• /active_users - List approved visitors\n` +
      `• /blocked_users - List blocked visitors\n` +
      `• /status - View recent deployments`,
      {
        parse_mode: 'Markdown',
        reply_markup: ADMIN_KEYBOARD_SHORTCUTS
      }
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

  // Clean up any legacy raw JSON state store pinned messages from previous versions
  cleanLegacyPinnedStateStore().catch(() => {});

  // Register command shortcuts with Telegram
  registerBotCommands().catch(() => {});

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

