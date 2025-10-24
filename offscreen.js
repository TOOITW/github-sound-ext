console.log('[GHSound] Offscreen loaded');

// 單例音源，避免重複載入
let audio;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'OFFSCREEN_PLAY') {
    try {
      if (!audio) {
        audio = new Audio(chrome.runtime.getURL('sounds/success.mp3'));
        audio.volume = 0.9;
      }
      audio.currentTime = 0; // 連續觸發時從頭播
      audio.play().catch(err => console.error('[GHSound] play error', err));
    } catch (e) {
      console.error('[GHSound] offscreen error', e);
    }
  }
});
