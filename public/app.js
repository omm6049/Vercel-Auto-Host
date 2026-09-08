/**
 * Vercel Auto Host - Client Application Logic
 */

// Application State
const appState = {
  htmlFile: null,
  htmlContent: '',
  cssFile: null,
  cssContent: '',
  jsFile: null,
  jsContent: '',
  botSimStep: 'AWAITING_HTML',
  botSimData: {
    html: null,
    css: null,
    js: null,
    name: null
  }
};

// DOM Elements
document.addEventListener('DOMContentLoaded', () => {
  // Initialize Lucide icons
  if (window.lucide) {
    window.lucide.createIcons();
  }

  initStatusPolling();
  initDropzones();
  initFormHandler();
  initSampleLoader();
  initTelegramSimulator();
  initHistoryViewer();
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
    toast.style.borderColor = 'rgba(244, 63, 94, 0.4)';
  } else {
    toast.style.borderColor = 'rgba(16, 185, 129, 0.4)';
  }

  setTimeout(() => {
    toast.classList.add('hidden');
  }, 4000);
}

/**
 * Polls backend API for system & credential health
 */
async function initStatusPolling() {
  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/status');
      const data = await res.json();

      // Telegram Bot Status
      const botDot = document.getElementById('botStatusDot');
      const botText = document.getElementById('botStatusText');
      if (data.telegram.configured) {
        botDot.className = 'status-dot active';
        botText.textContent = 'Active (Polling)';
      } else {
        botDot.className = 'status-dot pulse-warning';
        botText.textContent = 'Awaiting Token in .env';
      }

      // Vercel API Status
      const vercelDot = document.getElementById('vercelStatusDot');
      const vercelText = document.getElementById('vercelStatusText');
      if (data.vercel.authenticated) {
        vercelDot.className = 'status-dot active';
        vercelText.textContent = `Connected (${data.vercel.user || 'Ready'})`;
      } else if (data.vercel.configured) {
        vercelDot.className = 'status-dot error';
        vercelText.textContent = 'Invalid Vercel Token';
      } else {
        vercelDot.className = 'status-dot pulse-warning';
        vercelText.textContent = 'Awaiting Token in .env';
      }

      // Vercel Blob Status
      const blobDot = document.getElementById('blobStatusDot');
      const blobText = document.getElementById('blobStatusText');
      if (data.blobStorage.configured) {
        blobDot.className = 'status-dot active';
        blobText.textContent = 'Connected (Backups on)';
      } else {
        blobDot.className = 'status-dot';
        blobDot.style.background = '#64748b';
        blobText.textContent = 'Optional (Not configured)';
      }
    } catch (err) {
      console.warn('Status fetch error:', err);
    }
  };

  fetchStatus();
  setInterval(fetchStatus, 8000);
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
 * Sets up drag & drop functionality for the 3 slots
 */
function initDropzones() {
  const setupDropzone = (dropzoneId, inputId, nameId, sizeId, barId, type) => {
    const dropzone = document.getElementById(dropzoneId);
    const input = document.getElementById(inputId);
    const nameLabel = document.getElementById(nameId);
    const sizeLabel = document.getElementById(sizeId);
    const progressBar = document.getElementById(barId);

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
      dropzone.classList.remove('dragover');
    });

    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
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
      <p>This page was automatically assembled from index.html, style.css, and logic.js!</p>
      <div class="counter-box">
        <button id="counterBtn" class="btn">⚡ Click Me (JS Interactivity)</button>
        <span id="counterVal">0</span> clicks
      </div>
    </div>
  </div>
  <script src="logic.js"></script>
</body>
</html>`;

      // Sample CSS
      const sampleCss = `body {
  font-family: 'Segoe UI', system-ui, sans-serif;
  background: radial-gradient(circle at center, #1e1b4b, #0f172a);
  color: #f8fafc;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0;
}
.container { padding: 20px; width: 100%; max-width: 520px; }
.card {
  background: rgba(30, 41, 59, 0.7);
  backdrop-filter: blur(16px);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 20px;
  padding: 36px;
  text-align: center;
  box-shadow: 0 20px 40px rgba(0,0,0,0.4);
}
.badge {
  display: inline-block;
  background: rgba(99, 102, 241, 0.2);
  color: #a5b4fc;
  padding: 4px 12px;
  border-radius: 100px;
  font-size: 0.8rem;
  font-weight: 600;
  margin-bottom: 16px;
}
h1 { font-size: 2rem; margin-bottom: 12px; }
.highlight {
  background: linear-gradient(135deg, #6366f1, #ec4899);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}
p { color: #94a3b8; font-size: 0.95rem; line-height: 1.6; margin-bottom: 24px; }
.counter-box { display: flex; align-items: center; justify-content: center; gap: 14px; }
.btn {
  background: linear-gradient(135deg, #6366f1, #ec4899);
  color: #fff;
  border: none;
  padding: 10px 20px;
  border-radius: 10px;
  font-weight: 600;
  cursor: pointer;
  transition: transform 0.2s;
}
.btn:hover { transform: scale(1.05); }
#counterVal { font-size: 1.4rem; font-weight: bold; color: #38bdf8; }`;

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
      document.getElementById('htmlDropzone').classList.add('file-loaded');
      document.getElementById('htmlFileName').textContent = 'index.html (Sample Demo)';
      document.getElementById('htmlFileSize').textContent = `${formatBytes(sampleHtml.length)} • Ready`;
      document.getElementById('htmlProgressBar').style.width = '100%';

      document.getElementById('cssDropzone').classList.add('file-loaded');
      document.getElementById('cssFileName').textContent = 'style.css (Sample Demo)';
      document.getElementById('cssFileSize').textContent = `${formatBytes(sampleCss.length)} • Ready`;
      document.getElementById('cssProgressBar').style.width = '100%';

      document.getElementById('jsDropzone').classList.add('file-loaded');
      document.getElementById('jsFileName').textContent = 'logic.js (Sample Demo)';
      document.getElementById('jsFileSize').textContent = `${formatBytes(sampleJs.length)} • Ready`;
      document.getElementById('jsProgressBar').style.width = '100%';

      const randomSuffix = Math.random().toString(36).substring(2, 6);
      document.getElementById('projectNameInput').value = `showcase-app-${randomSuffix}`;

      showToast('Loaded demo sample files into all 3 slots!');
    } catch (err) {
      showToast('Failed to load sample files', true);
    } finally {
      loadBtn.disabled = false;
      loadBtn.innerHTML = '<i data-lucide="wand-2"></i> Load Demo Sample Files';
      if (window.lucide) window.lucide.createIcons();
    }
  });
}

/**
 * Web Deployment Form Handler
 */
function initFormHandler() {
  const form = document.getElementById('deploymentForm');
  const statusContainer = document.getElementById('deployStatusContainer');
  const statusTitle = document.getElementById('deployStatusTitle');
  const statusDesc = document.getElementById('deployStatusDesc');
  const progressBar = document.getElementById('overallProgressBar');
  const submitBtn = document.getElementById('deploySubmitBtn');
  const resultCard = document.getElementById('deployResultCard');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const projectName = document.getElementById('projectNameInput').value.trim();
    if (!projectName) {
      showToast('Please enter a website name.', true);
      return;
    }

    if (!appState.htmlContent) {
      showToast('Please upload or provide index.html file first.', true);
      return;
    }

    // UI state: Deploying
    submitBtn.disabled = true;
    statusContainer.classList.remove('hidden');
    resultCard.classList.add('hidden');
    progressBar.style.width = '20%';
    statusTitle.textContent = 'Processing files...';
    statusDesc.textContent = 'Ensuring style.css and logic.js are linked with index.html...';

    const updateStep = (percent, title, desc) => {
      progressBar.style.width = `${percent}%`;
      statusTitle.textContent = title;
      statusDesc.textContent = desc;
    };

    try {
      setTimeout(() => updateStep(50, 'Uploading to Vercel Deployments...', 'Sending payload to Vercel REST API...'), 600);

      const response = await fetch('/api/deploy', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          projectName,
          htmlContent: appState.htmlContent,
          cssContent: appState.cssContent,
          jsContent: appState.jsContent
        })
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Deployment failed');
      }

      updateStep(100, 'Deployment Complete! 🎉', 'Website is live on Vercel CDN.');
      document.getElementById('deploySpinner').style.display = 'none';

      // Show result
      const deploy = data.deployment;
      document.getElementById('resultCanonicalUrl').textContent = deploy.canonicalUrl;
      document.getElementById('resultCanonicalUrl').href = deploy.canonicalUrl;
      document.getElementById('resultDirectUrl').textContent = deploy.directUrl;
      document.getElementById('resultDirectUrl').href = deploy.directUrl;
      document.getElementById('openLiveSiteBtn').href = deploy.canonicalUrl;

      // Sandbox Preview button binding
      const previewBtn = document.getElementById('previewInSandboxBtn');
      previewBtn.onclick = () => {
        openSandboxPreview(deploy.canonicalUrl, deploy.projectName);
      };

      resultCard.classList.remove('hidden');
      showToast(`Website deployed successfully to ${deploy.canonicalUrl}!`);

      // Refresh history list
      loadHistoryList();
    } catch (err) {
      progressBar.style.width = '100%';
      progressBar.style.background = 'var(--accent-rose)';
      statusTitle.textContent = 'Deployment Failed';
      statusDesc.textContent = err.message;
      showToast(err.message, true);
    } finally {
      submitBtn.disabled = false;
      if (window.lucide) window.lucide.createIcons();
    }
  });
}

/**
 * Telegram Chat Simulator Widget
 */
function initTelegramSimulator() {
  const container = document.getElementById('telegramChatContainer');
  const input = document.getElementById('tgSimInput');
  const sendBtn = document.getElementById('tgSimSendBtn');
  const uploadBtn = document.getElementById('simUploadBtn');

  const appendMsg = (text, isUser = false) => {
    const bubble = document.createElement('div');
    bubble.className = `tg-bubble ${isUser ? 'tg-user' : 'tg-bot'}`;
    bubble.innerHTML = `
      <div class="tg-text">${text}</div>
      <span class="tg-time">${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
    `;
    container.appendChild(bubble);
    container.scrollTop = container.scrollHeight;
    if (window.lucide) window.lucide.createIcons();
  };

  const handleSimInput = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';

    appendMsg(text, true);

    if (text.toLowerCase() === '/start') {
      appState.botSimStep = 'AWAITING_HTML';
      setTimeout(() => {
        appendMsg(
          `👋 <strong>Hello! Welcome to Vercel Auto Host Bot.</strong><br><br>` +
          `I will help you deploy your website to <strong>Vercel</strong> in 4 simple steps:<br>` +
          `1️⃣ Send <code>index.html</code><br>` +
          `2️⃣ Send <code>style.css</code><br>` +
          `3️⃣ Send <code>logic.js</code><br>` +
          `4️⃣ Enter your desired Website Name<br><br>` +
          `📌 <strong>Step 1/4:</strong> Please send your <strong>index.html</strong> file (click 📎 or upload).`
        );
      }, 500);
      return;
    }

    if (text.toLowerCase() === '/help') {
      setTimeout(() => {
        appendMsg(
          `📖 <strong>Vercel Auto Host Bot Commands:</strong><br>` +
          `• <code>/start</code> - Begin new website deployment<br>` +
          `• <code>/cancel</code> - Reset current upload session<br>` +
          `• <code>/status</code> - View your deployed websites`
        );
      }, 400);
      return;
    }

    if (appState.botSimStep === 'AWAITING_NAME') {
      const siteName = text.toLowerCase().replace(/[^a-z0-9-]/g, '-');
      appendMsg(`⏳ <strong>Connecting files & deploying \`${siteName}\` to Vercel...</strong><br>🔗 Auto-linking style.css & logic.js into index.html...`);

      // Trigger actual deploy or simulated response
      try {
        const response = await fetch('/api/deploy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectName: siteName,
            htmlContent: appState.botSimData.html || '<h1>Live Site</h1>',
            cssContent: appState.botSimData.css || 'body { font-family: sans-serif; }',
            jsContent: appState.botSimData.js || 'console.log("ready");'
          })
        });
        const data = await response.json();

        if (data.success) {
          const dep = data.deployment;
          setTimeout(() => {
            appendMsg(
              `🎉 <strong>Website Successfully Deployed to Vercel!</strong><br><br>` +
              `🏷️ <strong>Project Name:</strong> <code>${dep.projectName}</code><br>` +
              `🌐 <strong>Live Website URL:</strong><br>👉 <a href="${dep.canonicalUrl}" target="_blank" style="color:#a5b4fc">${dep.canonicalUrl}</a><br><br>` +
              `✨ <strong>Connected Components:</strong><br>` +
              `• <code>index.html</code> (Root Entrypoint)<br>` +
              `• <code>style.css</code> (Styles Linked)<br>` +
              `• <code>logic.js</code> (Scripts Linked)`
            );
            loadHistoryList();
          }, 800);
        } else {
          appendMsg(`❌ <strong>Deployment Error:</strong> ${data.error}`);
        }
      } catch (err) {
        appendMsg(`❌ <strong>Deployment Error:</strong> ${err.message}`);
      }

      appState.botSimStep = 'IDLE';
      return;
    }

    // Guidance for other text
    setTimeout(() => {
      appendMsg(`💡 Type <code>/start</code> to begin uploading your 3 website files!`);
    }, 400);
  };

  sendBtn.addEventListener('click', handleSimInput);
  input.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleSimInput();
  });

  // Simulated File Upload via paperclip button
  uploadBtn.addEventListener('click', () => {
    if (appState.botSimStep === 'AWAITING_HTML') {
      appendMsg(`📎 <em>Sent file: index.html</em>`, true);
      appendMsg(`📥 <strong>Uploading index.html...</strong><br>Progress: [██████████] 100%<br><br>✅ <strong>File Uploaded successfully!</strong>`);
      appState.botSimData.html = appState.htmlContent || '<h1>Sample</h1>';
      appState.botSimStep = 'AWAITING_CSS';
      setTimeout(() => {
        appendMsg(`📌 <strong>Step 2/4:</strong> Great! Now please upload your <strong>style.css</strong> file.`);
      }, 500);
      return;
    }

    if (appState.botSimStep === 'AWAITING_CSS') {
      appendMsg(`📎 <em>Sent file: style.css</em>`, true);
      appendMsg(`📥 <strong>Uploading style.css...</strong><br>Progress: [██████████] 100%<br><br>✅ <strong>File Uploaded successfully!</strong>`);
      appState.botSimData.css = appState.cssContent || 'body { color: blue; }';
      appState.botSimStep = 'AWAITING_JS';
      setTimeout(() => {
        appendMsg(`📌 <strong>Step 3/4:</strong> Excellent! Now please upload your <strong>logic.js</strong> file.`);
      }, 500);
      return;
    }

    if (appState.botSimStep === 'AWAITING_JS') {
      appendMsg(`📎 <em>Sent file: logic.js</em>`, true);
      appendMsg(`📥 <strong>Uploading logic.js...</strong><br>Progress: [██████████] 100%<br><br>✅ <strong>File Uploaded successfully!</strong>`);
      appState.botSimData.js = appState.jsContent || 'console.log("run");';
      appState.botSimStep = 'AWAITING_NAME';
      setTimeout(() => {
        appendMsg(
          `✨ <strong>All 3 files uploaded successfully!</strong><br>` +
          `• <code>index.html</code> ✅<br>` +
          `• <code>style.css</code> ✅<br>` +
          `• <code>logic.js</code> ✅<br><br>` +
          `📌 <strong>Step 4/4:</strong> What <strong>Website Name</strong> do you want for your site?<br>` +
          `<em>(e.g., <code>my-portfolio</code>, <code>awesome-shop</code>)</em>`
        );
      }, 500);
      return;
    }

    appendMsg(`💡 Type <code>/start</code> first to begin a new deployment!`);
  });
}

/**
 * Deployment History Table Loader
 */
async function loadHistoryList() {
  const tbody = document.getElementById('historyTableBody');
  if (!tbody) return;

  try {
    const res = await fetch('/api/history');
    const data = await res.json();

    if (!data.deployments || data.deployments.length === 0) {
      tbody.innerHTML = `
        <tr class="empty-row">
          <td colspan="5">
            <div class="empty-state">
              <i data-lucide="inbox"></i>
              <p>No deployments yet. Send <code>/start</code> in Telegram or deploy via Web Studio above!</p>
            </div>
          </td>
        </tr>
      `;
      if (window.lucide) window.lucide.createIcons();
      return;
    }

    tbody.innerHTML = data.deployments
      .map(
        (dep) => `
      <tr>
        <td><strong>${dep.projectName}</strong></td>
        <td>
          <a href="${dep.canonicalUrl}" target="_blank" class="url-link">
            ${dep.canonicalUrl}
          </a>
        </td>
        <td><span class="slot-badge">${dep.source || 'Vercel API'}</span></td>
        <td>${new Date(dep.createdAt).toLocaleString()}</td>
        <td>
          <div style="display: flex; gap: 8px;">
            <button class="btn btn-xs btn-glass" onclick="openSandboxPreview('${dep.canonicalUrl}', '${dep.projectName}')">
              <i data-lucide="layout"></i> Preview
            </button>
            <a href="${dep.canonicalUrl}" target="_blank" class="btn btn-xs btn-primary">
              <i data-lucide="external-link"></i> Open
            </a>
          </div>
        </td>
      </tr>
    `
      )
      .join('');

    if (window.lucide) window.lucide.createIcons();
  } catch (err) {
    console.error('History fetch error:', err);
  }
}

function initHistoryViewer() {
  const refreshBtn = document.getElementById('refreshHistoryBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      loadHistoryList();
      showToast('Deployment history refreshed');
    });
  }
  loadHistoryList();
}

/**
 * Sandbox Preview Modal Controller
 */
window.openSandboxPreview = function (url, title) {
  const modal = document.getElementById('previewModal');
  const iframe = document.getElementById('previewIframe');
  const modalTitle = document.getElementById('previewModalTitle');
  const modalUrl = document.getElementById('previewModalUrl');
  const externalLink = document.getElementById('previewModalExternalLink');

  if (!modal || !iframe) return;

  modalTitle.textContent = title || 'Website Preview';
  modalUrl.textContent = url;
  externalLink.href = url;
  iframe.src = url;

  modal.classList.remove('hidden');
};

/**
 * Modals Initialization
 */
function initModals() {
  const closePreviewBtn = document.getElementById('closePreviewModalBtn');
  const previewModal = document.getElementById('previewModal');
  const iframe = document.getElementById('previewIframe');

  if (closePreviewBtn && previewModal) {
    closePreviewBtn.addEventListener('click', () => {
      previewModal.classList.add('hidden');
      iframe.src = 'about:blank';
    });
  }

  const openEnvBtn = document.getElementById('openEnvGuideBtn');
  const closeEnvBtn = document.getElementById('closeEnvModalBtn');
  const envModal = document.getElementById('envModal');

  if (openEnvBtn && envModal) {
    openEnvBtn.addEventListener('click', (e) => {
      e.preventDefault();
      envModal.classList.remove('hidden');
    });
  }

  if (closeEnvBtn && envModal) {
    closeEnvBtn.addEventListener('click', () => {
      envModal.classList.add('hidden');
    });
  }

  // Close modals when clicking overlay background
  window.addEventListener('click', (e) => {
    if (e.target === previewModal) {
      previewModal.classList.add('hidden');
      iframe.src = 'about:blank';
    }
    if (e.target === envModal) {
      envModal.classList.add('hidden');
    }
  });

  // Clipboard copy buttons
  document.addEventListener('click', (e) => {
    const copyBtn = e.target.closest('.copy-btn');
    if (copyBtn) {
      const targetSelector = copyBtn.getAttribute('data-clipboard-target');
      const targetElem = document.querySelector(targetSelector);
      if (targetElem) {
        const textToCopy = targetElem.textContent || targetElem.value;
        navigator.clipboard.writeText(textToCopy).then(() => {
          showToast(`Copied to clipboard: ${textToCopy}`);
        });
      }
    }
  });
}
