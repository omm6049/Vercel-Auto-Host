import 'dotenv/config';
import assert from 'assert';
import {
  createAccessRequest,
  approveAccessRequest,
  rejectAccessRequest,
  deleteAccessRequest,
  getAllAccessRequests,
  getActiveUsersList,
  getBlockedUsersList,
  verifyAccessToken,
  getAccessStatusByIpAsync,
  normalizeIp,
  ADMIN_KEYBOARD_SHORTCUTS,
  processIncomingUpdate
} from '../src/services/telegramBot.js';

async function runUserManagementTests() {
  console.log('🧪 [Test]: Running Telegram Admin User Management & /start Dashboard Test Suite...\n');

  // 1. Verify Persistent Keyboard Shortcuts Structure
  console.log('--- Test 1: Keyboard Shortcuts Verification ---');
  assert(ADMIN_KEYBOARD_SHORTCUTS, 'ADMIN_KEYBOARD_SHORTCUTS must exist');
  assert.strictEqual(ADMIN_KEYBOARD_SHORTCUTS.resize_keyboard, true);
  assert.strictEqual(ADMIN_KEYBOARD_SHORTCUTS.is_persistent, true);
  
  const buttonsFlat = ADMIN_KEYBOARD_SHORTCUTS.keyboard.flat().map(b => b.text);
  assert(buttonsFlat.includes('🚀 Deploy New Website'), 'Shortcut keyboard must include Deploy New Website');
  assert(buttonsFlat.includes('👥 Active Users'), 'Shortcut keyboard must include Active Users');
  assert(buttonsFlat.includes('🚫 Blocked Users'), 'Shortcut keyboard must include Blocked Users');
  assert(buttonsFlat.includes('🔄 /start'), 'Shortcut keyboard must include /start');
  console.log('✅ Bottom keyboard shortcuts structure verified:', buttonsFlat);

  // 2. Create sample users (one approved, one blocked)
  console.log('\n--- Test 2: Seed Test Users ---');
  const user1 = await createAccessRequest({
    name: 'Alice Developer',
    reason: 'Testing portfolio deployment',
    ip: '103.21.244.1',
    clientTimezone: 'Asia/Kolkata',
    deviceInfo: 'MacOS • Safari'
  });
  const approvedAlice = await approveAccessRequest(user1.cloudId || user1.id, 'SuperAdmin');
  assert.strictEqual(approvedAlice.status, 'APPROVED');

  const user2 = await createAccessRequest({
    name: 'Bob Spammer',
    reason: 'Malicious spam attempt',
    ip: '185.220.101.5',
    clientTimezone: 'UTC',
    deviceInfo: 'Linux • Firefox'
  });
  const rejectedBob = await rejectAccessRequest(user2.cloudId || user2.id, 'SuperAdmin');
  assert.strictEqual(rejectedBob.status, 'REJECTED');

  console.log('✅ Created & configured test users: Alice (APPROVED), Bob (REJECTED)');

  // 3. Test Active and Blocked lists
  console.log('\n--- Test 3: Query Active & Blocked Lists ---');
  const activeList = getActiveUsersList();
  const blockedList = getBlockedUsersList();

  const foundAlice = activeList.find(u => u.name === 'Alice Developer');
  const foundBob = blockedList.find(u => u.name === 'Bob Spammer');

  assert(foundAlice, 'Alice should be in Active Users list');
  assert.strictEqual(foundAlice.status, 'APPROVED');
  assert(foundBob, 'Bob should be in Blocked Users list');
  assert.strictEqual(foundBob.status, 'REJECTED');
  console.log(`✅ Active users count: ${activeList.length} | Blocked users count: ${blockedList.length}`);

  // 4. Test Blocking an Active User (Block Access action)
  console.log('\n--- Test 4: Block Active User Action (user_block) ---');
  const aliceActiveToken = approvedAlice.token;
  assert.strictEqual(verifyAccessToken(aliceActiveToken), true, 'Alice token must initially be valid');

  const blockedAlice = await rejectAccessRequest(user1.cloudId || user1.id, 'Admin');
  assert.strictEqual(blockedAlice.status, 'REJECTED');
  assert.strictEqual(blockedAlice.token, null, 'Blocked user token must be cleared');
  assert.strictEqual(verifyAccessToken(aliceActiveToken), false, 'Alice token must immediately become INVALID when blocked by Admin');

  const activeAfterBlock = getActiveUsersList();
  const blockedAfterBlock = getBlockedUsersList();

  assert(!activeAfterBlock.some(u => u.id === user1.id), 'Alice should no longer be in Active list');
  assert(blockedAfterBlock.some(u => u.id === user1.id), 'Alice should now be present in Blocked Users list');
  console.log('✅ Blocked Alice successfully: token instantly invalidated, moved from Active Users to Blocked Users in real-time');

  // 5. Test Activating a Blocked User (Activate Access action)
  console.log('\n--- Test 5: Reactivate Blocked User Action (user_activate) ---');
  const activatedAlice = await approveAccessRequest(user1.cloudId || user1.id, 'Admin');
  assert.strictEqual(activatedAlice.status, 'APPROVED');
  assert(activatedAlice.token && activatedAlice.token.startsWith('tok.'), 'New HMAC token must be generated upon activation');
  assert.strictEqual(verifyAccessToken(activatedAlice.token), true, 'New token must be valid');

  const activeAfterActivate = getActiveUsersList();
  assert(activeAfterActivate.some(u => u.id === user1.id), 'Alice should be back in Active list');
  console.log('✅ Reactivated Alice with new valid session token:', activatedAlice.token);

  // 6. Test Removing a User (Remove User action)
  console.log('\n--- Test 6: Remove User Action (user_remove) ---');
  const aliceToken = activatedAlice.token;
  await deleteAccessRequest(user1.cloudId || user1.id);
  
  const allAfterDelete = getAllAccessRequests();
  assert(!allAfterDelete.some(u => u.id === user1.id), 'Alice should be deleted from all records');
  assert.strictEqual(verifyAccessToken(aliceToken), false, 'Deleted user token must be revoked');
  console.log('✅ Removed Alice record and revoked session token');

  // 7. Test Real-Time IP Binding: Auto-Approval & Auto-Block by IP Address
  console.log('\n--- Test 7: IP Binding, Auto-Approval & Auto-Block Real-Time Recognition ---');
  // Seed User 3 from IP 142.250.190.46
  const user3 = await createAccessRequest({
    name: 'Charlie Production',
    reason: 'Production web app',
    ip: '142.250.190.46'
  });
  // Approve user 3
  const approvedCharlie = await approveAccessRequest(user3.id, 'Admin');
  assert.strictEqual(approvedCharlie.status, 'APPROVED');

  // Query by IP address
  const ipMatchApproved = await getAccessStatusByIpAsync('142.250.190.46');
  assert(ipMatchApproved, 'Should find approved user by IP address');
  assert.strictEqual(ipMatchApproved.status, 'APPROVED');
  assert(ipMatchApproved.token && ipMatchApproved.token.startsWith('tok.'), 'Should have valid active token for auto-login');
  console.log('✅ IP Recognition (APPROVED): Automatically authorized IP 142.250.190.46 directly to deployment cockpit with token');

  // Block user 3
  const blockedCharlie = await rejectAccessRequest(user3.id, 'Admin');
  assert.strictEqual(blockedCharlie.status, 'REJECTED');

  // Query by IP address after block
  const ipMatchBlocked = await getAccessStatusByIpAsync('142.250.190.46');
  assert(ipMatchBlocked, 'Should find blocked user by IP address');
  assert.strictEqual(ipMatchBlocked.status, 'REJECTED');
  console.log('✅ IP Recognition (REJECTED): Automatically blocked IP 142.250.190.46 directly to Request Blocked screen');

  // Reactivate user 3 from blocked state
  const reactivatedCharlie = await approveAccessRequest(user3.id, 'Admin');
  assert.strictEqual(reactivatedCharlie.status, 'APPROVED');
  const ipMatchReactivated = await getAccessStatusByIpAsync('142.250.190.46');
  assert.strictEqual(ipMatchReactivated.status, 'APPROVED');
  console.log('✅ IP Recognition (REACTIVATED): Automatically re-unlocked IP in real-time');

  // Cleanup
  await deleteAccessRequest(user3.id);
  await deleteAccessRequest(user2.cloudId || user2.id);

  console.log('\n🎉 ALL USER MANAGEMENT, SHORTCUT DASHBOARD & IP AUTO-LOGIN/BLOCK TESTS PASSED (100%)!\n');
}

runUserManagementTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});

