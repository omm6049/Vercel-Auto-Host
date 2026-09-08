import { ensureHtmlLinks, sanitizeProjectName } from '../src/services/vercel.js';
import fs from 'fs';
import path from 'path';

console.log('🧪 [Test]: Verifying sample website files and auto-linking...');

const html = fs.readFileSync(path.resolve('sample_website/index.html'), 'utf-8');
const css = fs.readFileSync(path.resolve('sample_website/style.css'), 'utf-8');
const js = fs.readFileSync(path.resolve('sample_website/logic.js'), 'utf-8');

console.log(`- index.html loaded: ${html.length} bytes`);
console.log(`- style.css loaded: ${css.length} bytes`);
console.log(`- logic.js loaded: ${js.length} bytes`);

const processedHtml = ensureHtmlLinks(html);
const sanitizedName = sanitizeProjectName('My Awesome Project 123');

console.log(`- Sanitized Project Name: ${sanitizedName}`);
console.log(`- Target Vercel Domain: https://${sanitizedName}.vercel.app`);

if (processedHtml.includes('style.css') && processedHtml.includes('logic.js')) {
  console.log('✅ End-to-end sample verification passed: All 3 files interconnected!');
} else {
  console.error('❌ Linking failed');
  process.exit(1);
}
