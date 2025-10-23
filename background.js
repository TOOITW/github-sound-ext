// background.js (service worker)
let pollingIntervalMin = 60; // 秒
let tokenStorageKey = 'github_pat';
let watchListKey = 'watch_repos'; // e.g. ["owner/repo"]

// 範例：把要監控的 repo 放在 chrome.storage（也可用 popup 介面讓使用者設定）
chrome.storage.local.get([tokenStorageKey, watchListKey], async (items) => {
  const token = items[tokenStorageKey];
  const repos = items[watchListKey] || []; // ["owner/repo"]
  if (token && repos.length) {
    startPolling(token, repos);
  }
});

let lastRunMap = {}; // repo -> latest run id

function startPolling(token, repos) {
  async function checkOnce() {
    for (const repo of repos) {
      try {
        const url = `https://api.github.com/repos/${repo}/actions/runs?per_page=1`;
        const res = await fetch(url, {
          headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github.v3+json'
          }
        });
        if (!res.ok) {
          console.warn('[GHSound] GitHub API fail', res.status, await res.text());
          continue;
        }
        const data = await res.json();
        const runs = data.workflow_runs || [];
        if (runs.length) {
          const r = runs[0];
          const key = repo;
          if (lastRunMap[key] && lastRunMap[key] !== r.id && r.conclusion === 'success') {
            // 新的成功 run
            notifyAndPlay(repo, r);
          }
          lastRunMap[key] = r.id;
        }
      } catch (e) {
        console.error(e);
      }
    }
  }

  checkOnce();
  chrome.alarms.create('gh-poll', { periodInMinutes: Math.max(1, pollingIntervalMin / 60) });
  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === 'gh-poll') checkOnce();
  });
}

function notifyAndPlay(repo, run) {
  // 發訊息給所有分頁上的 content script（在打開的 GitHub 分頁會收到並播放）
  chrome.tabs.query({}, tabs => {
    for (const t of tabs) {
      if (t.url && t.url.includes('github.com')) {
        chrome.tabs.sendMessage(t.id, { type: 'PLAY_SOUND', repo, run });
      }
    }
  });

  // 也可以建立 chrome notification（但 notifications 不會有聲音）
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: `GitHub Actions success: ${repo}`,
    message: `Workflow run ${run.name || run.id} succeeded.`
  });
}
