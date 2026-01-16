// デバッグモード
const DEBUG = true;

function log(...args) {
  if (DEBUG) console.log('[Instagram OCR Popup]', ...args);
}

function logError(...args) {
  console.error('[Instagram OCR Popup ERROR]', ...args);
}

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
const errorMessage = document.getElementById('error-message');
const toast = document.getElementById('toast');

let currentResults = [];
let currentCaption = '';

// 初期化
document.addEventListener('DOMContentLoaded', async () => {
  log('Popup initialized');

  // 保存されたAPIキーを読み込む
  const { geminiApiKey } = await chrome.storage.sync.get(['geminiApiKey']);
  if (geminiApiKey) {
    apiKeyInput.value = geminiApiKey;
    showStatus('APIキー設定済み', 'success');
  }

  // 保存された結果を読み込む
  await loadSavedResults();

  // 現在のタブがInstagramかチェック
  checkCurrentTab();
});

// 保存された結果を読み込む
async function loadSavedResults() {
  const { savedResults, savedCaption, savedUrl } = await chrome.storage.local.get([
    'savedResults',
    'savedCaption',
    'savedUrl'
  ]);

  if (savedResults && savedResults.length > 0) {
    currentResults = savedResults;
    currentCaption = savedCaption || '';
    displayResults();
    log('Loaded saved results:', savedResults.length, 'items');
  }
}

// 結果を保存
async function saveResults() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.storage.local.set({
    savedResults: currentResults,
    savedCaption: currentCaption,
    savedUrl: tab?.url || ''
  });
  log('Results saved');
}

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
    logError('Tab check error:', error);
    startOcrBtn.disabled = true;
  }
}

// APIキーの表示/非表示切り替え
toggleKeyBtn.addEventListener('click', () => {
  const type = apiKeyInput.type === 'password' ? 'text' : 'password';
  apiKeyInput.type = type;
  const icon = toggleKeyBtn.querySelector('svg');
  if (type === 'password') {
    icon.innerHTML = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
  } else {
    icon.innerHTML = '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>';
  }
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
  checkCurrentTab();
});

// ステータス表示
function showStatus(message, type) {
  keyStatus.textContent = message;
  keyStatus.className = 'status ' + type;
  keyStatus.classList.remove('hidden');
}

// エラー表示
function showError(message) {
  errorMessage.textContent = message;
  errorMessage.classList.remove('hidden');
}

// エラー非表示
function hideError() {
  errorMessage.classList.add('hidden');
}

// トースト表示
function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => {
    toast.classList.remove('show');
  }, 2000);
}

// OCR開始
startOcrBtn.addEventListener('click', async () => {
  log('OCR started');
  hideError();
  resultsSection.classList.add('hidden');
  captionSection.classList.add('hidden');
  currentResults = [];
  currentCaption = '';

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    startOcrBtn.disabled = true;
    updateButtonState('loading', '画像を取得中...');

    // content scriptにデータ取得を依頼
    let response;
    try {
      response = await chrome.tabs.sendMessage(tab.id, { action: 'getImages' });
      log('Response:', response);
    } catch (e) {
      logError('Failed to send message:', e);
      throw new Error('ページを再読み込みしてから再度お試しください');
    }

    if (!response || !response.success) {
      throw new Error(response?.error || '画像を取得できませんでした');
    }

    const imageUrls = response.images || [];
    currentCaption = response.caption || '';

    log('Images:', imageUrls.length, 'Caption length:', currentCaption.length);

    if (imageUrls.length === 0) {
      throw new Error('投稿に画像が見つかりませんでした');
    }

    // プログレス表示
    progressSection.classList.remove('hidden');
    progressCount.textContent = `0/${imageUrls.length}`;
    progressFill.style.width = '0%';

    // APIキーを取得
    const { geminiApiKey } = await chrome.storage.sync.get(['geminiApiKey']);

    // 各画像をOCR処理
    for (let i = 0; i < imageUrls.length; i++) {
      updateButtonState('processing', `処理中... (${i + 1}/${imageUrls.length})`);

      const result = await chrome.runtime.sendMessage({
        action: 'processOCR',
        imageUrl: imageUrls[i],
        apiKey: geminiApiKey
      });

      currentResults.push({
        index: i + 1,
        text: result.success ? result.text : `エラー: ${result.error}`,
        error: !result.success
      });

      // プログレス更新
      const progress = ((i + 1) / imageUrls.length) * 100;
      progressFill.style.width = `${progress}%`;
      progressCount.textContent = `${i + 1}/${imageUrls.length}`;
    }

    // 結果を表示・保存
    displayResults();
    await saveResults();

    showToast('文字起こしが完了しました');

  } catch (error) {
    logError('OCR error:', error);
    showError(error.message);
  } finally {
    startOcrBtn.disabled = false;
    updateButtonState('idle', '文字起こしを開始');
    progressSection.classList.add('hidden');
    checkCurrentTab();
  }
});

// ボタンの状態を更新
function updateButtonState(state, text) {
  const icon = startOcrBtn.querySelector('.btn-icon');
  startOcrBtn.querySelector('.btn-text').textContent = text;

  if (state === 'loading' || state === 'processing') {
    icon.innerHTML = '<circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" fill="none" stroke-dasharray="30" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/></circle>';
  } else {
    icon.innerHTML = '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>';
  }
}

// 結果を表示
function displayResults() {
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

  // コピーボタンのイベントリスナー
  document.querySelectorAll('.btn-copy').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const button = e.currentTarget;
      const index = parseInt(button.dataset.index);
      copyToClipboard(currentResults[index].text, button);
    });
  });

  resultsSection.classList.remove('hidden');

  // キャプション表示
  if (currentCaption) {
    captionText.textContent = currentCaption;
    captionSection.classList.remove('hidden');
  }
}

// キャプションコピー
copyCaptionBtn?.addEventListener('click', () => {
  copyToClipboard(currentCaption, copyCaptionBtn);
});

// クリップボードにコピー
async function copyToClipboard(text, button) {
  try {
    await navigator.clipboard.writeText(text);

    // ボタンの見た目を変更
    const span = button.querySelector('span');
    const originalText = span.textContent;
    span.textContent = 'コピー済み';
    button.classList.add('copied');

    // トースト表示
    showToast('コピーしました');

    setTimeout(() => {
      span.textContent = originalText;
      button.classList.remove('copied');
    }, 2000);
  } catch (error) {
    logError('Copy failed:', error);
    showToast('コピーに失敗しました');
  }
}

// HTMLエスケープ
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
