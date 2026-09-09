import axios from 'axios';
import assert from 'assert';

async function testE2E() {
  console.log('🚀 Running E2E Server & API Endpoints Verification...');

  // 1. Check /api/status
  const statusRes = await axios.get('http://localhost:3000/api/status');
  assert.strictEqual(statusRes.data.status, 'online');
  console.log('✅ /api/status online');

  // 2. Submit Auth Request
  const reqRes = await axios.post('http://localhost:3000/api/auth/request', {
    name: 'E2E Tester',
    reason: 'Testing Telegram 2-Button Inline Approval',
    clientIp: '127.0.0.1'
  });
  assert.strictEqual(reqRes.data.success, true);
  const { requestId, cloudId } = reqRes.data;
  console.log('✅ /api/auth/request created:', requestId, 'cloudId:', cloudId);

  // 3. Poll pending status
  const pendingStatus = await axios.get(`http://localhost:3000/api/auth/status?id=${requestId}&cloudId=${cloudId || ''}`);
  assert.strictEqual(pendingStatus.data.request.status, 'PENDING');
  console.log('✅ /api/auth/status is PENDING');

  // 4. Simulate Telegram Webhook Callback Query: auth_approve
  const webhookApproveRes = await axios.post('http://localhost:3000/api/webhook', {
    callback_query: {
      id: 'cb_test_approve_1',
      from: { id: 8531059191, first_name: 'Admin Boss' },
      message: { chat: { id: 8531059191 }, message_id: 9999 },
      data: `auth_approve:${cloudId || requestId}`
    }
  });
  assert.strictEqual(webhookApproveRes.status, 200);
  console.log('✅ Webhook processed auth_approve callback query');

  // 5. Poll approved status
  const approvedStatus = await axios.get(`http://localhost:3000/api/auth/status?id=${requestId}&cloudId=${cloudId || ''}`);
  assert.strictEqual(approvedStatus.data.request.status, 'APPROVED');
  assert(approvedStatus.data.request.token, 'Token must be present');
  console.log('✅ /api/auth/status is APPROVED with token:', approvedStatus.data.request.token);

  // 6. Verify Session Token
  const verifyRes = await axios.post('http://localhost:3000/api/auth/verify', {
    token: approvedStatus.data.request.token
  });
  assert.strictEqual(verifyRes.data.valid, true);
  console.log('✅ /api/auth/verify confirmed token validity');

  // 7. Test Rejection Webhook Flow
  const reqRes2 = await axios.post('http://localhost:3000/api/auth/request', {
    name: 'Blocked User',
    reason: 'Suspicious request',
    clientIp: '198.51.100.22'
  });
  const reqId2 = reqRes2.data.requestId;
  const cloudId2 = reqRes2.data.cloudId;

  const webhookRejectRes = await axios.post('http://localhost:3000/api/webhook', {
    callback_query: {
      id: 'cb_test_reject_2',
      from: { id: 8531059191, first_name: 'Admin Boss' },
      message: { chat: { id: 8531059191 }, message_id: 10000 },
      data: `auth_reject:${cloudId2 || reqId2}`
    }
  });
  assert.strictEqual(webhookRejectRes.status, 200);

  const rejectedStatus = await axios.get(`http://localhost:3000/api/auth/status?id=${reqId2}&cloudId=${cloudId2 || ''}`);
  assert.strictEqual(rejectedStatus.data.request.status, 'REJECTED');
  console.log('✅ /api/auth/status is REJECTED (Blocked by Admin confirmed)');

  console.log('\n🎉 ALL E2E API AND TELEGRAM WEBHOOK TESTS PASSED 100%!');
}

testE2E().catch(err => {
  console.error('❌ E2E Error:', err);
  process.exit(1);
});
