// Instagram投稿から画像とキャプションを取得するContent Script

// ログをbackground経由でsidepanelに送る
function log(msg) {
  console.log('[Content]', msg);
  chrome.runtime.sendMessage({ action: 'log', message: msg }).catch(() => {});
}

// メッセージリスナー
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getImages') {
    log('=== getImages START ===');
    getPostData()
      .then(data => {
        log('=== RESULT: Images=' + data.images.length + ', Caption=' + (data.caption ? 'YES' : 'NO') + ' ===');
        sendResponse({ success: true, ...data });
      })
      .catch(error => {
        log('ERROR: ' + error.message);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  // 画像をBase64に変換（Content Script内で実行）
  if (request.action === 'fetchImageBase64') {
    log('Fetching image as base64...');
    fetchImageAsBase64InPage(request.imageUrl)
      .then(base64 => {
        log('Base64 fetch success, length=' + base64.length);
        sendResponse({ success: true, base64 });
      })
      .catch(error => {
        log('Base64 fetch error: ' + error.message);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }
});

// ページ内で画像をBase64に変換
async function fetchImageAsBase64InPage(imageUrl) {
  // 方法1: 既にページに読み込まれている画像要素からCanvasで取得
  const existingImg = findLoadedImageByUrl(imageUrl);
  if (existingImg) {
    log('Found existing img element, using canvas method');
    try {
      const base64 = await getBase64FromImageElement(existingImg);
      if (base64) {
        log('Canvas method success');
        return base64;
      }
    } catch (e) {
      log('Canvas method failed: ' + e.message);
    }
  }

  // 方法2: 新しいImage要素を作成してcrossOriginで読み込む
  log('Trying new Image with crossOrigin');
  try {
    const base64 = await loadImageWithCrossOrigin(imageUrl);
    if (base64) {
      log('crossOrigin method success');
      return base64;
    }
  } catch (e) {
    log('crossOrigin method failed: ' + e.message);
  }

  // 方法3: fetchで試す（フォールバック）
  log('Trying fetch as last resort');
  try {
    const response = await fetch(imageUrl, { credentials: 'include' });
    if (!response.ok) throw new Error('fetch failed: ' + response.status);

    const blob = await response.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64 = reader.result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = () => reject(new Error('Base64変換に失敗'));
      reader.readAsDataURL(blob);
    });
  } catch (error) {
    log('All methods failed: ' + error.message);
    throw new Error('画像の取得に失敗しました');
  }
}

// URLに一致する既存のimg要素を探す
function findLoadedImageByUrl(imageUrl) {
  const imgs = document.querySelectorAll('img');
  for (const img of imgs) {
    // srcまたはsrcsetにURLが含まれているか確認
    if (img.src === imageUrl || img.currentSrc === imageUrl) {
      if (img.complete && img.naturalWidth > 0) {
        return img;
      }
    }
    // srcsetから探す
    if (img.srcset && img.srcset.includes(imageUrl)) {
      if (img.complete && img.naturalWidth > 0) {
        return img;
      }
    }
  }
  return null;
}

// img要素からCanvasを使ってBase64を取得
async function getBase64FromImageElement(img) {
  return new Promise((resolve, reject) => {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;

      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);

      // toDataURLはCORS制限により失敗する可能性がある
      const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
      const base64 = dataUrl.split(',')[1];
      resolve(base64);
    } catch (e) {
      reject(new Error('Canvas export failed: ' + e.message));
    }
  });
}

// crossOrigin属性を使って新しく画像を読み込む
async function loadImageWithCrossOrigin(imageUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';

    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;

        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);

        const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
        const base64 = dataUrl.split(',')[1];
        resolve(base64);
      } catch (e) {
        reject(new Error('Canvas export failed: ' + e.message));
      }
    };

    img.onerror = () => {
      reject(new Error('Image load failed'));
    };

    // タイムアウト
    setTimeout(() => reject(new Error('Image load timeout')), 10000);

    img.src = imageUrl;
  });
}

async function getPostData() {
  // キャプションを先に取得
  const caption = getCaption();
  log('Caption: ' + (caption ? caption.substring(0, 40) + '...' : 'NONE'));

  // 画像を収集（Base64データも含む）
  const imageDataList = await collectAllImagesWithBase64();

  return { images: imageDataList.map(d => d.url), imageDataList, caption };
}

// カルーセルの総枚数を取得（インジケーターのドットから）
function getCarouselTotalCount() {
  // 方法1: インジケーターのドットを数える
  const indicators = document.querySelectorAll('div[style*="transform"] > div > div');
  if (indicators.length > 1) {
    return indicators.length;
  }

  // 方法2: リストアイテムを数える（カルーセル内）
  const listItems = document.querySelectorAll('main ul > li, main [role="list"] > [role="listitem"]');
  if (listItems.length > 0) {
    return listItems.length;
  }

  // 方法3: 不明な場合は20を上限とする
  return 20;
}

// 画像収集時にBase64も取得する（画像表示中にCanvasでキャプチャ）
async function collectAllImagesWithBase64() {
  const collectedData = []; // { url, base64 }
  const collectedUrls = new Set();
  const maxImages = 20;

  // カルーセル判定
  let nextBtn = document.querySelector('button[aria-label="次へ"], button[aria-label="Next"]');
  let prevBtn = document.querySelector('button[aria-label="戻る"], button[aria-label="Go back"]');
  const isCarousel = !!(nextBtn || prevBtn);

  if (!isCarousel) {
    log('Single image post');
    const imgData = await findCenteredImageWithBase64();
    if (imgData) {
      collectedData.push(imgData);
      log('Added single image (base64: ' + (imgData.base64 ? 'YES' : 'NO') + ')');
    }
    return collectedData;
  }

  log('Carousel detected');

  // 1枚目に戻る
  await goToFirstSlide();

  // 1枚目を取得
  await sleep(500);
  let currentData = await findCenteredImageWithBase64();
  if (currentData && !collectedUrls.has(currentData.url)) {
    collectedData.push(currentData);
    collectedUrls.add(currentData.url);
    log('Image 1: ' + getShortUrl(currentData.url) + ' (base64: ' + (currentData.base64 ? 'YES' : 'NO') + ')');
  } else {
    log('Image 1: FAILED TO GET');
  }

  // 次へボタンをクリックして残りを取得
  let safetyCounter = 0;
  const maxClicks = 25;

  while (safetyCounter < maxClicks) {
    safetyCounter++;

    // 次へボタンを確認
    nextBtn = document.querySelector('button[aria-label="次へ"], button[aria-label="Next"]');

    if (!nextBtn) {
      log('No next button - reached last slide');
      break;
    }

    // クリック前の画像URLを記録
    const prevUrl = currentData?.url;

    // 次へをクリック
    nextBtn.click();
    log('Click ' + safetyCounter);

    // 画像が切り替わるまで待つ
    const newData = await waitForNewImageWithBase64(prevUrl, collectedUrls);

    if (newData) {
      collectedData.push(newData);
      collectedUrls.add(newData.url);
      currentData = newData;
      log('Image ' + collectedData.length + ': ' + getShortUrl(newData.url) + ' (base64: ' + (newData.base64 ? 'YES' : 'NO') + ')');
    } else {
      log('Click ' + safetyCounter + ': Image not changed or duplicate');
    }

    // 上限チェック
    if (collectedData.length >= maxImages) {
      log('Reached max images limit');
      break;
    }
  }

  // 最終確認: 現在表示中の画像が未収集なら追加
  await sleep(500);
  const finalData = await findCenteredImageWithBase64();
  if (finalData && !collectedUrls.has(finalData.url)) {
    collectedData.push(finalData);
    log('Final image added: ' + collectedData.length + ': ' + getShortUrl(finalData.url));
  }

  log('=== Total: ' + collectedData.length + ' images ===');
  return collectedData;
}

// 後方互換性のため残す
async function collectAllImages() {
  const dataList = await collectAllImagesWithBase64();
  return dataList.map(d => d.url);
}

// 1枚目に戻る
async function goToFirstSlide() {
  let backCount = 0;
  const maxBack = 25;

  while (backCount < maxBack) {
    const backBtn = document.querySelector('button[aria-label="戻る"], button[aria-label="Go back"]');
    if (!backBtn) break;

    backBtn.click();
    backCount++;
    await sleep(200);
  }

  if (backCount > 0) {
    log('Moved back ' + backCount + ' times');
    await sleep(400);
  }
}

// 新しい画像が表示されるまで待つ
async function waitForNewImage(prevImgUrl, collectedUrls) {
  const maxAttempts = 30;
  const interval = 100;

  // 最初に少し待つ（アニメーション開始を待つ）
  await sleep(300);

  for (let i = 0; i < maxAttempts; i++) {
    const currentImg = findCenteredImage();

    // 新しい画像かつ未収集の場合
    if (currentImg && currentImg !== prevImgUrl && !collectedUrls.includes(currentImg)) {
      return currentImg;
    }

    await sleep(interval);
  }

  // タイムアウト後、最後にもう一度確認
  const finalCheck = findCenteredImage();
  if (finalCheck && finalCheck !== prevImgUrl && !collectedUrls.includes(finalCheck)) {
    return finalCheck;
  }

  return null;
}

// 新しい画像が表示されるまで待つ（Base64も取得）
async function waitForNewImageWithBase64(prevImgUrl, collectedUrls) {
  const maxAttempts = 30;
  const interval = 100;

  // 最初に少し待つ（アニメーション開始を待つ）
  await sleep(300);

  for (let i = 0; i < maxAttempts; i++) {
    const data = await findCenteredImageWithBase64();

    // 新しい画像かつ未収集の場合
    if (data && data.url !== prevImgUrl && !collectedUrls.has(data.url)) {
      return data;
    }

    await sleep(interval);
  }

  // タイムアウト後、最後にもう一度確認
  const finalData = await findCenteredImageWithBase64();
  if (finalData && finalData.url !== prevImgUrl && !collectedUrls.has(finalData.url)) {
    return finalData;
  }

  return null;
}

// 画面中央に最も近い投稿画像を取得
function findCenteredImage() {
  const container = document.querySelector('main') || document.querySelector('article');
  if (!container) {
    log('DEBUG: No container found');
    return null;
  }

  const imgs = container.querySelectorAll('img');
  const viewportCenterX = window.innerWidth / 2;
  const viewportCenterY = window.innerHeight / 2;

  let bestImg = null;
  let bestDistance = Infinity;
  let debugCount = 0;

  // 毎回全画像のaltをデバッグ出力（URLが変わったらリセット）
  const currentUrl = window.location.href;
  if (window._lastLoggedUrl !== currentUrl) {
    window._lastLoggedUrl = currentUrl;
    const alts = Array.from(imgs).slice(0, 10).map(img => img.alt?.substring(0, 50) || '(empty)');
    log('DEBUG: First 10 img alts: ' + JSON.stringify(alts));
  }

  for (const img of imgs) {
    const alt = img.alt || '';
    const src = img.src || '';

    // 投稿画像を判定（複数の条件で）
    const isPostImage =
      alt.toLowerCase().includes('photo by') ||
      alt.toLowerCase().includes('photo shared by') ||
      alt.includes('の写真') ||
      (alt.includes('May be') && (alt.includes('image') || alt.includes('people')));

    if (!isPostImage) continue;

    debugCount++;

    // srcが空またはdata URIの場合はスキップ
    if (!src || src.startsWith('data:')) {
      log('DEBUG: Photo by img has no src or data URI');
      continue;
    }

    const rect = img.getBoundingClientRect();

    // 小さすぎる画像は除外（サイズを緩和: 100px以上）
    if (rect.width < 100 || rect.height < 100) {
      log('DEBUG: Photo by img too small: ' + rect.width + 'x' + rect.height);
      continue;
    }

    // 画面外の画像は除外
    if (rect.right < 0 || rect.left > window.innerWidth) {
      log('DEBUG: Photo by img off-screen');
      continue;
    }

    // 画像の中心座標
    const imgCenterX = rect.left + rect.width / 2;
    const imgCenterY = rect.top + rect.height / 2;

    // viewportの中心からの距離（X軸を重視）
    const distanceX = Math.abs(imgCenterX - viewportCenterX);
    const distanceY = Math.abs(imgCenterY - viewportCenterY);
    const distance = distanceX * 2 + distanceY; // X軸方向の距離を2倍に重み付け

    if (distance < bestDistance) {
      bestDistance = distance;
      bestImg = img;
    }
  }

  if (bestImg) {
    const url = getBestSrc(bestImg);
    log('DEBUG: Found image, src length=' + url.length);
    return url;
  }

  log('DEBUG: No centered Photo by image found (checked ' + debugCount + ' Photo by imgs out of ' + imgs.length + ' total)');
  return null;
}

// 画面中央に最も近い投稿画像を取得（Base64も取得）
async function findCenteredImageWithBase64() {
  const container = document.querySelector('main') || document.querySelector('article');
  if (!container) {
    return null;
  }

  const imgs = container.querySelectorAll('img');
  const viewportCenterX = window.innerWidth / 2;
  const viewportCenterY = window.innerHeight / 2;

  let bestImg = null;
  let bestDistance = Infinity;

  for (const img of imgs) {
    const alt = img.alt || '';
    const src = img.src || '';

    // 投稿画像を判定
    const isPostImage =
      alt.toLowerCase().includes('photo by') ||
      alt.toLowerCase().includes('photo shared by') ||
      alt.includes('の写真') ||
      (alt.includes('May be') && (alt.includes('image') || alt.includes('people')));

    if (!isPostImage) continue;

    // srcが空またはdata URIの場合はスキップ
    if (!src || src.startsWith('data:')) continue;

    const rect = img.getBoundingClientRect();

    // 小さすぎる画像は除外
    if (rect.width < 100 || rect.height < 100) continue;

    // 画面外の画像は除外
    if (rect.right < 0 || rect.left > window.innerWidth) continue;

    // 画像の中心座標
    const imgCenterX = rect.left + rect.width / 2;
    const imgCenterY = rect.top + rect.height / 2;

    const distanceX = Math.abs(imgCenterX - viewportCenterX);
    const distanceY = Math.abs(imgCenterY - viewportCenterY);
    const distance = distanceX * 2 + distanceY;

    if (distance < bestDistance) {
      bestDistance = distance;
      bestImg = img;
    }
  }

  if (!bestImg) {
    return null;
  }

  const url = getBestSrc(bestImg);

  // img要素からCanvasでBase64を取得
  let base64 = null;
  try {
    // 画像が完全に読み込まれているか確認
    if (bestImg.complete && bestImg.naturalWidth > 0) {
      const canvas = document.createElement('canvas');
      canvas.width = bestImg.naturalWidth;
      canvas.height = bestImg.naturalHeight;

      const ctx = canvas.getContext('2d');
      ctx.drawImage(bestImg, 0, 0);

      // toDataURLを試す（CORS制限があると失敗する）
      try {
        const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
        base64 = dataUrl.split(',')[1];
      } catch (e) {
        log('Canvas toDataURL failed (CORS): ' + e.message);
      }
    }
  } catch (e) {
    log('Canvas capture failed: ' + e.message);
  }

  return { url, base64, imgElement: bestImg };
}

function getShortUrl(url) {
  if (!url) return 'null';
  return '...' + url.substring(url.length - 30);
}

function getBestSrc(img) {
  // srcsetから最高解像度のURLを取得
  if (img.srcset) {
    const parts = img.srcset.split(',');
    let bestUrl = '';
    let bestWidth = 0;

    for (const part of parts) {
      const match = part.trim().match(/^(\S+)\s+(\d+)w$/);
      if (match && parseInt(match[2]) > bestWidth) {
        bestWidth = parseInt(match[2]);
        bestUrl = match[1];
      }
    }

    if (bestUrl) return bestUrl;
  }
  return img.src;
}

function getCaption() {
  // 方法1: window._sharedData から取得（Instagram伝統的な方法）
  try {
    const scripts = document.querySelectorAll('script');
    for (const script of scripts) {
      const text = script.textContent || '';
      // _sharedData を探す
      if (text.includes('window._sharedData')) {
        const match = text.match(/window\._sharedData\s*=\s*(\{.+?\});/s);
        if (match) {
          const data = JSON.parse(match[1]);
          const caption = data?.entry_data?.PostPage?.[0]?.graphql?.shortcode_media?.edge_media_to_caption?.edges?.[0]?.node?.text;
          if (caption) {
            log('DEBUG: Caption from _sharedData, length=' + caption.length);
            return caption;
          }
        }
      }
      // __additionalDataLoaded を探す
      if (text.includes('__additionalDataLoaded')) {
        const match = text.match(/__additionalDataLoaded\s*\(\s*['"][^'"]+['"]\s*,\s*(\{.+?\})\s*\)/s);
        if (match) {
          const data = JSON.parse(match[1]);
          const caption = data?.graphql?.shortcode_media?.edge_media_to_caption?.edges?.[0]?.node?.text;
          if (caption) {
            log('DEBUG: Caption from __additionalDataLoaded, length=' + caption.length);
            return caption;
          }
        }
      }
    }
  } catch (e) {
    log('DEBUG: Script parsing error: ' + e.message);
  }

  // 方法2: メタタグ（og:description）から取得
  const metaDescription = document.querySelector('meta[property="og:description"]');
  if (metaDescription) {
    const content = metaDescription.getAttribute('content');
    if (content) {
      // 形式: "XXX likes, XXX comments - ユーザー名 on Instagram: "キャプション""
      // または "ユーザー名 on Instagram: "キャプション""
      const captionMatch = content.match(/on Instagram:\s*["""](.+)["""]$/s) ||
                          content.match(/on Instagram:\s*(.+)$/s);
      if (captionMatch && captionMatch[1]) {
        const caption = captionMatch[1].trim();
        if (caption.length > 5) {
          log('DEBUG: Caption from meta og:description, length=' + caption.length);
          return caption;
        }
      }
    }
  }

  // 方法3: JSON-LDから取得
  const jsonLdScripts = document.querySelectorAll('script[type="application/ld+json"]');
  for (const script of jsonLdScripts) {
    try {
      const data = JSON.parse(script.textContent);
      if (data.caption) {
        log('DEBUG: Caption from JSON-LD, length=' + data.caption.length);
        return data.caption;
      }
      if (data.articleBody) {
        log('DEBUG: Caption from JSON-LD articleBody, length=' + data.articleBody.length);
        return data.articleBody;
      }
    } catch (e) {
      // パースエラーは無視
    }
  }

  const container = document.querySelector('main') || document.querySelector('article');
  if (!container) return '';

  // 方法4: img要素のalt属性からキャプションを探す
  // Instagramは投稿画像のaltにキャプション情報を含めることがある
  const imgs = container.querySelectorAll('img');
  for (const img of imgs) {
    const alt = img.alt || '';
    // キャプションを含むaltパターンを探す（改行を含む長いテキスト）
    if (alt.length > 100 && alt.includes('\n')) {
      // "Photo by..."で始まらない、実際のキャプションテキスト
      if (!alt.startsWith('Photo by') && !alt.includes('のプロフィール写真')) {
        log('DEBUG: Caption from img alt, length=' + alt.length);
        return alt;
      }
    }
  }

  // 方法3: URLからユーザー名を取得してDOMから探す
  let postAuthor = null;

  // URL形式: /username/p/xxx/ または /p/xxx/ または /reel/xxx/
  const urlMatch1 = window.location.pathname.match(/^\/([^\/]+)\/(?:p|reel)\//);
  if (urlMatch1) {
    postAuthor = urlMatch1[1];
  }

  // /p/xxx/ 形式の場合、ページ内から投稿者を探す
  if (!postAuthor) {
    const postId = window.location.pathname.match(/\/(?:p|reel)\/([^\/]+)/)?.[1];
    if (postId) {
      // 投稿者リンクを探す（プロフィール画像の横にあるユーザー名）
      const headerLink = container.querySelector('header a[href^="/"][role="link"]');
      if (headerLink) {
        const href = headerLink.getAttribute('href');
        const match = href?.match(/^\/([^\/]+)\/?$/);
        if (match) {
          postAuthor = match[1];
        }
      }

      // 方法2: 投稿日付リンクから取得
      if (!postAuthor) {
        const dateLink = container.querySelector(`a[href*="/${postId}/"]`);
        if (dateLink) {
          const hrefMatch = dateLink.getAttribute('href')?.match(/^\/([^\/]+)\/(?:p|reel)\//);
          if (hrefMatch) {
            postAuthor = hrefMatch[1];
          }
        }
      }
    }
  }

  log('DEBUG: Post author: ' + postAuthor);
  log('DEBUG: URL pathname: ' + window.location.pathname);

  // 方法4: span要素からキャプションを探す（Instagram 2024-2025構造）
  // キャプションは通常、投稿者名の近くのspan要素に含まれる
  const allSpans = container.querySelectorAll('span');
  let bestCaption = '';

  for (const span of allSpans) {
    const text = span.textContent?.trim();
    if (!text || text.length < 20 || text.length > 5000) continue;

    // 除外パターン
    const isExcluded =
      text.includes('Photo by') ||
      text.includes('Photo shared by') ||
      /^20\d{2}年\d{1,2}月\d{1,2}日/.test(text) ||
      /^\d+日前$/.test(text) ||
      /^\d+週間前$/.test(text) ||
      /^\d+か月前$/.test(text) ||
      /^\d+時間前$/.test(text) ||
      text === '編集済み' ||
      text === 'フォローする' ||
      text === 'フォロー中' ||
      /^いいね！?\d*件?$/.test(text) ||
      text.includes('の他の投稿') ||
      text.includes('件のコメント') ||
      text.includes('コメントを見る') ||
      text.includes('コメントを追加') ||
      /^(返信|いいね|翻訳を見る)$/.test(text);

    if (isExcluded) continue;

    // ハッシュタグを含む場合は高確率でキャプション
    const hasHashtag = span.querySelector('a[href*="/explore/tags/"]') ||
                       text.includes('#');

    // より長いテキストを優先（ただしハッシュタグがある場合は優先度UP）
    if (hasHashtag && text.length > 30) {
      log('DEBUG: Caption with hashtag found, length=' + text.length);
      return cleanCaption(text);
    }

    if (text.length > bestCaption.length && text.length > 50) {
      bestCaption = text;
    }
  }

  if (bestCaption) {
    log('DEBUG: Caption from span search, length=' + bestCaption.length);
    return cleanCaption(bestCaption);
  }

  // 方法5: h1タグを確認
  const h1 = container.querySelector('h1');
  if (h1) {
    const text = h1.textContent?.trim();
    if (text && text.length > 20 && !text.includes('の他の投稿')) {
      log('DEBUG: Caption from h1');
      return cleanCaption(text);
    }
  }

  log('DEBUG: No caption found');
  return '';
}

function cleanCaption(text) {
  if (!text) return '';
  // 先頭のユーザー名パターンを除去
  return text.replace(/^[a-zA-Z0-9._]+\s+/, '').trim();
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

log('Content script loaded');
