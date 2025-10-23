// content_script.js
(() => {
  // utils
  const playSound = async () => {
    // 取得檔案 url
    const url = chrome.runtime.getURL('sounds/success.mp3');
    const audio = new Audio(url);
    // 若瀏覽器擋 autoplay，audio.play() 可能被拒，這時應先要求 user 互動來啟用（popup）
    try {
      await audio.play();
      console.log('[GHSound] play!');
    } catch (err) {
      console.warn('[GHSound] autoplay blocked:', err);
      // 可以顯示 UI 或儲存狀態，讓 user 在 popup 點擊啟用
    }
  };

  // 避免重複觸發
  let lastSeen = new Set();

  // 檢查 Actions 頁面上 workflow run 的成功標記（簡單範例）
  function scanForActionSuccess(root = document) {
    // 這邊 selector 可能隨 GitHub UI 變動，保留多個 fallback
    const successNodes = root.querySelectorAll(
      'span.State--success, .State--green, .Label--green, .hx_flow_state_label[title="success"]'
    );
    successNodes.forEach(n => {
      const key = n.textContent + '|' + (n.closest('li')?.dataset?.runId || n.innerText);
      if (!lastSeen.has(key)) {
        lastSeen.add(key);
        console.log('[GHSound] detected success node', n);
        playSound();
      }
    });
  }

  // 偵測 PR 合併（example: PR 頁面上會出現 "Merged" 標籤）
  function scanForPrMerged(root = document) {
    const mergedBadge = root.querySelector('span.State--merged, .State--purple, .merge-branch-action .text-green');
    if (mergedBadge) {
      const key = 'pr-merged|' + document.location.href;
      if (!lastSeen.has(key)) {
        lastSeen.add(key);
        console.log('[GHSound] PR merged detected');
        playSound();
      }
    }
  }

  // 使用 MutationObserver 監聽頁面變更（適用 SPA）
  const observer = new MutationObserver(muts => {
    for (const m of muts) {
      if (m.addedNodes && m.addedNodes.length) {
        scanForActionSuccess(m.target || document);
        scanForPrMerged(m.target || document);
      }
    }
  });

  // 初次掃描
  window.addEventListener('load', () => {
    scanForActionSuccess();
    scanForPrMerged();
  });

  // 啟動 observer（監聽整個 body）
  const root = document.body;
  if (root) {
    observer.observe(root, { childList: true, subtree: true });
  }

  // 也監聽 history pushState（單頁應用跳頁）
  const _pushState = history.pushState;
  history.pushState = function () {
    _pushState.apply(this, arguments);
    // 延遲掃描，等 DOM 更新
    setTimeout(() => {
      scanForActionSuccess();
      scanForPrMerged();
    }, 800);
  };

  // 可接收 background 或 popup 的訊息以播放音效
  chrome.runtime.onMessage.addListener((msg, sender, resp) => {
    if (msg && msg.type === 'PLAY_SOUND') {
      playSound();
    }
  });
})();
