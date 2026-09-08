import { deployToVercel, sanitizeProjectName } from '../src/services/vercel.js';
import { deploymentHistory } from '../src/services/telegramBot.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    let body = req.body;

    // Handle body passed as string or Buffer in serverless environments
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch (e) {
        console.warn('Failed to parse body string:', e.message);
      }
    } else if (Buffer.isBuffer(body)) {
      try {
        body = JSON.parse(body.toString('utf-8'));
      } catch (e) {
        console.warn('Failed to parse body buffer:', e.message);
      }
    }

    // Handle stream if body was not parsed by serverless runtime
    if (!body || (typeof body === 'object' && Object.keys(body).length === 0)) {
      try {
        const buffers = [];
        for await (const chunk of req) {
          buffers.push(chunk);
        }
        if (buffers.length > 0) {
          const raw = Buffer.concat(buffers).toString('utf-8');
          body = JSON.parse(raw);
        }
      } catch (streamErr) {
        console.warn('Stream read fallback note:', streamErr.message);
      }
    }

    body = body || {};

    const {
      projectName,
      htmlContent,
      cssContent,
      jsContent,
      zipBase64,
      files,
      envContent,
      envVariables
    } = body;

    let zipBuffer = null;
    if (zipBase64) {
      const cleanBase64 = typeof zipBase64 === 'string' && zipBase64.includes(',')
        ? zipBase64.split(',')[1]
        : zipBase64;
      zipBuffer = Buffer.from(cleanBase64, 'base64');
    }

    if (!zipBuffer && !htmlContent && !files) {
      return res.status(400).json({
        success: false,
        error: 'Either a .ZIP file or index.html content is required.'
      });
    }

    const cleanName = sanitizeProjectName(projectName || `site-${Date.now().toString(36)}`);

    const result = await deployToVercel({
      projectName: cleanName,
      zipBuffer,
      files,
      htmlContent,
      cssContent,
      jsContent,
      envContent,
      envVariables
    });

    const record = {
      id: result.deploymentId,
      projectName: result.projectName,
      canonicalUrl: result.canonicalUrl,
      directUrl: result.directUrl,
      fileCount: result.fileCount,
      envCount: result.envCount,
      createdAt: result.createdAt,
      source: 'Web Dashboard (Vercel Serverless)'
    };
    deploymentHistory.push(record);

    return res.status(200).json({
      success: true,
      deployment: result
    });
  } catch (error) {
    console.error('[Deploy API Error]:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message || 'Deployment failed.'
    });
  }
}
