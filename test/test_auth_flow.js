import 'dotenv/config';
import assert from 'assert';
import {
  createAccessRequest,
  getAccessRequestStatus,
  getAccessRequestStatusAsync,
  approveAccessRequest,
  rejectAccessRequest,
  verifyAccessToken,
  revokeAccessToken
} from '../src/services/telegramBot.js';

async function runAuthFlowTests() {
  console.log('🧪 [Test]: Running Visitor Access Request & Telegram Bot 2-Button Inline Approval & Rejection Suite...\n');

  // Test 1: Create an Access Request
  console.log('--- Test 1: Create Access Request ---');
  const reqRecord = await createAccessRequest({
    name: 'Sarah Connor',
    reason: 'Evaluating Vercel Auto Host for production deployments',
    ip: '192.168.1.100'
  });

  assert(reqRecord.id.startsWith('req_'), 'Request ID should start with req_');
  assert.strictEqual(reqRecord.name, 'Sarah Connor');
  assert.strictEqual(reqRecord.status, 'PENDING');
  assert.strictEqual(reqRecord.token, null);
  console.log('✅ Created access request with PENDING status:', reqRecord.id, 'Cloud ID:', reqRecord.cloudId);

  // Test 2: Query Access Request Status
  console.log('\n--- Test 2: Query Pending Status ---');
  const queried = await getAccessRequestStatusAsync(reqRecord.id, reqRecord.cloudId);
  assert.strictEqual(queried.status, 'PENDING');
  console.log('✅ Verified getAccessRequestStatus returns PENDING status');

  // Test 3: Simulate Direct Telegram Bot Inline Approval
  console.log('\n--- Test 3: Direct Telegram Admin Approval ---');
  const targetId = reqRecord.cloudId || reqRecord.id;
  const approvedRecord = await approveAccessRequest(targetId, 'TelegramAdminBot');
  assert.strictEqual(approvedRecord.status, 'APPROVED');
  assert(approvedRecord.token && approvedRecord.token.startsWith('tok.'), 'HMAC session token should be generated');
  assert.strictEqual(approvedRecord.approvedBy, 'TelegramAdminBot');
  console.log('✅ Approved request successfully! Token generated:', approvedRecord.token);

  // Test 4: Query Approved Status via Cloud ID / Request ID
  console.log('\n--- Test 4: Query Approved Status (Async Sync) ---');
  const queriedApproved = await getAccessRequestStatusAsync(reqRecord.id, reqRecord.cloudId);
  assert.strictEqual(queriedApproved.status, 'APPROVED');
  assert(queriedApproved.token, 'Session token must be present');
  console.log('✅ Async status check confirmed APPROVED status with token');

  // Test 5: Verify Session Token
  console.log('\n--- Test 5: Token Verification ---');
  assert.strictEqual(verifyAccessToken(approvedRecord.token), true, 'Session token should be valid');
  assert.strictEqual(verifyAccessToken('invalid_fake_token'), false, 'Fake token should be invalid');
  console.log('✅ Token verification working as expected');

  // Test 6: Direct Telegram Bot Rejection Flow
  console.log('\n--- Test 6: Rejection Flow (Blocked by Admin) ---');
  const req2 = await createAccessRequest({ name: 'Spam Bot', reason: 'Spamming', ip: '1.2.3.4' });
  const targetId2 = req2.cloudId || req2.id;
  const rejected = await rejectAccessRequest(targetId2, 'Admin');
  assert.strictEqual(rejected.status, 'REJECTED');
  assert.strictEqual(rejected.token, null);
  
  const queriedRejected = await getAccessRequestStatusAsync(req2.id, req2.cloudId);
  assert.strictEqual(queriedRejected.status, 'REJECTED');
  console.log('✅ Rejection status recorded & verified successfully as REJECTED');

  // Test 7: Revoke Token (Logout)
  console.log('\n--- Test 7: Token Revocation ---');
  revokeAccessToken(approvedRecord.token);
  assert.strictEqual(verifyAccessToken(approvedRecord.token), false, 'Revoked token should now be invalid');
  console.log('✅ Token revocation confirmed');

  console.log('\n🎉 ALL VISITOR ACCESS & TELEGRAM 2-BUTTON APPROVE/REJECT TESTS PASSED (100%)!\n');
}

runAuthFlowTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
