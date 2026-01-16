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
    processImageOCR(request.imageUrl, request.apiKey)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
});

// 画像をOCR処理
async function processImageOCR(imageUrl, apiKey) {
  try {
    const base64Image = await fetchImageAsBase64(imageUrl);

    const response = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            {
              text: `この画像に含まれるテキストを全て抽出してください。
テキストのみを出力し、余計な説明は不要です。
テキストが見つからない場合は「テキストなし」と回答してください。
レイアウトや改行はできるだけ元の構成を保持してください。`
            },
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

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error?.message || `API Error: ${response.status}`);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    return { success: true, text: text.trim() };

  } catch (error) {
    console.error('OCR Error:', error);
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
