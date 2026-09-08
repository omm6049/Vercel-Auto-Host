import axios from 'axios';
import { put } from '@vercel/blob';

/**
 * Sanitizes project name to comply with Vercel project and domain requirements.
 * Only lowercase alphanumeric characters and hyphens are allowed.
 */
export function sanitizeProjectName(name) {
  if (!name || typeof name !== 'string') return `site-${Date.now().toString(36)}`;
  
  let sanitized = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (!sanitized) {
    sanitized = `site-${Date.now().toString(36)}`;
  }
  
  // Vercel project names max length is around 100, recommended 3-50
  return sanitized.slice(0, 50);
}

/**
 * Ensures index.html properly references style.css and logic.js.
 * If links are missing, injects them seamlessly without breaking structure.
 */
export function ensureHtmlLinks(htmlContent) {
  let modified = htmlContent;

  // 1. Check & Inject style.css
  const hasCssLink = /<link[^>]+href=["'](?:\.\/)?style\.css["'][^>]*>/i.test(modified);
  if (!hasCssLink) {
    const cssTag = '\n    <link rel="stylesheet" href="style.css">';
    if (/<head[^>]*>/i.test(modified)) {
      modified = modified.replace(/(<head[^>]*>)/i, `$1${cssTag}`);
    } else if (/<html[^>]*>/i.test(modified)) {
      modified = modified.replace(/(<html[^>]*>)/i, `$1\n<head>${cssTag}\n</head>`);
    } else {
      modified = `<head>${cssTag}\n</head>\n` + modified;
    }
  }

  // 2. Check & Inject logic.js
  const hasJsScript = /<script[^>]+src=["'](?:\.\/)?logic\.js["'][^>]*>/i.test(modified);
  if (!hasJsScript) {
    const jsTag = '\n    <script src="logic.js"></script>';
    if (/<\/body>/i.test(modified)) {
      modified = modified.replace(/(<\/body>)/i, `${jsTag}\n$1`);
    } else if (/<\/html>/i.test(modified)) {
      modified = modified.replace(/(<\/html>)/i, `${jsTag}\n$1`);
    } else {
      modified = modified + `${jsTag}\n`;
    }
  }

  return modified;
}

/**
 * Uploads backup files to Vercel Blob storage if BLOB_READ_WRITE_TOKEN is provided.
 */
export async function uploadToVercelBlob(projectName, files) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    return null;
  }

  const blobResults = {};
  try {
    for (const [filename, content] of Object.entries(files)) {
      const pathname = `projects/${projectName}/${Date.now()}-${filename}`;
      const blob = await put(pathname, content, {
        access: 'public',
        token,
        contentType: filename.endsWith('.html') ? 'text/html' :
                     filename.endsWith('.css') ? 'text/css' :
                     'application/javascript'
      });
      blobResults[filename] = blob.url;
    }
    return blobResults;
  } catch (err) {
    console.warn('[Vercel Blob Warning]: Could not store blob backup:', err.message);
    return null;
  }
}

/**
 * Deploys index.html, style.css, and logic.js directly to Vercel using the Vercel REST Deployments API.
 */
export async function deployToVercel({ projectName, htmlContent, cssContent, jsContent }) {
  const vercelToken = process.env.VERCEL_TOKEN;
  if (!vercelToken) {
    throw new Error('VERCEL_TOKEN is not configured in .env file. Please add your Vercel personal access token.');
  }

  const cleanName = sanitizeProjectName(projectName);
  const finalHtml = ensureHtmlLinks(htmlContent);
  const finalCss = cssContent || '/* Auto-generated style */\nbody { font-family: sans-serif; }';
  const finalJs = jsContent || '// Auto-generated script\nconsole.log("Website initialized.");';

  // Attempt Blob backup in background
  uploadToVercelBlob(cleanName, {
    'index.html': finalHtml,
    'style.css': finalCss,
    'logic.js': finalJs
  }).catch(() => {});

  // Build deployment files array for Vercel API v13
  const files = [
    {
      file: 'index.html',
      data: Buffer.from(finalHtml, 'utf-8').toString('utf-8'),
      encoding: 'utf-8'
    },
    {
      file: 'style.css',
      data: Buffer.from(finalCss, 'utf-8').toString('utf-8'),
      encoding: 'utf-8'
    },
    {
      file: 'logic.js',
      data: Buffer.from(finalJs, 'utf-8').toString('utf-8'),
      encoding: 'utf-8'
    }
  ];

  const teamId = process.env.VERCEL_TEAM_ID;
  const queryParams = teamId ? `?teamId=${teamId}` : '';
  const endpoint = `https://api.vercel.com/v13/deployments${queryParams}`;

  const payload = {
    name: cleanName,
    files,
    projectSettings: {
      framework: null
    },
    target: 'production'
  };

  try {
    const response = await axios.post(endpoint, payload, {
      headers: {
        Authorization: `Bearer ${vercelToken}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    const deployment = response.data;
    const directDeploymentUrl = `https://${deployment.url}`;
    const canonicalAppUrl = `https://${cleanName}.vercel.app`;

    return {
      success: true,
      projectName: cleanName,
      deploymentId: deployment.id,
      state: deployment.readyState || deployment.status || 'READY',
      canonicalUrl: canonicalAppUrl,
      directUrl: directDeploymentUrl,
      alias: deployment.alias || [cleanName + '.vercel.app'],
      createdAt: deployment.createdAt || Date.now()
    };
  } catch (error) {
    const errorDetails = error.response?.data?.error?.message || error.response?.data?.message || error.message;
    console.error('[Vercel Deploy Error]:', errorDetails);
    throw new Error(`Vercel deployment failed: ${errorDetails}`);
  }
}

/**
 * Validates whether the Vercel API credentials are operational.
 */
export async function verifyVercelCredentials() {
  const token = process.env.VERCEL_TOKEN;
  if (!token) return { valid: false, reason: 'VERCEL_TOKEN missing' };

  try {
    const res = await axios.get('https://api.vercel.com/v2/user', {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 5000
    });
    return { valid: true, user: res.data.user?.username || res.data.user?.email || 'Authenticated User' };
  } catch (err) {
    return { valid: false, reason: err.response?.data?.error?.message || err.message };
  }
}
