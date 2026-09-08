/**
 * Vercel Auto Host - Launchpad Cockpit Client Logic
 */

// Application State
const appState = {
  uploadMode: 'ZIP', // 'ZIP' or 'CLASSIC'
  zipFile: null,
  envContent: '',
  htmlFile: null,
  htmlContent: '',
  cssFile: null,
  cssContent: '',
  jsFile: null,
  jsContent: ''
};

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  if (window.lucide) {
    window.lucide.createIcons();
  }

  initAuthGate();
  initStatusPolling();
  initModeSwitcher();
  initDropzones();
  initEnvSection();
  initFormHandler();
  initSampleLoader();
  initViewportSwitcher();
  initModals();
});

/**
 * Toast Notification Utility
 */
function showToast(message, isError = false) {
  const toast = document.getElementById('toastNotification');
  const toastMsg = document.getElementById('toastMessage');
  if (!toast || !toastMsg) return;

  toastMsg.textContent = message;
  toast.classList.remove('hidden');
  if (isError) {
    toast.style.borderColor = 'rgba(244, 63, 94, 0.5)';
  } else {
    toast.style.borderColor = 'rgba(16, 185, 129, 0.5)';
  }

  setTimeout(() => {
    toast.classList.add('hidden');
  }, 4000);
}

/**
 * Polls backend API for system status
 */
async function initStatusPolling() {
  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/status');
      if (!res.ok) return;
      const data = await res.json();

      const vercelText = document.getElementById('vercelStatusText');
      if (vercelText) {
        if (data.vercel?.authenticated) {
          vercelText.textContent = `Connected (${data.vercel.user || 'Ready'})`;
        } else if (data.vercel?.configured) {
          vercelText.textContent = 'Invalid Vercel Token';
        } else {
          vercelText.textContent = 'Awaiting Token in .env';
        }
      }
    } catch (err) {
      console.warn('Status notice:', err.message);
    }
  };

  fetchStatus();
  setInterval(fetchStatus, 10000);
}

/**
 * Formats file size in readable format
 */
function formatBytes(bytes, decimals = 1) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

/**
 * Handles Tab Switching between ZIP mode and Classic 3-file mode
 */
function initModeSwitcher() {
  const tabZip = document.getElementById('tabZipMode');
  const tabClassic = document.getElementById('tabClassicMode');
  const zipSection = document.getElementById('zipUploadSection');
  const classicSection = document.getElementById('classicUploadSection');

  if (!tabZip || !tabClassic) return;

  tabZip.addEventListener('click', () => {
    appState.uploadMode = 'ZIP';
    tabZip.classList.add('active');
    tabClassic.classList.remove('active');
    zipSection.classList.remove('hidden');
    classicSection.classList.add('hidden');
  });

  tabClassic.addEventListener('click', () => {
    appState.uploadMode = 'CLASSIC';
    tabClassic.classList.add('active');
    tabZip.classList.remove('active');
    classicSection.classList.remove('hidden');
    zipSection.classList.add('hidden');
  });
}

/**
 * Handles Environment Variables (.env) drawer & file upload
 */
function initEnvSection() {
  const header = document.getElementById('envToggleHeader');
  const container = document.getElementById('envInputContainer');
  const textarea = document.getElementById('envTextInput');
  const envFileInput = document.getElementById('envFileInput');
  const summary = document.getElementById('envStatusSummary');

  if (!header || !container) return;

  header.addEventListener('click', () => {
    container.classList.toggle('hidden');
  });

  if (textarea) {
    textarea.addEventListener('input', () => {
      appState.envContent = textarea.value;
      const lines = textarea.value.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes('='));
      summary.textContent = lines.length > 0 ? `${lines.length} variable${lines.length === 1 ? '' : 's'} set` : 'Click to configure';
    });
  }

  if (envFileInput) {
    envFileInput.addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        const file = e.target.files[0];
        const reader = new FileReader();
        reader.onload = (evt) => {
          appState.envContent = evt.target.result;
          if (textarea) textarea.value = evt.target.result;
          const lines = evt.target.result.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes('='));
          summary.textContent = `${lines.length} variable${lines.length === 1 ? '' : 's'} loaded from ${file.name}`;
          showToast(`Loaded ${file.name} successfully!`);
          container.classList.remove('hidden');
        };
        reader.readAsText(file);
      }
    });
  }
}

/**
 * Sets up drag & drop functionality for ZIP and individual slots
 */
function initDropzones() {
  // ZIP Dropzone Setup
  const zipDropzone = document.getElementById('zipDropzone');
  const zipInput = document.getElementById('zipFileInput');
  const zipName = document.getElementById('zipFileName');
  const zipSize = document.getElementById('zipFileSize');
  const zipBar = document.getElementById('zipProgressBar');

  if (zipDropzone && zipInput) {
    const handleZip = (file) => {
      if (!file) return;
      const isZip = file.name.toLowerCase().endsWith('.zip') ||
                    file.type === 'application/zip' ||
                    file.type === 'application/x-zip-compressed' ||
                    file.type === 'multipart/x-zip' ||
                    file.type === 'application/octet-stream';
      
      if (!isZip) {
        showToast('Please upload a .ZIP archive file.', true);
        return;
      }

      zipBar.style.width = '100%';
      appState.zipFile = file;
      zipDropzone.classList.add('file-loaded');
      zipName.textContent = file.name;
      zipSize.textContent = `${formatBytes(file.size)} • ZIP Archive ready for auto-extraction`;

      // Auto-suggest project name from zip filename if empty
      const nameInput = document.getElementById('projectNameInput');
      if (nameInput && !nameInput.value.trim()) {
        const baseName = file.name.replace(/\.[^/.]+$/, '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 30);
        if (baseName) {
          nameInput.value = baseName;
        }
      }

      showToast(`Loaded "${file.name}" successfully!`);
    };

    zipInput.addEventListener('change', (e) => {
      if (e.target.files.length > 0) handleZip(e.target.files[0]);
    });

    zipDropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      zipDropzone.classList.add('dragover');
    });
    zipDropzone.addEventListener('dragleave', () => {
      zipDropzone.classList.remove('dragover');
    });
    zipDropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      zipDropzone.classList.remove('dragover');
      if (e.dataTransfer.files.length > 0) handleZip(e.dataTransfer.files[0]);
    });
  }

  // Individual Slots Setup
  const setupDropzone = (dropzoneId, inputId, nameId, sizeId, barId, type) => {
    const dropzone = document.getElementById(dropzoneId);
    const input = document.getElementById(inputId);
    const nameLabel = document.getElementById(nameId);
    const sizeLabel = document.getElementById(sizeId);
    const progressBar = document.getElementById(barId);

    if (!dropzone || !input) return;

    const handleFile = (file) => {
      if (!file) return;

      const reader = new FileReader();
      reader.onloadstart = () => {
        progressBar.style.width = '20%';
      };
      reader.onprogress = (e) => {
        if (e.lengthComputable) {
          const percent = (e.loaded / e.total) * 100;
          progressBar.style.width = `${percent}%`;
        }
      };
      reader.onload = (e) => {
        progressBar.style.width = '100%';
        const content = e.target.result;

        if (type === 'html') {
          appState.htmlFile = file;
          appState.htmlContent = content;
        } else if (type === 'css') {
          appState.cssFile = file;
          appState.cssContent = content;
        } else if (type === 'js') {
          appState.jsFile = file;
          appState.jsContent = content;
        }

        dropzone.classList.add('file-loaded');
        nameLabel.textContent = file.name;
        sizeLabel.textContent = `${formatBytes(file.size)} • Ready for deployment`;
        showToast(`Loaded ${file.name} successfully!`);
      };
      reader.readAsText(file);
    };

    input.addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        handleFile(e.target.files[0]);
      }
    });

    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    });

    dropzone.addEventListener('dragleave', () => {
      dropzone.classList.remove('dragleave');
    });

    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragleave');
      if (e.dataTransfer.files.length > 0) {
        handleFile(e.dataTransfer.files[0]);
      }
    });
  };

  setupDropzone('htmlDropzone', 'htmlFileInput', 'htmlFileName', 'htmlFileSize', 'htmlProgressBar', 'html');
  setupDropzone('cssDropzone', 'cssFileInput', 'cssFileName', 'cssFileSize', 'cssProgressBar', 'css');
  setupDropzone('jsDropzone', 'jsFileInput', 'jsFileName', 'jsFileSize', 'jsProgressBar', 'js');
}

/**
 * Loads pre-built sample demo project into the form
 */
function initSampleLoader() {
  const loadBtn = document.getElementById('loadSampleBtn');
  if (!loadBtn) return;

  loadBtn.addEventListener('click', async () => {
    try {
      loadBtn.disabled = true;
      loadBtn.innerHTML = '<i data-lucide="loader-2" class="spin"></i> Loading...';

      // Switch to Classic mode to show populated files
      const tabClassic = document.getElementById('tabClassicMode');
      if (tabClassic) tabClassic.click();

      // Sample HTML
      const sampleHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Vercel Auto Host Live Demo</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="badge">🚀 Deployed via Vercel Auto Host</div>
      <h1>Hello from <span class="highlight">Vercel Auto Host</span>!</h1>
      <p>This website was automatically packaged from index.html, style.css, and logic.js with Vercel Global Edge CDN & Environment Variables support!</p>
      <div class="counter-box">
        <button id="counterBtn" class="btn">⚡ Click Me (JS Interactivity)</button>
        <span id="counterVal">0</span> clicks
      </div>
    </div>
  </div>
  <script src="logic.js"></script>
</body>
</html>`;

      // Sample CSS (Fully Responsive across Mobile, Tablet, and PC)
      const sampleCss = `* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
  background: radial-gradient(circle at center, #1e1b4b, #0f172a);
  color: #f8fafc;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: clamp(16px, 4vw, 32px);
  -webkit-font-smoothing: antialiased;
}
.container { width: 100%; max-width: 520px; }
.card {
  background: rgba(30, 41, 59, 0.78);
  backdrop-filter: blur(16px);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: clamp(16px, 3vw, 24px);
  padding: clamp(20px, 5vw, 36px);
  text-align: center;
  box-shadow: 0 20px 40px rgba(0,0,0,0.45);
}
.badge {
  display: inline-block;
  background: rgba(99, 102, 241, 0.2);
  color: #a5b4fc;
  padding: 5px 14px;
  border-radius: 100px;
  font-size: clamp(0.72rem, 2vw, 0.8rem);
  font-weight: 600;
  margin-bottom: 16px;
}
h1 { font-size: clamp(1.5rem, 4vw, 2.1rem); margin-bottom: 12px; line-height: 1.25; }
.highlight {
  background: linear-gradient(135deg, #6366f1, #ec4899);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}
p { color: #94a3b8; font-size: clamp(0.85rem, 2.2vw, 0.96rem); line-height: 1.6; margin-bottom: 24px; }
.counter-box { display: flex; align-items: center; justify-content: center; gap: 12px; flex-wrap: wrap; }
.btn {
  background: linear-gradient(135deg, #6366f1, #ec4899);
  color: #fff;
  border: none;
  padding: 12px 22px;
  border-radius: 12px;
  font-weight: 600;
  font-size: clamp(0.85rem, 2vw, 0.95rem);
  cursor: pointer;
  transition: transform 0.2s, box-shadow 0.2s;
  box-shadow: 0 4px 15px rgba(99, 102, 241, 0.4);
}
.btn:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(99, 102, 241, 0.6); }
.btn:active { transform: translateY(0); }
#counterVal { font-size: clamp(1.2rem, 3vw, 1.5rem); font-weight: bold; color: #38bdf8; }`;

      // Sample JS
      const sampleJs = `let count = 0;
const btn = document.getElementById('counterBtn');
const val = document.getElementById('counterVal');
if (btn && val) {
  btn.addEventListener('click', () => {
    count++;
    val.textContent = count;
    val.style.transform = 'scale(1.2)';
    setTimeout(() => { val.style.transform = 'scale(1)'; }, 150);
  });
}
console.log('✅ logic.js executing seamlessly on Vercel deployment!');`;

      appState.htmlContent = sampleHtml;
      appState.cssContent = sampleCss;
      appState.jsContent = sampleJs;

      // Update UI
      document.getElementById('htmlDropzone')?.classList.add('file-loaded');
      document.getElementById('htmlFileName').textContent = 'index.html (Sample Demo)';
      document.getElementById('htmlFileSize').textContent = `${formatBytes(sampleHtml.length)} • Ready`;
      document.getElementById('htmlProgressBar').style.width = '100%';

      document.getElementById('cssDropzone')?.classList.add('file-loaded');
      document.getElementById('cssFileName').textContent = 'style.css (Sample Demo)';
      document.getElementById('cssFileSize').textContent = `${formatBytes(sampleCss.length)} • Ready`;
      document.getElementById('cssProgressBar').style.width = '100%';

      document.getElementById('jsDropzone')?.classList.add('file-loaded');
      document.getElementById('jsFileName').textContent = 'logic.js (Sample Demo)';
      document.getElementById('jsFileSize').textContent = `${formatBytes(sampleJs.length)} • Ready`;
      document.getElementById('jsProgressBar').style.width = '100%';

      const randomSuffix = Math.random().toString(36).substring(2, 6);
      document.getElementById('projectNameInput').value = `showcase-app-${randomSuffix}`;

      showToast('Loaded demo sample files into all slots!');
    } catch (err) {
      showToast('Failed to load sample files', true);
    } finally {
      loadBtn.disabled = false;
      loadBtn.innerHTML = '<i data-lucide="wand-2"></i> Load Demo Sample';
      if (window.lucide) window.lucide.createIcons();
    }
  });
}

/**
 * Desktop / Mobile Viewport Switcher for the Live Frame
 */
function initViewportSwitcher() {
  const desktopBtn = document.getElementById('viewDesktopBtn');
  const mobileBtn = document.getElementById('viewMobileBtn');
  const container = document.getElementById('viewportContainer');

  if (!desktopBtn || !mobileBtn || !container) return;

  desktopBtn.addEventListener('click', () => {
    desktopBtn.classList.add('active');
    mobileBtn.classList.remove('active');
    container.classList.remove('mobile-view');
  });

  mobileBtn.addEventListener('click', () => {
    mobileBtn.classList.add('active');
    desktopBtn.classList.remove('active');
    container.classList.add('mobile-view');
  });
}

/**
 * Web Deployment Form Handler & Animated Output Stream
 */
function initFormHandler() {
  const form = document.getElementById('deploymentForm');
  const submitBtn = document.getElementById('deploySubmitBtn');
  const stateIdle = document.getElementById('stateIdle');
  const stateDeploying = document.getElementById('stateDeploying');
  const stateSuccess = document.getElementById('stateSuccess');
  const terminalLogs = document.getElementById('terminalLogs');
  const radarProgressBar = document.getElementById('radarProgressBar');
  const deployStatusText = document.getElementById('deployStatusText');
  const deployPercentText = document.getElementById('deployPercentText');
  const livePreviewFrame = document.getElementById('livePreviewFrame');
  const deployAnotherBtn = document.getElementById('deployAnotherBtn');

  if (!form) return;

  const appendLog = (msg, isSuccess = false) => {
    if (!terminalLogs) return;
    const now = new Date();
    const timeStr = `[${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}]`;
    const logLine = document.createElement('div');
    logLine.className = 'log-line';
    logLine.innerHTML = `<span class="log-ts">${timeStr}</span> <span class="${isSuccess ? 'log-success' : 'log-info'}">${msg}</span>`;
    terminalLogs.appendChild(logLine);
    terminalLogs.scrollTop = terminalLogs.scrollHeight;
  };

  const updateRadarProgress = (percent, status) => {
    if (radarProgressBar) radarProgressBar.style.width = `${percent}%`;
    if (deployPercentText) deployPercentText.textContent = `${percent}%`;
    if (deployStatusText) deployStatusText.textContent = status;
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const projectNameInput = document.getElementById('projectNameInput');
    let projectName = projectNameInput ? projectNameInput.value.trim() : '';
    if (!projectName) {
      projectName = `site-${Math.random().toString(36).substring(2, 7)}`;
    }

    const zipInputEl = document.getElementById('zipFileInput');
    const htmlInputEl = document.getElementById('htmlFileInput');

    const zipFile = appState.zipFile || zipInputEl?.files?.[0];
    let htmlContent = appState.htmlContent;
    if (!htmlContent && htmlInputEl?.files?.[0]) {
      try {
        htmlContent = await htmlInputEl.files[0].text();
      } catch {}
    }

    if (!zipFile && !htmlContent) {
      showToast('Please select or drop your .ZIP project archive (or index.html) first.', true);
      return;
    }

    // Switch Radar to Deploying State
    submitBtn.disabled = true;
    stateIdle.classList.add('hidden');
    stateSuccess.classList.add('hidden');
    stateDeploying.classList.remove('hidden');

    if (terminalLogs) terminalLogs.innerHTML = '';
    appendLog('Initializing build pipeline & verifying source assets...');
    updateRadarProgress(20, 'Preparing files...');

    try {
      let zipBase64 = null;
      if (zipFile) {
        appendLog(`Reading archive "${zipFile.name}" (${formatBytes(zipFile.size)})...`);
        zipBase64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const res = reader.result;
            const b64 = typeof res === 'string' && res.includes(',') ? res.split(',')[1] : res;
            resolve(b64);
          };
          reader.onerror = reject;
          reader.readAsDataURL(zipFile);
        });
        appendLog('Extracted archive into in-memory file pipeline ✅');
      }

      updateRadarProgress(45, 'Configuring environment...');
      const envText = appState.envContent || document.getElementById('envTextInput')?.value || '';
      if (envText.trim()) {
        appendLog('Synchronizing .env variables with Vercel Project Environment...');
      }

      updateRadarProgress(65, 'Deploying to Vercel Edge...');
      appendLog(`Sending deployment payload for "${projectName}" to Vercel API v13...`);

      const payload = {
        projectName,
        envContent: envText,
        zipBase64,
        htmlContent: !zipFile ? htmlContent : '',
        cssContent: !zipFile ? appState.cssContent : '',
        jsContent: !zipFile ? appState.jsContent : ''
      };

      const response = await fetch('/api/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Deployment failed');
      }

      updateRadarProgress(100, 'Deployment Complete!');
      appendLog('Edge distribution complete! SSL Certificate active ✅', true);
      appendLog(`Assigned canonical alias: ${data.deployment.canonicalUrl} 🚀`, true);

      // Transition to Success state with Congratulations and Dual Links
      setTimeout(() => {
        stateDeploying.classList.add('hidden');
        stateSuccess.classList.remove('hidden');

        const deploy = data.deployment;
        const canonicalUrl = deploy.canonicalUrl || `https://${deploy.projectName || projectName}.vercel.app`;
        const directUrl = deploy.directUrl || canonicalUrl;

        // 1. Update Project Quick Specs
        const nameEl = document.getElementById('successProjectName');
        if (nameEl) nameEl.textContent = deploy.projectName || projectName;

        const fileCountEl = document.getElementById('successFileCount');
        if (fileCountEl) fileCountEl.textContent = `${deploy.fileCount || (zipFile ? 'Extracted' : 3)} files`;

        const envCountEl = document.getElementById('successEnvCount');
        if (envCountEl) envCountEl.textContent = `${deploy.envCount || 0} set`;

        // 2. Update Link 1: Production Domain (Primary)
        const canonLink = document.getElementById('successCanonicalLink');
        if (canonLink) {
          canonLink.textContent = canonicalUrl;
          canonLink.href = canonicalUrl;
        }
        const openCanonBtn = document.getElementById('openCanonicalSiteBtn');
        if (openCanonBtn) {
          openCanonBtn.href = canonicalUrl;
        }

        // 3. Update Link 2: Direct Deployment / Preview Link
        const directLink = document.getElementById('successDirectLink');
        if (directLink) {
          directLink.textContent = directUrl;
          directLink.href = directUrl;
        }
        const openDirectBtn = document.getElementById('openDirectSiteBtn');
        if (openDirectBtn) {
          openDirectBtn.href = directUrl;
        }

        // 4. Update Interactive Live Sandbox Viewport Frame
        if (livePreviewFrame) {
          livePreviewFrame.src = canonicalUrl;
        }

        showToast(`🎉 Congratulations! Your website is live at ${canonicalUrl}`);

        if (window.lucide) window.lucide.createIcons();
      }, 700);
    } catch (err) {
      appendLog(`❌ Deployment Error: ${err.message}`, false);
      updateRadarProgress(100, 'Deployment Failed');
      showToast(err.message, true);
    } finally {
      submitBtn.disabled = false;
      if (window.lucide) window.lucide.createIcons();
    }
  });

  // Handle "Deploy Another Website" Reset
  if (deployAnotherBtn) {
    deployAnotherBtn.addEventListener('click', () => {
      // 1. Switch back to Idle State
      stateSuccess.classList.add('hidden');
      stateDeploying.classList.add('hidden');
      stateIdle.classList.remove('hidden');

      // 2. Clear iframe
      if (livePreviewFrame) {
        livePreviewFrame.src = 'about:blank';
      }

      // 3. Reset form inputs
      form.reset();

      // 4. Clear application state
      appState.zipFile = null;
      appState.htmlFile = null;
      appState.htmlContent = '';
      appState.cssFile = null;
      appState.cssContent = '';
      appState.jsFile = null;
      appState.jsContent = '';
      appState.envContent = '';

      // 5. Reset Dropzones UI
      const zipDropzone = document.getElementById('zipDropzone');
      if (zipDropzone) {
        zipDropzone.classList.remove('file-loaded');
        const zipName = document.getElementById('zipFileName');
        const zipSize = document.getElementById('zipFileSize');
        const zipBar = document.getElementById('zipProgressBar');
        if (zipName) zipName.textContent = 'Drop project .ZIP archive here';
        if (zipSize) zipSize.textContent = 'Preserves images (jpg, png, heic, webp), CSS, JS & nested subfolders';
        if (zipBar) zipBar.style.width = '0%';
      }

      const resetSlot = (dropId, nameId, sizeId, barId, defaultTitle, defaultDesc) => {
        const drop = document.getElementById(dropId);
        if (drop) {
          drop.classList.remove('file-loaded');
          const n = document.getElementById(nameId);
          const s = document.getElementById(sizeId);
          const b = document.getElementById(barId);
          if (n) n.textContent = defaultTitle;
          if (s) s.textContent = defaultDesc;
          if (b) b.style.width = '0%';
        }
      };

      resetSlot('htmlDropzone', 'htmlFileName', 'htmlFileSize', 'htmlProgressBar', 'index.html (Structure)', 'Drop or click to choose');
      resetSlot('cssDropzone', 'cssFileName', 'cssFileSize', 'cssProgressBar', 'style.css (Styles)', 'Optional styling sheet');
      resetSlot('jsDropzone', 'jsFileName', 'jsFileSize', 'jsProgressBar', 'logic.js (Scripts)', 'Interactivity & JavaScript');

      const envText = document.getElementById('envTextInput');
      if (envText) envText.value = '';
      const envSummary = document.getElementById('envStatusSummary');
      if (envSummary) envSummary.textContent = 'Click to configure';
      const envDrawer = document.getElementById('envInputContainer');
      if (envDrawer) envDrawer.classList.add('hidden');

      // Scroll smoothly to form
      form.scrollIntoView({ behavior: 'smooth', block: 'start' });
      showToast('Form ready to deploy another website!');
      if (window.lucide) window.lucide.createIcons();
    });
  }
}

/**
 * Initializes modal dialogs & copy actions
 */
function initModals() {
  // Env Guide Modal
  const openEnvGuideBtn = document.getElementById('openEnvGuideBtn');
  const closeEnvModalBtn = document.getElementById('closeEnvModalBtn');
  const envModal = document.getElementById('envModal');

  if (openEnvGuideBtn && envModal) {
    openEnvGuideBtn.addEventListener('click', () => envModal.classList.remove('hidden'));
  }
  if (closeEnvModalBtn && envModal) {
    closeEnvModalBtn.addEventListener('click', () => envModal.classList.add('hidden'));
  }

  // Copy to clipboard
  document.addEventListener('click', (e) => {
    const copyBtn = e.target.closest('.copy-btn');
    if (copyBtn) {
      const targetSelector = copyBtn.getAttribute('data-clipboard-target');
      const targetElem = document.querySelector(targetSelector);
      if (targetElem) {
        const textToCopy = targetElem.textContent || targetElem.value;
        navigator.clipboard.writeText(textToCopy).then(() => {
          showToast(`Copied: ${textToCopy}`);
        });
      }
    }
  });
}

/**
 * Visitor Access Request & Telegram Bot 1-Click Approval System
 */
function initAuthGate() {
  const authSection = document.getElementById('authGateSection');
  const authForm = document.getElementById('authRequestForm');
  const authRadarBox = document.getElementById('authRadarBox');
  const authApprovedBox = document.getElementById('authApprovedBox');
  const authRejectedBox = document.getElementById('authRejectedBox');
  const authSubmitBtn = document.getElementById('authSubmitBtn');
  const launchpadCockpit = document.getElementById('launchpadCockpit');
  const authSessionPill = document.getElementById('authSessionPill');
  const authSessionUser = document.getElementById('authSessionUser');
  const authLogoutBtn = document.getElementById('authLogoutBtn');
  const authSimulateApproveBtn = document.getElementById('authSimulateApproveBtn');
  const authCancelRequestBtn = document.getElementById('authCancelRequestBtn');
  const authRetryBtn = document.getElementById('authRetryBtn');
  const approvedGreetingText = document.getElementById('approvedGreetingText');

  let activeRequestId = null;
  let authPollTimer = null;

  const lockApplication = () => {
    if (authSection) authSection.classList.remove('hidden');
    if (authForm) authForm.classList.remove('hidden');
    if (authRadarBox) authRadarBox.classList.add('hidden');
    if (authApprovedBox) authApprovedBox.classList.add('hidden');
    if (authRejectedBox) authRejectedBox.classList.add('hidden');
    if (launchpadCockpit) launchpadCockpit.classList.add('locked-cockpit');
    if (authSessionPill) authSessionPill.classList.add('hidden');
  };

  const unlockApplication = (userName = 'Authorized Visitor', animate = true) => {
    if (authSessionUser) authSessionUser.textContent = userName;
    if (authSessionPill) authSessionPill.classList.remove('hidden');

    if (animate) {
      if (authForm) authForm.classList.add('hidden');
      if (authRadarBox) authRadarBox.classList.add('hidden');
      if (authRejectedBox) authRejectedBox.classList.add('hidden');
      if (authApprovedBox) authApprovedBox.classList.remove('hidden');
      if (approvedGreetingText) {
        approvedGreetingText.textContent = `Welcome ${userName}! Your access request was approved by the administrator. Unlocking launchpad...`;
      }

      setTimeout(() => {
        if (authSection) authSection.classList.add('hidden');
        if (launchpadCockpit) launchpadCockpit.classList.remove('locked-cockpit');
        showToast(`🎉 Welcome, ${userName}! Launchpad unlocked.`);
      }, 1200);
    } else {
      if (authSection) authSection.classList.add('hidden');
      if (launchpadCockpit) launchpadCockpit.classList.remove('locked-cockpit');
    }
  };

  // Check existing session
  const checkAuthSession = async () => {
    const savedToken = localStorage.getItem('vercel_autohost_token');
    const savedUser = localStorage.getItem('vercel_autohost_user');

    if (savedToken) {
      try {
        const res = await fetch('/api/auth/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: savedToken })
        });
        const data = await res.json();
        if (data.valid) {
          unlockApplication(savedUser || 'Authorized User', false);
          return;
        }
      } catch (err) {
        console.warn('Session verification notice:', err);
      }
    }
    // Default: Locked
    lockApplication();
  };

  checkAuthSession();

  // Stop polling helper
  const stopPolling = () => {
    if (authPollTimer) {
      clearInterval(authPollTimer);
      authPollTimer = null;
    }
  };

  // Start status polling
  const startPolling = (requestId, name) => {
    stopPolling();
    activeRequestId = requestId;

    authPollTimer = setInterval(async () => {
      try {
        const res = await fetch(`/api/auth/status?id=${encodeURIComponent(requestId)}`);
        if (!res.ok) return;

        const data = await res.json();
        if (!data.success || !data.request) return;

        const { status, token } = data.request;

        if (status === 'APPROVED' && token) {
          stopPolling();
          localStorage.setItem('vercel_autohost_token', token);
          localStorage.setItem('vercel_autohost_user', name);
          unlockApplication(name, true);
        } else if (status === 'REJECTED') {
          stopPolling();
          if (authRadarBox) authRadarBox.classList.add('hidden');
          if (authRejectedBox) authRejectedBox.classList.remove('hidden');
          showToast('Your access request was declined by the administrator.', true);
        }
      } catch (err) {
        console.warn('Polling error:', err);
      }
    }, 1800);
  };

  // Handle Form Submission
  if (authForm) {
    authForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      const nameInput = document.getElementById('authNameInput');
      const reasonInput = document.getElementById('authReasonInput');
      const name = nameInput ? nameInput.value.trim() : '';
      const reason = reasonInput ? reasonInput.value.trim() : '';

      if (!name) {
        showToast('Please enter your full name.', true);
        return;
      }

      if (authSubmitBtn) {
        authSubmitBtn.disabled = true;
        authSubmitBtn.innerHTML = '<i data-lucide="loader-2" class="spin"></i> Dispatching Request...';
        if (window.lucide) window.lucide.createIcons();
      }

      try {
        const res = await fetch('/api/auth/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, reason })
        });

        const data = await res.json();
        if (!res.ok || !data.success) {
          throw new Error(data.error || 'Failed to submit authentication request');
        }

        // Switch to Waiting Radar
        authForm.classList.add('hidden');
        authRadarBox.classList.remove('hidden');
        startPolling(data.requestId, name);
        showToast('Authentication request sent to Telegram Admin!');
      } catch (err) {
        showToast(err.message, true);
      } finally {
        if (authSubmitBtn) {
          authSubmitBtn.disabled = false;
          authSubmitBtn.innerHTML = '<i data-lucide="send"></i> <span>Send Authentication Request to Telegram</span>';
          if (window.lucide) window.lucide.createIcons();
        }
      }
    });
  }

  // Handle Simulate Approval Button (Dev / Testing)
  if (authSimulateApproveBtn) {
    authSimulateApproveBtn.addEventListener('click', async () => {
      if (!activeRequestId) return;
      try {
        authSimulateApproveBtn.disabled = true;
        authSimulateApproveBtn.textContent = 'Simulating...';
        await fetch('/api/auth/simulate-approve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId: activeRequestId })
        });
      } catch (err) {
        showToast('Simulation failed: ' + err.message, true);
      } finally {
        authSimulateApproveBtn.disabled = false;
        authSimulateApproveBtn.innerHTML = '<i data-lucide="zap"></i> Instant Simulate Approval';
        if (window.lucide) window.lucide.createIcons();
      }
    });
  }

  // Handle Cancel Request Button
  if (authCancelRequestBtn) {
    authCancelRequestBtn.addEventListener('click', () => {
      stopPolling();
      activeRequestId = null;
      authRadarBox.classList.add('hidden');
      authForm.classList.remove('hidden');
      showToast('Authentication request cancelled.');
    });
  }

  // Handle Retry Button on Rejection
  if (authRetryBtn) {
    authRetryBtn.addEventListener('click', () => {
      authRejectedBox.classList.add('hidden');
      authForm.classList.remove('hidden');
    });
  }

  // Handle Logout Button
  if (authLogoutBtn) {
    authLogoutBtn.addEventListener('click', async () => {
      const token = localStorage.getItem('vercel_autohost_token');
      if (token) {
        try {
          await fetch('/api/auth/logout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token })
          });
        } catch {}
      }
      localStorage.removeItem('vercel_autohost_token');
      localStorage.removeItem('vercel_autohost_user');
      lockApplication();
      showToast('Session locked. Submit request to access again.');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }
}
