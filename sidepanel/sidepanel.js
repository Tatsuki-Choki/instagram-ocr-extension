// デバッグログをサイドパネル内に表示
const debugLog = document.getElementById('debug-log');
const clearLogBtn = document.getElementById('clear-log');
const copyLogBtn = document.getElementById('copy-log');
const toggleDebugBtn = document.getElementById('toggle-debug');

let debugExpanded = false;

function log(...args) {
  const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ');
  console.log('[SidePanel]', ...args);
  addLogEntry('[SP] ' + message, 'info');
}

function logError(...args) {
  const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ');
  console.error('[SidePanel ERROR]', ...args);
  addLogEntry('[SP] ERROR: ' + message, 'error');
}

// content.jsからのログを表示
function logContent(message) {
  addLogEntry('[CT] ' + message, 'info');
}

function addLogEntry(message, type = 'info') {
  const entry = document.createElement('div');
  entry.className = `log-entry log-${type}`;
  const time = new Date().toLocaleTimeString('ja-JP');
  entry.textContent = `[${time}] ${message}`;
  debugLog.appendChild(entry);
  debugLog.scrollTop = debugLog.scrollHeight;
}

// content.jsからのログを定期的に取得
async function fetchContentLogs() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'getLogs' });
    if (response && response.logs) {
      response.logs.forEach(logEntry => {
        logContent(logEntry.message);
      });
    }
  } catch (e) {
    // エラーは無視
  }
}

// 500msごとにログを取得
setInterval(fetchContentLogs, 500);

// トグル機能
toggleDebugBtn?.addEventListener('click', () => {
  debugExpanded = !debugExpanded;
  debugLog.classList.toggle('collapsed', !debugExpanded);
  toggleDebugBtn.classList.toggle('expanded', debugExpanded);
});

// クリア
clearLogBtn?.addEventListener('click', () => {
  debugLog.innerHTML = '';
});

// コピー
copyLogBtn?.addEventListener('click', async () => {
  const logText = debugLog.innerText;
  try {
    await navigator.clipboard.writeText(logText);
    copyLogBtn.textContent = 'コピー済み';
    setTimeout(() => { copyLogBtn.textContent = 'コピー'; }, 2000);
  } catch (e) {
    console.error('Copy failed:', e);
  }
});

// DOM要素
const apiKeyInput = document.getElementById('api-key');
const saveKeyBtn = document.getElementById('save-key');
const toggleKeyBtn = document.getElementById('toggle-key');
const keyStatus = document.getElementById('key-status');
const startOcrBtn = document.getElementById('start-ocr');
const notInstagramWarning = document.getElementById('not-instagram');
const progressSection = document.getElementById('progress');
const progressFill = document.querySelector('.progress-fill');
const progressCount = document.getElementById('progress-count');
const resultsSection = document.getElementById('results-section');
const resultsContainer = document.getElementById('results-container');
const captionSection = document.getElementById('caption-section');
const captionText = document.getElementById('caption-text');
const copyCaptionBtn = document.getElementById('copy-caption');
const copyAllBtn = document.getElementById('copy-all');
const clearAllBtn = document.getElementById('clear-all');
const errorMessage = document.getElementById('error-message');
const toast = document.getElementById('toast');

let currentResults = [];
let currentCaption = '';

// 初期化
document.addEventListener('DOMContentLoaded', async () => {
  log('SidePanel initialized');

  const { geminiApiKey } = await chrome.storage.sync.get(['geminiApiKey']);
  if (geminiApiKey) {
    apiKeyInput.value = geminiApiKey;
    showStatus('APIキー設定済み', 'success');
  }

  checkCurrentTab();
});

// 現在のタブをチェック
async function checkCurrentTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const isInstagram = tab.url && tab.url.includes('instagram.com/p/');

    if (isInstagram) {
      notInstagramWarning.classList.add('hidden');
      const { geminiApiKey } = await chrome.storage.sync.get(['geminiApiKey']);
      startOcrBtn.disabled = !geminiApiKey;
    } else {
      notInstagramWarning.classList.remove('hidden');
      startOcrBtn.disabled = true;
    }
  } catch (error) {
    startOcrBtn.disabled = true;
  }
}

// APIキーの表示/非表示切り替え
toggleKeyBtn.addEventListener('click', () => {
  apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
});

// APIキーを保存
saveKeyBtn.addEventListener('click', async () => {
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) {
    showStatus('APIキーを入力してください', 'error');
    return;
  }

  await chrome.storage.sync.set({ geminiApiKey: apiKey });
  showStatus('APIキーを保存しました', 'success');
  log('API key saved');
  checkCurrentTab();
});

function showStatus(message, type) {
  keyStatus.textContent = message;
  keyStatus.className = 'status ' + type;
  keyStatus.classList.remove('hidden');
}

function showError(message) {
  errorMessage.textContent = message;
  errorMessage.classList.remove('hidden');
}

function hideError() {
  errorMessage.classList.add('hidden');
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2000);
}

// ページリロードして完了を待つ
async function reloadAndWait(tabId) {
  return new Promise((resolve) => {
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        // content scriptが読み込まれるまで少し待つ
        setTimeout(resolve, 500);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.reload(tabId);
  });
}

// OCR開始
startOcrBtn.addEventListener('click', async () => {
  log('=== OCR START ===');
  hideError();
  resultsSection.classList.add('hidden');
  captionSection.classList.add('hidden');
  currentResults = [];
  currentCaption = '';

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    log('Target tab: ' + tab.id);

    startOcrBtn.disabled = true;

    // まずページをリロード
    updateButtonState('loading', 'ページをリロード中...');
    log('Reloading page...');
    await reloadAndWait(tab.id);
    log('Page reloaded, waiting for content script...');

    // content scriptの準備完了を待つ
    await new Promise(r => setTimeout(r, 1000));

    updateButtonState('loading', '画像を取得中...');
    log('Sending getImages to content script...');
    let response;
    try {
      response = await chrome.tabs.sendMessage(tab.id, { action: 'getImages' });
    } catch (e) {
      logError('Message failed: ' + e.message);
      throw new Error('ページの読み込みに失敗しました。再度お試しください');
    }

    // content.jsのログを取得
    await fetchContentLogs();

    if (!response || !response.success) {
      throw new Error(response?.error || '画像を取得できませんでした');
    }

    const imageUrls = response.images || [];
    currentCaption = response.caption || '';

    log('=== DATA RECEIVED ===');
    log('Images: ' + imageUrls.length);
    log('Caption: ' + (currentCaption ? currentCaption.substring(0, 30) + '...' : 'NONE'));

    imageUrls.forEach((url, i) => {
      log(`Img ${i + 1}: ...${url.substring(url.length - 30)}`);
    });

    if (imageUrls.length === 0) {
      throw new Error('投稿に画像が見つかりませんでした');
    }

    progressSection.classList.remove('hidden');
    progressCount.textContent = `0/${imageUrls.length}`;
    progressFill.style.width = '0%';

    const { geminiApiKey } = await chrome.storage.sync.get(['geminiApiKey']);

    log('=== OCR LOOP START ===');
    for (let i = 0; i < imageUrls.length; i++) {
      log(`OCR ${i + 1}/${imageUrls.length}...`);
      updateButtonState('processing', `処理中... (${i + 1}/${imageUrls.length})`);

      const result = await chrome.runtime.sendMessage({
        action: 'processOCR',
        imageUrl: imageUrls[i],
        apiKey: geminiApiKey
      });

      log(`Result ${i + 1}: ${result.success ? 'OK' : 'FAIL'}, len=${result.text?.length || 0}`);

      currentResults.push({
        index: i + 1,
        text: result.success ? result.text : `エラー: ${result.error}`,
        error: !result.success
      });

      const progress = ((i + 1) / imageUrls.length) * 100;
      progressFill.style.width = `${progress}%`;
      progressCount.textContent = `${i + 1}/${imageUrls.length}`;
    }

    log('=== OCR COMPLETE ===');
    log('Total results: ' + currentResults.length);

    displayResults();
    showToast('文字起こしが完了しました');

  } catch (error) {
    logError('Error: ' + error.message);
    showError(error.message);
  } finally {
    startOcrBtn.disabled = false;
    updateButtonState('idle', '文字起こしを開始');
    progressSection.classList.add('hidden');
    checkCurrentTab();
  }
});

function updateButtonState(state, text) {
  const icon = startOcrBtn.querySelector('.btn-icon');
  startOcrBtn.querySelector('.btn-text').textContent = text;

  if (state === 'loading' || state === 'processing') {
    icon.innerHTML = '<circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" fill="none" stroke-dasharray="30" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/></circle>';
  } else {
    icon.innerHTML = '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>';
  }
}

function displayResults() {
  log('Displaying ' + currentResults.length + ' results');

  resultsContainer.innerHTML = '';

  currentResults.forEach((result, index) => {
    const item = document.createElement('div');
    item.className = 'result-item';
    const hasText = result.text && result.text.trim() && !result.error;

    item.innerHTML = `
      <div class="result-header">
        <span class="result-label">${result.index}枚目</span>
        <button class="btn-copy" data-index="${index}" ${!hasText ? 'disabled' : ''}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
          </svg>
          <span>コピー</span>
        </button>
      </div>
      <div class="result-text ${!hasText ? 'empty' : ''}">
        ${hasText ? escapeHtml(result.text) : (result.error ? result.text : 'テキストなし')}
      </div>
    `;

    resultsContainer.appendChild(item);
  });

  resultsContainer.querySelectorAll('.btn-copy').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const button = e.currentTarget;
      const index = parseInt(button.dataset.index);
      copyToClipboard(currentResults[index].text, button);
    });
  });

  resultsSection.classList.remove('hidden');

  if (currentCaption && currentCaption.trim()) {
    log('Showing caption section');
    captionText.textContent = currentCaption;
    captionSection.classList.remove('hidden');
  } else {
    captionSection.classList.add('hidden');
  }
}

copyCaptionBtn?.addEventListener('click', () => {
  copyToClipboard(currentCaption, copyCaptionBtn);
});

copyAllBtn?.addEventListener('click', () => {
  const allTexts = [];

  currentResults.forEach((result) => {
    if (result.text && result.text.trim() && !result.error && result.text !== 'テキストなし') {
      allTexts.push(`【${result.index}枚目】\n${result.text}`);
    }
  });

  if (currentCaption && currentCaption.trim()) {
    allTexts.push(`【キャプション】\n${currentCaption}`);
  }

  if (allTexts.length === 0) {
    showToast('コピーするテキストがありません');
    return;
  }

  copyToClipboard(allTexts.join('\n\n'), copyAllBtn);
});

clearAllBtn?.addEventListener('click', async () => {
  currentResults = [];
  currentCaption = '';
  await chrome.storage.local.remove(['savedResults', 'savedCaption', 'savedUrl']);
  resultsSection.classList.add('hidden');
  captionSection.classList.add('hidden');
  resultsContainer.innerHTML = '';
  captionText.textContent = '';
  hideError();
  showToast('クリアしました');
});

async function copyToClipboard(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    const span = button.querySelector('span');
    const originalText = span.textContent;
    span.textContent = 'コピー済み';
    button.classList.add('copied');
    showToast('コピーしました');
    setTimeout(() => {
      span.textContent = originalText;
      button.classList.remove('copied');
    }, 2000);
  } catch (error) {
    showToast('コピーに失敗しました');
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

chrome.tabs.onActivated?.addListener(() => checkCurrentTab());
chrome.tabs.onUpdated?.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete') checkCurrentTab();
});
