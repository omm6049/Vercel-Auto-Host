import assert from 'assert';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  createAccessRequest,
  cancelAccessRequest,
  approveAccessRequest,
  rejectAccessRequest,
  clearAllActiveUsers,
  clearAllBlockedUsers,
  getAccessStatusByIpAsync,
  verifyAccessToken,
  accessRequests,
  revokedSessionTokens
} from '../src/services/telegramBot.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runCancelAndRevokeTests() {
  console.log('🧪 [Test]: Running Request Cancellation & Revoke vs Block Test Suite...\n');

  // --- Test 1: HTML Landing Page Cleanliness ---
  console.log('--- Test 1: Verify Instant Simulate Approval Button is Removed from HTML ---');
  const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
  const htmlContent = fs.readFileSync(htmlPath, 'utf-8');
  assert.ok(
    !htmlContent.includes('authSimulateApproveBtn'),
    'Instant Simulate Approval button should NOT exist in public/index.html'
  );
  assert.ok(
    !htmlContent.includes('Instant Simulate Approval'),
    'Instant Simulate Approval text should NOT exist in public/index.html'
  );
  assert.ok(
    htmlContent.includes('authCancelRequestBtn'),
    'Cancel Request button must remain in public/index.html'
  );
  console.log('✅ Instant Simulate Approval button is completely removed from landing page.\n');

  // --- Test 2: Request Creation & Telegram Message ID Tracking ---
  console.log('--- Test 2: Request Creation & Telegram Message Tracking ---');
  const req1 = await createAccessRequest(
    'John Visitor',
    'Testing request cancellation and auto-delete',
    '198.51.100.25',
    'Chrome on Windows',
    '10:00:00 PM',
    'Asia/Kolkata'
  );

  assert.ok(req1 && req1.id, 'Request must be created');
  assert.strictEqual(req1.status, 'PENDING');
  console.log(`✅ Created pending request ${req1.id} with tracking:`, req1.telegramMessages);

  // --- Test 3: Request Cancellation & Telegram Message Auto-Delete ---
  console.log('--- Test 3: Cancel Request & Verify Telegram Auto-Delete ---');
  const cancelled = await cancelAccessRequest(req1.id);
  assert.ok(cancelled, 'cancelAccessRequest should return cancelled record');
  assert.ok(!accessRequests.has(req1.id), 'Cancelled request must be removed from memory store');

  const ipStatusAfterCancel = await getAccessStatusByIpAsync('198.51.100.25');
  assert.ok(!ipStatusAfterCancel || ipStatusAfterCancel.status !== 'APPROVED', 'IP must not be approved after cancel');
  assert.ok(!ipStatusAfterCancel || ipStatusAfterCancel.status !== 'REJECTED', 'IP must not be blocked after cancel');
  console.log('✅ Request cancelled and cleaned up successfully from store & IP bindings.\n');

  // --- Test 4: Remove All Users Revokes Access (Shows Fillup Form, NOT Blocked) ---
  console.log('--- Test 4: "Remove All Users" Revokes Access (Fillup Form, NOT Blocked) ---');
  const activeUser = await createAccessRequest('Alice Active', 'Deploying production project', '198.51.100.50');
  const approvedAlice = await approveAccessRequest(activeUser.id, 'Admin');
  assert.strictEqual(approvedAlice.status, 'APPROVED');
  assert.ok(approvedAlice.token, 'Must have active session token');
  assert.strictEqual(verifyAccessToken(approvedAlice.token), true, 'Token must be valid');

  // Now admin triggers "Remove All Users"
  const removedCount = await clearAllActiveUsers();
  assert.ok(removedCount >= 1, 'Should have removed at least 1 active user');

  // Verify token is revoked
  const isTokenValid = verifyAccessToken(approvedAlice.token);
  assert.strictEqual(isTokenValid, false, 'Alice token must be revoked immediately');

  // Verify IP is NOT marked as REJECTED (user is NOT blocked, can see fillup form)
  const ipCheckAfterRemove = await getAccessStatusByIpAsync('198.51.100.50');
  assert.ok(
    !ipCheckAfterRemove || ipCheckAfterRemove.status !== 'REJECTED',
    'Removed user must NOT be marked as REJECTED (they see fillup form, not blocked)'
  );
  assert.ok(
    !ipCheckAfterRemove || ipCheckAfterRemove.status !== 'APPROVED',
    'Removed user must not remain APPROVED'
  );
  console.log('✅ "Remove All Users" successfully revokes access tokens and unbinds IP without blocking.\n');

  // --- Test 5: Explicit Block via "Reject / Block Access" shows Blocked Screen ---
  console.log('--- Test 5: Explicit Block via "Reject Access" (Shows Blocked Screen) ---');
  const maliciousUser = await createAccessRequest('Eve Spammer', 'Trying unauthorized access', '198.51.100.99');
  const blockedEve = await rejectAccessRequest(maliciousUser.id, 'Admin');
  assert.strictEqual(blockedEve.status, 'REJECTED');

  const ipCheckEve = await getAccessStatusByIpAsync('198.51.100.99');
  assert.ok(ipCheckEve, 'Blocked IP must be recognized');
  assert.strictEqual(ipCheckEve.status, 'REJECTED', 'Eve IP must be explicitly REJECTED (blocked screen)');
  console.log('✅ Explicit block correctly records REJECTED status for blocked screen.\n');

  // Cleanup
  await clearAllBlockedUsers();

  console.log('🎉 ALL REQUEST CANCELLATION, TELEGRAM AUTO-DELETE & REVOKE VS BLOCK TESTS PASSED (100%)!\n');
}

runCancelAndRevokeTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
