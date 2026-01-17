// Gemini API連携用Service Worker

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

// ログメッセージを保存（sidepanelに転送用）
let logMessages = [];

// メッセージリスナー
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // content.jsからのログを受け取る
  if (request.action === 'log') {
    const logEntry = { source: 'content', message: request.message, time: Date.now() };
    logMessages.push(logEntry);
    // 最新100件のみ保持
    if (logMessages.length > 100) logMessages.shift();
    return false;
  }

  // sidepanelからログ取得リクエスト
  if (request.action === 'getLogs') {
    sendResponse({ logs: logMessages });
    logMessages = []; // 送信後クリア
    return false;
  }

  // OCR処理
  if (request.action === 'processOCR') {
    processImageOCR(request.imageUrl, request.apiKey, request.readingDirection, request.tabId, request.base64Image)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
});

// 読み取り方向に応じたプロンプトを生成
function buildPrompt(direction) {
  let directionInstruction = '';

  if (direction === 'vertical') {
    directionInstruction = '縦書きのテキストとして、上から下、右から左の順序で読み取ってください。';
  } else if (direction === 'horizontal') {
    directionInstruction = '横書きのテキストとして、左から右、上から下の順序で読み取ってください。';
  } else {
    directionInstruction = 'テキストの方向（縦書き・横書き）を自動で判断して読み取ってください。';
  }

  return `この画像に含まれるテキストを全て抽出してください。
${directionInstruction}
テキストのみを出力し、余計な説明は不要です。
テキストが見つからない場合は「テキストなし」と回答してください。
レイアウトや改行はできるだけ元の構成を保持してください。`;
}

// ログをsidepanelに送信するヘルパー
function logToSidepanel(message) {
  const logEntry = { source: 'content', message: '[SW] ' + message, time: Date.now() };
  logMessages.push(logEntry);
  if (logMessages.length > 100) logMessages.shift();
  console.log('[ServiceWorker]', message);
}

// 画像をOCR処理
async function processImageOCR(imageUrl, apiKey, readingDirection = 'auto', tabId = null, preloadedBase64 = null) {
  try {
    logToSidepanel('OCR start: ' + imageUrl.substring(imageUrl.length - 30));
    logToSidepanel('API Key exists: ' + (apiKey ? 'YES' : 'NO'));
    logToSidepanel('Preloaded base64: ' + (preloadedBase64 ? 'YES (' + preloadedBase64.length + ')' : 'NO'));

    let base64Image;

    // 既に取得済みのBase64があればそれを使用
    if (preloadedBase64) {
      base64Image = preloadedBase64;
      logToSidepanel('Using preloaded base64');
    } else if (tabId) {
      // tabIdが指定されている場合は、Content Script経由で画像を取得
      logToSidepanel('Fetching via Content Script (tabId=' + tabId + ')');
      try {
        const response = await chrome.tabs.sendMessage(tabId, {
          action: 'fetchImageBase64',
          imageUrl: imageUrl
        });

        if (response && response.success && response.base64) {
          base64Image = response.base64;
          logToSidepanel('Content Script fetch success, length=' + base64Image.length);
        } else {
          throw new Error(response?.error || 'Content Scriptからの画像取得に失敗');
        }
      } catch (contentError) {
        logToSidepanel('Content Script fetch failed: ' + contentError.message);
        // フォールバック: Service Workerで直接取得を試みる
        logToSidepanel('Trying direct fetch as fallback...');
        base64Image = await fetchImageAsBase64(imageUrl);
      }
    } else {
      // 従来の方法: Service Workerで直接取得
      base64Image = await fetchImageAsBase64(imageUrl);
    }

    logToSidepanel('Base64 image length: ' + base64Image.length);

    const prompt = buildPrompt(readingDirection);

    const response = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            {
              inlineData: {
                mimeType: 'image/jpeg',
                data: base64Image
              }
            }
          ]
        }],
        generationConfig: {
          temperature: 0.1,
          topK: 1,
          topP: 1,
          maxOutputTokens: 4096
        }
      })
    });

    logToSidepanel('API response status: ' + response.status);

    if (!response.ok) {
      const errorData = await response.json();
      const errorMsg = errorData.error?.message || `API Error: ${response.status}`;
      logToSidepanel('API Error: ' + errorMsg);
      throw new Error(errorMsg);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    logToSidepanel('OCR result length: ' + text.length);

    return { success: true, text: text.trim() };

  } catch (error) {
    console.error('OCR Error:', error);
    logToSidepanel('OCR Error: ' + error.message);
    return { success: false, error: error.message };
  }
}

// 画像URLからBase64を取得
async function fetchImageAsBase64(imageUrl) {
  try {
    const response = await fetch(imageUrl);
    if (!response.ok) throw new Error('画像の取得に失敗しました');

    const blob = await response.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64 = reader.result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch (error) {
    console.error('Image fetch error:', error);
    throw new Error('画像の読み込みに失敗しました');
  }
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('Instagram OCR Extension installed');
});

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId });
});
