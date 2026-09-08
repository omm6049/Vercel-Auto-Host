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
  console.log('🧪 [Test]: Running Visitor Access Request & Telegram Bot 1-Click Approval Test Suite...\n');

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
  console.log('✅ Created access request with PENDING status:', reqRecord.id);

  // Test 2: Query Access Request Status
  console.log('\n--- Test 2: Query Pending Status ---');
  const queried = await getAccessRequestStatusAsync(reqRecord.id);
  assert.strictEqual(queried.status, 'PENDING');
  console.log('✅ Verified getAccessRequestStatus returns PENDING status');

  // Test 3: Simulate 1-Click Telegram Approval
  console.log('\n--- Test 3: 1-Click Telegram Admin Approval ---');
  const approvedRecord = await approveAccessRequest(reqRecord.id, 'TelegramAdminBot');
  assert.strictEqual(approvedRecord.status, 'APPROVED');
  assert(approvedRecord.token && approvedRecord.token.startsWith('tok.'), 'HMAC session token should be generated');
  assert.strictEqual(approvedRecord.approvedBy, 'TelegramAdminBot');
  console.log('✅ Approved request successfully! Token generated:', approvedRecord.token);

  // Test 4: Verify Session Token
  console.log('\n--- Test 4: Token Verification ---');
  assert.strictEqual(verifyAccessToken(approvedRecord.token), true, 'Session token should be valid');
  assert.strictEqual(verifyAccessToken('invalid_fake_token'), false, 'Fake token should be invalid');
  console.log('✅ Token verification working as expected');

  // Test 5: Rejection Flow
  console.log('\n--- Test 5: Rejection Flow ---');
  const req2 = await createAccessRequest({ name: 'Spam Bot', reason: 'Spamming', ip: '1.2.3.4' });
  const rejected = await rejectAccessRequest(req2.id, 'Admin');
  assert.strictEqual(rejected.status, 'REJECTED');
  assert.strictEqual(rejected.token, null);
  console.log('✅ Rejection status recorded successfully');

  // Test 6: Revoke Token (Logout)
  console.log('\n--- Test 6: Token Revocation ---');
  revokeAccessToken(approvedRecord.token);
  assert.strictEqual(verifyAccessToken(approvedRecord.token), false, 'Revoked token should now be invalid');
  console.log('✅ Token revocation confirmed');

  console.log('\n🎉 ALL VISITOR ACCESS & TELEGRAM APPROVAL TESTS PASSED (100%)!\n');
}

runAuthFlowTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});

