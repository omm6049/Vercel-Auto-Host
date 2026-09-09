import axios from 'axios';
import { put } from '@vercel/blob';
import AdmZip from 'adm-zip';

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
 * Parses .env file content or key-value strings into an object.
 */
export function parseEnvFileContent(envContent) {
  if (!envContent) return {};
  if (typeof envContent === 'object' && !Array.isArray(envContent)) {
    return envContent;
  }

  const envVars = {};
  const lines = envContent.toString().split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex > 0) {
      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();

      // Remove surrounding quotes if present
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      if (key) {
        envVars[key] = value;
      }
    }
  }

  return envVars;
}

/**
 * Ensures a Vercel project exists and is configured for public access (disables SSO / Password protection).
 */
export async function ensurePublicVercelProject(projectName) {
  const token = process.env.VERCEL_TOKEN;
  if (!token || !projectName) return null;

  const teamId = process.env.VERCEL_TEAM_ID;
  const queryParams = teamId ? `?teamId=${teamId}` : '';
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json'
  };

  try {
    // 1. Check if project already exists
    const res = await axios.get(`https://api.vercel.com/v9/projects/${projectName}${queryParams}`, { headers, timeout: 5000 });
    
    // Disable protection if currently on
    if (res.data?.ssoProtection) {
      try {
        await axios.patch(
          `https://api.vercel.com/v9/projects/${projectName}${queryParams}`,
          {
            ssoProtection: null
          },
          { headers, timeout: 5000 }
        );
      } catch (patchErr) {
        console.warn(`[Vercel Project Patch Notice]:`, patchErr.message);
      }
    }
    return res.data;
  } catch (err) {
    if (err.response?.status === 404) {
      // 2. Create project with public settings
      try {
        const createRes = await axios.post(
          `https://api.vercel.com/v9/projects${queryParams}`,
          {
            name: projectName,
            framework: null,
            ssoProtection: null
          },
          { headers, timeout: 10000 }
        );
        return createRes.data;
      } catch (createErr) {
        console.warn(`[Vercel Project Create Notice]:`, createErr.response?.data?.error?.message || createErr.message);
      }
    }
  }
  return null;
}

/**
 * Sets environment variables for a Vercel project using Vercel REST API.
 */
export async function setVercelEnvironmentVariables(projectName, envVars) {
  const token = process.env.VERCEL_TOKEN;
  if (!token || !envVars || Object.keys(envVars).length === 0) {
    return { success: true, count: 0 };
  }

  const teamId = process.env.VERCEL_TEAM_ID;
  const queryParams = teamId ? `?teamId=${teamId}` : '';
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json'
  };

  // 1. Ensure project exists and is public
  await ensurePublicVercelProject(projectName);

  // 2. Add each environment variable to the project
  let addedCount = 0;
  for (const [key, value] of Object.entries(envVars)) {
    try {
      await axios.post(
        `https://api.vercel.com/v10/projects/${projectName}/env${queryParams}`,
        {
          key,
          value: String(value),
          type: 'plain',
          target: ['production', 'preview', 'development']
        },
        { headers, timeout: 10000 }
      );
      addedCount++;
    } catch (envErr) {
      // If variable already exists or has collision, ignore or log notice
      const errorMsg = envErr.response?.data?.error?.message || envErr.message;
      console.warn(`[Vercel Env Notice for ${key}]:`, errorMsg);
    }
  }

  return { success: true, count: addedCount };
}

/**
 * Extracts a ZIP buffer in-memory and prepares files for Vercel Deployments API v13.
 * Preserves directory structure and handles both text and binary files.
 */
export function extractZipToVercelFiles(zipBuffer) {
  const zip = new AdmZip(zipBuffer);
  const zipEntries = zip.getEntries();
  const rawFiles = [];

  const textExtensions = new Set([
    'html', 'htm', 'css', 'js', 'mjs', 'jsx', 'ts', 'tsx',
    'json', 'svg', 'txt', 'md', 'xml', 'csv', 'yaml', 'yml', 'env'
  ]);

  for (const entry of zipEntries) {
    if (entry.isDirectory) continue;

    let entryName = entry.entryName.replace(/\\/g, '/');

    // Skip OS metadata / hidden files / thumbs
    if (
      entryName.startsWith('__MACOSX/') ||
      entryName.includes('/.DS_Store') ||
      entryName.startsWith('.DS_Store') ||
      entryName.endsWith('Thumbs.db')
    ) {
      continue;
    }

    // Strip leading slashes
    entryName = entryName.replace(/^\/+/, '');
    if (!entryName) continue;

    const ext = entryName.split('.').pop()?.toLowerCase() || '';
    const isText = textExtensions.has(ext);

    if (isText) {
      const textContent = entry.getData().toString('utf-8');
      rawFiles.push({
        file: entryName,
        data: textContent,
        encoding: 'utf-8'
      });
    } else {
      // Base64 encoding for images (JPG, PNG, HEIC, WEBP, GIF, etc.) and other binaries
      const base64Content = entry.getData().toString('base64');
      rawFiles.push({
        file: entryName,
        data: base64Content,
        encoding: 'base64'
      });
    }
  }

  // Check if index.html is directly at root (case-insensitive)
  let normalizedFiles = rawFiles;
  let hasDirectIndex = normalizedFiles.some((f) => f.file.toLowerCase() === 'index.html' || f.file.toLowerCase() === 'index.htm');

  // If no root index.html, check if all files share a common folder OR if index.html is in a known subfolder
  if (!hasDirectIndex && normalizedFiles.length > 0) {
    // 1. Check if all files share a common parent folder
    const firstSlashIndex = normalizedFiles[0].file.indexOf('/');
    if (firstSlashIndex !== -1) {
      const potentialRoot = normalizedFiles[0].file.substring(0, firstSlashIndex);
      const allShareRoot = normalizedFiles.every((f) => f.file.startsWith(potentialRoot + '/'));

      if (allShareRoot) {
        normalizedFiles = normalizedFiles.map((f) => ({
          ...f,
          file: f.file.substring(potentialRoot.length + 1)
        }));
        hasDirectIndex = normalizedFiles.some((f) => f.file.toLowerCase() === 'index.html' || f.file.toLowerCase() === 'index.htm');
      }
    }

    // 2. If still not found at root, find if there's an index.html in a subfolder (like dist/ or public/ or custom-folder/)
    if (!hasDirectIndex) {
      const nestedIndexFile = normalizedFiles.find((f) => f.file.toLowerCase().endsWith('/index.html') || f.file.toLowerCase().endsWith('/index.htm'));
      if (nestedIndexFile) {
        const lastSlash = nestedIndexFile.file.lastIndexOf('/');
        const folderPrefix = nestedIndexFile.file.substring(0, lastSlash + 1);
        
        // Check if other files also reside in that same folder prefix
        const folderFiles = normalizedFiles.filter((f) => f.file.startsWith(folderPrefix));
        if (folderFiles.length >= normalizedFiles.length * 0.7) {
          // Re-base files to this folder
          normalizedFiles = normalizedFiles.map((f) => {
            if (f.file.startsWith(folderPrefix)) {
              return { ...f, file: f.file.substring(folderPrefix.length) };
            }
            return f;
          });
          hasDirectIndex = true;
        }
      }
    }
  }

  // Normalize root index.html to lowercase 'index.html' so Vercel Edge CDN serves it cleanly
  normalizedFiles = normalizedFiles.map((f) => {
    if (f.file.toLowerCase() === 'index.html' || f.file.toLowerCase() === 'index.htm') {
      return { ...f, file: 'index.html' };
    }
    return f;
  });

  const finalHasIndex = normalizedFiles.some((f) => f.file === 'index.html');

  return {
    files: normalizedFiles,
    hasIndexHtml: finalHasIndex,
    fileCount: normalizedFiles.length
  };
}

/**
 * Ensures index.html properly references style.css and logic.js.
 * If links are missing, injects them seamlessly without breaking structure.
 */
export function ensureHtmlLinks(htmlContent) {
  let modified = htmlContent;

  // 1. Check & Inject Responsive Viewport Meta Tag for Mobile/Tablet/PC compatibility
  const hasViewport = /<meta[^>]+name=["']viewport["'][^>]*>/i.test(modified);
  if (!hasViewport) {
    const viewportTag = '\n    <meta name="viewport" content="width=device-width, initial-scale=1.0">';
    if (/<head[^>]*>/i.test(modified)) {
      modified = modified.replace(/(<head[^>]*>)/i, `$1${viewportTag}`);
    } else if (/<html[^>]*>/i.test(modified)) {
      modified = modified.replace(/(<html[^>]*>)/i, `$1\n<head>${viewportTag}\n</head>`);
    } else {
      modified = `<head>${viewportTag}\n</head>\n` + modified;
    }
  }

  // 2. Check & Inject style.css
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

  // 3. Check & Inject logic.js
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
      let blob;
      try {
        blob = await put(pathname, content, {
          access: 'public',
          token,
          contentType: filename.endsWith('.html') ? 'text/html' :
                       filename.endsWith('.css') ? 'text/css' :
                       'application/javascript'
        });
      } catch (pubErr) {
        // Fallback for private stores
        blob = await put(pathname, content, {
          token,
          contentType: filename.endsWith('.html') ? 'text/html' :
                       filename.endsWith('.css') ? 'text/css' :
                       'application/javascript'
        });
      }
      blobResults[filename] = blob?.url || null;
    }
    return blobResults;
  } catch (err) {
    // Blob backup is optional, do not block deployment
    return null;
  }
}

/**
 * Deploys files directly to Vercel using the Vercel REST Deployments API.
 * Supports:
 * - Direct ZIP extraction (via zipBuffer)
 * - Array of pre-extracted files ({ file, data, encoding })
 * - Classic 3-file mode (htmlContent, cssContent, jsContent)
 * - Automatic .env configuration via Vercel Environment API
 */
export async function deployToVercel({
  projectName,
  htmlContent,
  cssContent,
  jsContent,
  files = null,
  zipBuffer = null,
  envVariables = null,
  envContent = null
}) {
  const vercelToken = process.env.VERCEL_TOKEN;
  if (!vercelToken) {
    throw new Error('VERCEL_TOKEN is not configured in .env file. Please add your Vercel personal access token.');
  }

  const cleanName = sanitizeProjectName(projectName);

  // 1. Process and set Environment Variables if provided
  const parsedEnv = {
    ...(envVariables || {}),
    ...(envContent ? parseEnvFileContent(envContent) : {})
  };

  if (Object.keys(parsedEnv).length > 0) {
    await setVercelEnvironmentVariables(cleanName, parsedEnv);
  }

  // 2. Assemble deployment files array
  let deploymentFiles = [];

  if (zipBuffer) {
    const zipResult = extractZipToVercelFiles(zipBuffer);
    if (!zipResult.hasIndexHtml) {
      throw new Error('The uploaded ZIP archive must contain an index.html file.');
    }
    deploymentFiles = zipResult.files;
  } else if (Array.isArray(files) && files.length > 0) {
    deploymentFiles = files;
  } else {
    // Classic 3-File Mode
    const finalHtml = ensureHtmlLinks(htmlContent || '<h1>Website</h1>');
    const finalCss = cssContent || '/* Auto-generated style */\nbody { font-family: sans-serif; }';
    const finalJs = jsContent || '// Auto-generated script\nconsole.log("Website initialized.");';

    // Attempt Blob backup in background
    uploadToVercelBlob(cleanName, {
      'index.html': finalHtml,
      'style.css': finalCss,
      'logic.js': finalJs
    }).catch(() => {});

    deploymentFiles = [
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
  }

  const teamId = process.env.VERCEL_TEAM_ID;
  const queryParams = teamId ? `?teamId=${teamId}` : '';
  const endpoint = `https://api.vercel.com/v13/deployments${queryParams}`;

  // Ensure project exists with public settings (SSO / Password protection disabled)
  await ensurePublicVercelProject(cleanName);

  const payload = {
    name: cleanName,
    files: deploymentFiles,
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
      timeout: 45000
    });

    const deployment = response.data;
    let finalDeployment = deployment;

    // Poll until deployment is READY (or timeout after 20s) so Vercel edge routers have fully provisioned the site
    const pollStart = Date.now();
    const maxPollMs = 20000;
    while (Date.now() - pollStart < maxPollMs) {
      if (finalDeployment.readyState === 'READY') {
        break;
      }
      if (finalDeployment.readyState === 'ERROR' || finalDeployment.readyState === 'CANCELED') {
        const errMsg = finalDeployment.error?.message || `Deployment ended in state ${finalDeployment.readyState}`;
        throw new Error(errMsg);
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
      try {
        const pollRes = await axios.get(
          `https://api.vercel.com/v13/deployments/${deployment.id}${queryParams}`,
          {
            headers: { Authorization: `Bearer ${vercelToken}` },
            timeout: 8000
          }
        );
        finalDeployment = pollRes.data;
      } catch (pollErr) {
        // If a single poll request fails due to network jitter, retry next tick
      }
    }

    // Production canonical URL: https://<cleanName>.vercel.app
    const canonicalAppUrl = `https://${cleanName}.vercel.app`;
    const directDeploymentUrl = finalDeployment.url ? `https://${finalDeployment.url}` : canonicalAppUrl;

    // Verify CDN edge propagation so the link is immediately live without 404 DEPLOYMENT_NOT_FOUND
    const verifyStart = Date.now();
    const maxVerifyMs = 8000;
    while (Date.now() - verifyStart < maxVerifyMs) {
      try {
        const checkRes = await axios.get(canonicalAppUrl, {
          timeout: 2500,
          validateStatus: (status) => status < 500
        });
        if (checkRes.status === 200) {
          break;
        }
      } catch (checkErr) {
        // Continue waiting for edge CDN propagation
      }
      await new Promise((resolve) => setTimeout(resolve, 600));
    }

    const aliases = Array.isArray(finalDeployment.alias) && finalDeployment.alias.length > 0
      ? finalDeployment.alias
      : [`${cleanName}.vercel.app`];

    return {
      success: true,
      projectName: cleanName,
      deploymentId: finalDeployment.id,
      state: finalDeployment.readyState || 'READY',
      canonicalUrl: canonicalAppUrl,
      directUrl: directDeploymentUrl,
      alias: aliases,
      fileCount: deploymentFiles.length,
      envCount: Object.keys(parsedEnv).length,
      createdAt: finalDeployment.createdAt || Date.now()
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

