import { extractZipToVercelFiles, parseEnvFileContent, sanitizeProjectName } from '../src/services/vercel.js';
import AdmZip from 'adm-zip';

console.log('🧪 [Test]: Running ZIP extraction & .env parsing test suite...');

// 1. Test .env Parsing
console.log('\n--- Test 1: .env File Parsing ---');
const sampleEnv = `
# Project secrets
DATABASE_URL="mongodb+srv://user:pass@cluster.mongodb.net/prod"
API_KEY=xyz_secret_9988
NEXT_PUBLIC_APP_NAME='My Awesome Vercel App'
EMPTY_VAL=

# Another comment
PORT=3000
`;

const parsed = parseEnvFileContent(sampleEnv);
console.log('Parsed Env:', parsed);

if (
  parsed.DATABASE_URL !== 'mongodb+srv://user:pass@cluster.mongodb.net/prod' ||
  parsed.API_KEY !== 'xyz_secret_9988' ||
  parsed.NEXT_PUBLIC_APP_NAME !== 'My Awesome Vercel App' ||
  parsed.PORT !== '3000'
) {
  console.error('❌ Failed .env parsing assertion');
  process.exit(1);
}
console.log('✅ .env parsing test passed!');

// 2. Test In-Memory ZIP Creation & Extraction (with various image formats: PNG, JPG, HEIC, WEBP, SVG)
console.log('\n--- Test 2: ZIP Extraction & Image Formats Support ---');
const zip = new AdmZip();
zip.addFile('index.html', Buffer.from('<!DOCTYPE html><html><body><img src="images/photo.heic"><img src="assets/banner.jpg"></body></html>', 'utf-8'));
zip.addFile('css/style.css', Buffer.from('body { background: url("../images/bg.webp"); }', 'utf-8'));
zip.addFile('images/photo.heic', Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63])); // dummy HEIC bytes
zip.addFile('assets/banner.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0])); // dummy JPG bytes
zip.addFile('assets/icon.png', Buffer.from([0x89, 0x50, 0x4e, 0x47])); // dummy PNG bytes
zip.addFile('images/bg.webp', Buffer.from([0x52, 0x49, 0x46, 0x46])); // dummy WEBP bytes
zip.addFile('assets/vector.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><circle r="10"/></svg>', 'utf-8'));

const zipBuffer = zip.toBuffer();
const extracted = extractZipToVercelFiles(zipBuffer);

console.log(`Extracted ${extracted.fileCount} files from ZIP:`);
extracted.files.forEach((f) => {
  console.log(`  • ${f.file} -> encoding: ${f.encoding}`);
});

const heicFile = extracted.files.find((f) => f.file === 'images/photo.heic');
const jpgFile = extracted.files.find((f) => f.file === 'assets/banner.jpg');
const pngFile = extracted.files.find((f) => f.file === 'assets/icon.png');
const webpFile = extracted.files.find((f) => f.file === 'images/bg.webp');
const svgFile = extracted.files.find((f) => f.file === 'assets/vector.svg');

if (
  heicFile.encoding !== 'base64' ||
  jpgFile.encoding !== 'base64' ||
  pngFile.encoding !== 'base64' ||
  webpFile.encoding !== 'base64' ||
  svgFile.encoding !== 'utf-8'
) {
  console.error('❌ Failed image format encoding assertions');
  process.exit(1);
}
console.log('✅ All image formats (.heic, .jpg, .png, .webp, .svg) verified with correct binary encodings!');

// 3. Test Nested Root ZIP Normalization (e.g. folder/index.html)
console.log('\n--- Test 3: Nested Parent Folder Normalization ---');
const nestedZip = new AdmZip();
nestedZip.addFile('my-website-v1/index.html', Buffer.from('<h1>Nested</h1>', 'utf-8'));
nestedZip.addFile('my-website-v1/style.css', Buffer.from('body{}', 'utf-8'));

const nestedExtracted = extractZipToVercelFiles(nestedZip.toBuffer());
console.log('Nested extracted files:', nestedExtracted.files.map((f) => f.file));

if (!nestedExtracted.hasIndexHtml || nestedExtracted.files[0].file !== 'index.html') {
  console.error('❌ Failed Nested ZIP normalization assertion');
  process.exit(1);
}
console.log('✅ Nested ZIP normalization test passed!');

// 4. Test Case-Insensitive INDEX.HTML Detection
console.log('\n--- Test 4: Uppercase INDEX.HTML & index.htm Detection ---');
const caseZip = new AdmZip();
caseZip.addFile('INDEX.HTML', Buffer.from('<h1>Uppercase Index</h1>', 'utf-8'));
caseZip.addFile('STYLE.CSS', Buffer.from('body{margin:0;}', 'utf-8'));

const caseExtracted = extractZipToVercelFiles(caseZip.toBuffer());
console.log('Case extracted files:', caseExtracted.files.map((f) => f.file));

if (!caseExtracted.hasIndexHtml || !caseExtracted.files.some((f) => f.file === 'index.html')) {
  console.error('❌ Failed Case-Insensitive INDEX.HTML assertion');
  process.exit(1);
}
console.log('✅ Case-Insensitive INDEX.HTML test passed!');

// 5. Test Serverless String / Buffer Body Parsing
console.log('\n--- Test 5: Serverless Request Body Parsing Simulation ---');
const samplePayload = {
  projectName: 'test-app-2026',
  zipBase64: zipBuffer.toString('base64'),
  envContent: 'API_KEY=12345'
};

// String payload simulation (as received in Vercel Serverless if raw)
const stringBody = JSON.stringify(samplePayload);
let parsedBody = typeof stringBody === 'string' ? JSON.parse(stringBody) : stringBody;
const cleanBase64 = parsedBody.zipBase64.includes(',') ? parsedBody.zipBase64.split(',')[1] : parsedBody.zipBase64;
const decodedBuffer = Buffer.from(cleanBase64, 'base64');
const serverlessExtract = extractZipToVercelFiles(decodedBuffer);

if (!serverlessExtract.hasIndexHtml || serverlessExtract.fileCount !== extracted.fileCount) {
  console.error('❌ Failed Serverless body parsing simulation assertion');
  process.exit(1);
}
console.log('✅ Serverless Request Body Parsing simulation test passed!');

console.log('\n🎉 ALL ZIP & .ENV TESTS PASSED SUCCESSFULLY (100%)!');
