// background.js (MV3 service worker) — optimized
console.log('[GHSound] SW loaded');

/** Storage keys */
const TOKEN_KEY    = 'github_pat';
const REPOS_KEY    = 'watch_repos';
const LAST_RUN_KEY = 'last_run_map';     // { [repo]: { id, conclusion } }
const ETAG_KEY     = 'etag_map';         // { [repo]: 'W/"etag..."' }
const BACKOFF_KEY  = 'backoff_until';    // { [repo]: epochSeconds }

/** Polling */
const POLL_SECS = 60;                    // Chrome alarms 最小 1 分鐘

let isPolling = false;

/** ───────────────── Popup → SW：設定已儲存 ───────────────── */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'CONFIG_SAVED') {
    console.log('[GHSound] CONFIG_SAVED received');
    boot(true);
    sendResponse?.({ ok: true });
  }
  return false;
});

/** ───────────────── 安裝/啟動 ───────────────── */
chrome.runtime.onInstalled.addListener(() => boot());
chrome.runtime.onStartup.addListener(() => boot());

/** ───────────────── 通知點擊（單例） ───────────────── */
const notifTarget = new Map(); // notifId -> url
if (chrome.notifications?.onClicked) {
  chrome.notifications.onClicked.addListener((id) => {
    const url = notifTarget.get(id);
    if (url) {
      chrome.tabs.create({ url });
      chrome.notifications.clear(id);
      notifTarget.delete(id);
    }
  });
}

/** ───────────────── Alarms 喚醒 ───────────────── */
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'gh-poll') tick();
});

/** ───────────────── Boot ───────────────── */
async function boot(restart = false) {
  const { [TOKEN_KEY]: token, [REPOS_KEY]: repos = [] } =
    await chrome.storage.local.get([TOKEN_KEY, REPOS_KEY]);

  console.log('[GHSound] boot settings:', { hasToken: !!token, repos });

  if (!token || !repos.length) {
    console.warn('[GHSound] missing token or repos, stop polling');
    await chrome.alarms.clear('gh-poll');
    isPolling = false;
    return;
  }

  if (restart) {
    await chrome.alarms.clear('gh-poll');
    isPolling = false;
  }

  if (!isPolling) {
    console.log('[GHSound] start polling');
    isPolling = true;
    await tick(); // 先跑一次
    chrome.alarms.create('gh-poll', {
      periodInMinutes: Math.max(1, POLL_SECS / 60),
    });
  }
}

/** ───────────────── Tick (ETag + 退避) ───────────────── */
async function tick() {
  const store = await chrome.storage.local.get([
    TOKEN_KEY, REPOS_KEY, LAST_RUN_KEY, ETAG_KEY, BACKOFF_KEY,
  ]);

  const token    = store[TOKEN_KEY];
  const repos    = store[REPOS_KEY] || [];
  const lastMap  = store[LAST_RUN_KEY] || {};
  const etagMap  = store[ETAG_KEY]     || {};
  const backoff  = store[BACKOFF_KEY]  || {};

  const now = () => Math.floor(Date.now() / 1000);

  for (const repo of repos) {
    try {
      // 若 repo 正在退避中，直接跳過
      const until = backoff[repo];
      if (until && now() < until) {
        // 可視需要：console.log('[GHSound] backoff', repo, 'until', until);
        continue;
      }

      const url = `https://api.github.com/repos/${repo}/actions/runs?per_page=1`;
      const headers = {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
      };
      if (etagMap[repo]) headers['If-None-Match'] = etagMap[repo];

      console.log('[GHSound] checking', url);
      const res = await fetch(url, { headers });

      // 304：內容沒變，最省
      if (res.status === 304) {
        // 小抖動，避免全倉同時打
        await sleep(120);
        continue;
      }

      if (!res.ok) {
        console.warn('[GHSound] API error', repo, res.status);

        // 簡單退避策略：403/429 依 Retry-After 或 RateLimit Reset
        if (res.status === 403 || res.status === 429) {
          const retryAfter = parseInt(res.headers.get('Retry-After') || '0', 10);
          const resetEpoch = parseInt(res.headers.get('X-RateLimit-Reset') || '0', 10);
          const waitSec = retryAfter || Math.max(0, resetEpoch - now()) || 60; // fallback 60s
          backoff[repo] = now() + waitSec;
          await chrome.storage.local.set({ [BACKOFF_KEY]: backoff });
          console.warn('[GHSound] backoff set', repo, waitSec, 'sec');
        }
        await sleep(120);
        continue;
      }

      // 200：更新 ETag
      const etag = res.headers.get('ETag');
      if (etag) {
        etagMap[repo] = etag;
        await chrome.storage.local.set({ [ETAG_KEY]: etagMap });
      }

      const data = await res.json();
      const run = data?.workflow_runs?.[0];
      if (!run) {
        // 沒 run：不常見，但記錄一下
        console.log('[GHSound] no runs for', repo);
        await sleep(120);
        continue;
      }

      const prev = lastMap[repo]; // { id, conclusion } | undefined
      const isNewRun = !prev || prev.id !== run.id;

      // 1) 新 run 且一上來就是 success
      // 2) 同 run 從非 success → success
      const becameSuccess =
        run.conclusion === 'success' &&
        (isNewRun || (prev && prev.id === run.id && prev.conclusion !== 'success'));

      console.log('[GHSound] latest', repo, {
        id: run.id,
        status: run.status,
        conclusion: run.conclusion,
        prev: prev || null,
        isNewRun,
        becameSuccess,
      });

      if (becameSuccess) {
        setBadgeSuccess();
        notifyAndPlay(repo, run);
      }

      // 記錄目前看到的 run 狀態
      lastMap[repo] = { id: run.id, conclusion: run.conclusion };
      await chrome.storage.local.set({ [LAST_RUN_KEY]: lastMap });

      // 每 repo 輕微延遲，削尖峰
      await sleep(120);
    } catch (e) {
      console.error('[GHSound] tick error', repo, e);
      // 發生例外時，也避免緊接著重打
      await sleep(200);
    }
  }
}

/** 微延遲（毫秒） */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** ───────────────── Offscreen ───────────────── */
async function ensureOffscreen() {
  try {
    if (!chrome.offscreen) return; // 舊版瀏覽器無此 API
    if (chrome.offscreen.hasDocument) {
      const has = await chrome.offscreen.hasDocument();
      if (has) return;
    }
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Play a sound when a GitHub Actions run succeeds.',
    });
  } catch (e) {
    // 即使 offscreen 無法建立，仍可靠 content script 播放或僅顯示通知
    console.warn('[GHSound] ensureOffscreen failed:', e);
  }
}

/** ───────────────── 成功時：聲音 + 通知 + Badge ───────────────── */
async function notifyAndPlay(repo, run) {
  console.log('[GHSound] SUCCESS 🎉', repo, run.id);

  // 1) 播聲（offscreen）
  try {
    await ensureOffscreen();
    await chrome.runtime.sendMessage({ type: 'OFFSCREEN_PLAY' });
  } catch (e) {
    console.warn('[GHSound] offscreen play failed:', e);
  }

  // 2) 有開著 github 分頁就廣播（可選，頁內 toast/再播）
  chrome.tabs.query({}, (tabs) => {
    for (const t of tabs) {
      if (t.url?.includes('github.com')) {
        chrome.tabs.sendMessage(
          t.id,
          { type: 'PLAY_SOUND', repo, run },
          () => void chrome.runtime.lastError // 吞錯
        );
      }
    }
  });

  // 3) 系統通知
  if (chrome.notifications?.create) {
    const notifId = `gh-success:${repo}:${run.id}`;
    const url = run.html_url || `https://github.com/${repo}/actions/runs/${run.id}`;
    notifTarget.set(notifId, url);

    chrome.notifications.create(notifId, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: `✅ Actions success: ${repo}`,
      message: run.name ? `Workflow: ${run.name}` : `Run #${run.id}`,
      priority: 2,
    });
  }
}

/** ───────────────── Badge ───────────────── */
async function setBadgeSuccess() {
  try {
    await chrome.action.setBadgeText({ text: 'OK' });
    await chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 6000);
  } catch {}
}
