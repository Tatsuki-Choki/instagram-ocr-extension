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
});

async function getPostData() {
  // キャプションを先に取得
  const caption = getCaption();
  log('Caption: ' + (caption ? caption.substring(0, 40) + '...' : 'NONE'));

  // 画像を収集
  const images = await collectAllImages();

  return { images, caption };
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

async function collectAllImages() {
  const collectedUrls = [];
  const maxImages = 20;

  // カルーセル判定
  let nextBtn = document.querySelector('button[aria-label="次へ"], button[aria-label="Next"]');
  let prevBtn = document.querySelector('button[aria-label="戻る"], button[aria-label="Go back"]');
  const isCarousel = !!(nextBtn || prevBtn);

  if (!isCarousel) {
    log('Single image post');
    const img = findCenteredImage();
    if (img) {
      collectedUrls.push(img);
      log('Added single image');
    }
    return collectedUrls;
  }

  log('Carousel detected');

  // 1枚目に戻る
  await goToFirstSlide();

  // 1枚目を取得
  await sleep(500);
  let currentImg = findCenteredImage();
  if (currentImg) {
    collectedUrls.push(currentImg);
    log('Image 1: ' + getShortUrl(currentImg));
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
    const prevImg = currentImg;

    // 次へをクリック
    nextBtn.click();
    log('Click ' + safetyCounter);

    // 画像が切り替わるまで待つ
    const newImg = await waitForNewImage(prevImg, collectedUrls);

    if (newImg) {
      collectedUrls.push(newImg);
      currentImg = newImg;
      log('Image ' + collectedUrls.length + ': ' + getShortUrl(newImg));
    } else {
      log('Click ' + safetyCounter + ': Image not changed or duplicate');
    }

    // 上限チェック
    if (collectedUrls.length >= maxImages) {
      log('Reached max images limit');
      break;
    }
  }

  // 最終確認: 現在表示中の画像が未収集なら追加
  await sleep(500);
  const finalImg = findCenteredImage();
  if (finalImg && !collectedUrls.includes(finalImg)) {
    collectedUrls.push(finalImg);
    log('Final image added: ' + collectedUrls.length + ': ' + getShortUrl(finalImg));
  }

  log('=== Total: ' + collectedUrls.length + ' images ===');
  return collectedUrls;
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
  const container = document.querySelector('main') || document.querySelector('article');
  if (!container) return '';

  // 方法1: URLからユーザー名を取得（/username/p/xxx/ 形式）
  let postAuthor = null;
  const urlMatch1 = window.location.pathname.match(/^\/([^\/]+)\/(?:p|reel)\//);
  if (urlMatch1) {
    postAuthor = urlMatch1[1];
  }

  // 方法2: URLに含まれない場合、ページ内から投稿者を特定
  // 投稿日付リンク（/username/p/xxx/）から投稿者を取得
  if (!postAuthor) {
    const postId = window.location.pathname.match(/\/(?:p|reel)\/([^\/]+)/)?.[1];
    if (postId) {
      const dateLink = container.querySelector(`a[href*="/${postId}/"]`);
      if (dateLink) {
        const hrefMatch = dateLink.getAttribute('href')?.match(/^\/([^\/]+)\/(?:p|reel)\//);
        if (hrefMatch) {
          postAuthor = hrefMatch[1];
        }
      }
    }
  }

  log('DEBUG: Post author: ' + postAuthor);

  // h1タグを確認（稀にキャプションがh1に入っている場合）
  const h1 = container.querySelector('h1');
  if (h1) {
    const text = h1.textContent?.trim();
    if (text && text.length > 20 && !text.includes('の他の投稿')) {
      log('DEBUG: Caption from h1');
      return cleanCaption(text);
    }
  }

  // 方法3: 投稿者リンクの後にあるキャプションを探す
  if (postAuthor) {
    const authorLinks = container.querySelectorAll(`a[href="/${postAuthor}/"]`);
    log('DEBUG: Found ' + authorLinks.length + ' author links');

    for (const authorLink of authorLinks) {
      // このリンクがコメントセクション内かどうかチェック
      // コメントセクション内のauthorLinkはスキップ（コメントリンク /c/ が近くにある）
      const parentDiv = authorLink.closest('div');
      if (parentDiv) {
        // 兄弟要素にコメントリンクがあればスキップ
        const hasCommentLink = parentDiv.querySelector('a[href*="/c/"]');
        if (hasCommentLink) {
          continue;
        }
      }

      // authorLinkから上に辿ってキャプションを探す
      let current = authorLink.parentElement;
      for (let depth = 0; depth < 8 && current; depth++) {
        // 兄弟要素を順番にチェック
        let sibling = current.nextElementSibling;
        while (sibling) {
          // コメントリンクが見つかったら終了
          if (sibling.querySelector && sibling.querySelector('a[href*="/c/"]')) {
            break;
          }

          // テキストを取得
          const text = sibling.textContent?.trim();

          // キャプションの条件チェック
          if (text && text.length > 20 && text.length < 3000) {
            // 除外パターン
            const isExcluded =
              text.includes('Photo by') ||
              text.includes('Photo shared by') ||
              /^20\d{2}年\d{1,2}月\d{1,2}日$/.test(text) ||
              /^\d+日前$/.test(text) ||
              /^\d+週間前$/.test(text) ||
              /^\d+か月前$/.test(text) ||
              text === '編集済み' ||
              text === 'フォローする' ||
              /^いいね！?\d*件?$/.test(text) ||
              text.includes('の他の投稿');

            if (!isExcluded) {
              // ハッシュタグリンクを含む場合は高確率でキャプション
              const hasHashtag = sibling.querySelector && sibling.querySelector('a[href*="/explore/tags/"]');
              if (hasHashtag || text.length > 50) {
                log('DEBUG: Caption found after author link, length=' + text.length);
                return cleanCaption(text);
              }
            }
          }

          sibling = sibling.nextElementSibling;
        }

        current = current.parentElement;
      }
    }
  }

  // 方法4: 最初のコメントリンクより前にある長いテキストを探す
  const firstCommentLink = container.querySelector('a[href*="/c/"]');
  if (firstCommentLink) {
    // DOMツリー順でfirstCommentLinkより前にある要素を探す
    const allElements = container.querySelectorAll('*');
    let captionCandidate = '';

    for (const el of allElements) {
      // firstCommentLinkに到達したら終了
      if (el === firstCommentLink || el.contains(firstCommentLink)) {
        break;
      }

      // 位置比較
      const position = el.compareDocumentPosition(firstCommentLink);
      if (!(position & Node.DOCUMENT_POSITION_FOLLOWING)) {
        continue; // elがfirstCommentLinkより後ろ
      }

      // リンク、ボタン内はスキップ
      if (el.closest('a') || el.closest('button')) continue;

      // 子要素がなく、テキストを直接持つ要素
      if (el.children.length === 0 || el.querySelectorAll('a[href*="/explore/tags/"]').length > 0) {
        const text = el.textContent?.trim();
        if (text && text.length > captionCandidate.length && text.length > 30 && text.length < 3000) {
          const isExcluded =
            text.includes('Photo by') ||
            /^20\d{2}年/.test(text) ||
            /^\d+日前/.test(text) ||
            text.includes('いいね') ||
            text.includes('の他の投稿');

          if (!isExcluded) {
            captionCandidate = text;
          }
        }
      }
    }

    if (captionCandidate) {
      log('DEBUG: Caption found before comments, length=' + captionCandidate.length);
      return cleanCaption(captionCandidate);
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
