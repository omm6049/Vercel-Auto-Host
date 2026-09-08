import { deployToVercel, sanitizeProjectName } from '../src/services/vercel.js';
import { deploymentHistory } from '../src/services/telegramBot.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const { projectName, htmlContent, cssContent, jsContent } = req.body || {};

    if (!htmlContent) {
      return res.status(400).json({
        success: false,
        error: 'index.html content is required.'
      });
    }

    const cleanName = sanitizeProjectName(projectName);

    const result = await deployToVercel({
      projectName: cleanName,
      htmlContent,
      cssContent,
      jsContent
    });

    const record = {
      id: result.deploymentId,
      projectName: result.projectName,
      canonicalUrl: result.canonicalUrl,
      directUrl: result.directUrl,
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
