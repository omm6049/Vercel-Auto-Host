import { sanitizeProjectName, ensureHtmlLinks } from '../src/services/vercel.js';

console.log('🧪 [Test]: Running Vercel Auto Host verification checks...');

// Test 1: Sanitize Project Name
const name1 = sanitizeProjectName('My Awesome Website!! 2026');
const name2 = sanitizeProjectName('___Super---Site___');
console.log('Test 1 - Sanitize Names:');
console.log('  "My Awesome Website!! 2026" ->', name1);
console.log('  "___Super---Site___" ->', name2);
if (name1 !== 'my-awesome-website-2026' || name2 !== 'super-site') {
  console.error('❌ Failed sanitize test');
  process.exit(1);
}

// Test 2: HTML Auto-Linking
const bareHtml = '<h1>Hello World</h1><p>Test paragraph</p>';
const linkedHtml = ensureHtmlLinks(bareHtml);
console.log('\nTest 2 - Auto Link Injection:');
console.log('  Original:', bareHtml);
console.log('  Processed:', linkedHtml);

if (!linkedHtml.includes('style.css') || !linkedHtml.includes('logic.js')) {
  console.error('❌ Failed HTML auto linking test');
  process.exit(1);
}

// Test 3: Existing HTML with head/body
const fullHtml = '<!DOCTYPE html><html><head><title>Test</title></head><body><h1>Hi</h1></body></html>';
const linkedFull = ensureHtmlLinks(fullHtml);
console.log('\nTest 3 - Full HTML Auto Linking:');
console.log('  Processed:', linkedFull);

if (!linkedFull.includes('<link rel="stylesheet" href="style.css">') || !linkedFull.includes('<script src="logic.js"></script>')) {
  console.error('❌ Failed Full HTML auto linking test');
  process.exit(1);
}

console.log('\n✅ All unit and integration test assertions passed successfully!');
