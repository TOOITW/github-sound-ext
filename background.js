// background.js (MV3 service worker)
console.log("[GHSound] SW loaded");

const TOKEN_KEY = "github_pat";
const REPOS_KEY = "watch_repos";
const LAST_RUN_KEY = "last_run_map"; // { [repo]: { id, conclusion } }
const POLL_SECS = 60;

let isPolling = false;

// 接收 popup 的「設定已儲存」訊息
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "CONFIG_SAVED") {
    console.log("[GHSound] CONFIG_SAVED received");
    boot(true); // 重新啟動輪詢
    sendResponse({ ok: true });
  }
  return false;
});

// 啟動點：安裝/開機/重載後
chrome.runtime.onInstalled.addListener(() => boot());
chrome.runtime.onStartup.addListener(() => boot());

// ===== 放在檔案上方（全域只綁一次） =====
const notifTarget = new Map(); // notifId -> url
chrome.notifications.onClicked.addListener((id) => {
  const url = notifTarget.get(id);
  if (url) {
    chrome.tabs.create({ url });
    chrome.notifications.clear(id);
    notifTarget.delete(id);
  }
});


// 鬧鐘觸發輪詢（SW 平時會休眠）
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "gh-poll") tick();
});

async function boot(restart = false) {
  const { [TOKEN_KEY]: token, [REPOS_KEY]: repos = [] } =
    await chrome.storage.local.get([TOKEN_KEY, REPOS_KEY]);

  console.log("[GHSound] boot settings:", { hasToken: !!token, repos });

  if (!token || !repos.length) {
    console.warn("[GHSound] missing token or repos, stop polling");
    await chrome.alarms.clear("gh-poll");
    isPolling = false;
    return;
  }

  if (restart) {
    await chrome.alarms.clear("gh-poll");
    isPolling = false;
  }

  if (!isPolling) {
    console.log("[GHSound] start polling");
    isPolling = true;
    await tick(); // 先跑一次
    chrome.alarms.create("gh-poll", {
      periodInMinutes: Math.max(1, POLL_SECS / 60),
    });
  }
}

async function tick() {
  const store = await chrome.storage.local.get([
    TOKEN_KEY,
    REPOS_KEY,
    LAST_RUN_KEY,
  ]);
  const token = store[TOKEN_KEY];
  const repos = store[REPOS_KEY] || [];
  const lastMap = store[LAST_RUN_KEY] || {};

  for (const repo of repos) {
    try {
      const url = `https://api.github.com/repos/${repo}/actions/runs?per_page=1`;
      console.log("[GHSound] checking", url);

      const res = await fetch(url, {
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/vnd.github.v3+json",
        },
      });
      if (!res.ok) {
        console.warn("[GHSound] API error", repo, res.status);
        continue;
      }

      const data = await res.json();
      const run = data?.workflow_runs?.[0];
      if (!run) {
        console.log("[GHSound] no runs for", repo);
        continue;
      }

      const prev = lastMap[repo]; // { id, conclusion } | undefined
      const isNewRun = !prev || prev.id !== run.id;

      // ✅ 兩種情況都觸發：
      // 1) 新 run 且一上來就是 success
      // 2) 同一 run 從非 success 變成 success
      const becameSuccess =
        run.conclusion === "success" &&
        (isNewRun ||
          (prev && prev.id === run.id && prev.conclusion !== "success"));

      console.log("[GHSound] latest", repo, {
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
    } catch (e) {
      console.error("[GHSound] tick error", repo, e);
    }
  }
}

async function ensureOffscreen() {
  if (chrome.offscreen && chrome.offscreen.hasDocument) {
    const has = await chrome.offscreen.hasDocument();
    if (has) return;
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["AUDIO_PLAYBACK"],
      justification: "Play a sound when a GitHub Actions run succeeds.",
    });
  }
}

// ===== notifyAndPlay 改版 =====
async function notifyAndPlay(repo, run) {
  console.log("[GHSound] SUCCESS 🎉", repo, run.id);

  // 1) 播聲（offscreen）
  try {
    await ensureOffscreen();
    await chrome.runtime.sendMessage({ type: "OFFSCREEN_PLAY" });
  } catch (e) {
    console.warn("[GHSound] offscreen play failed:", e);
  }

  // 2) 廣播給已開啟的 github 分頁（可選）
  chrome.tabs.query({}, (tabs) => {
    for (const t of tabs) {
      if (t.url?.includes("github.com")) {
        chrome.tabs.sendMessage(t.id, { type: "PLAY_SOUND", repo, run }, () => {
          if (chrome.runtime.lastError) { /* 無 content_script 略過 */ }
        });
      }
    }
  });

  // 3) 系統通知（只建一次）
  const notifId = `gh-success:${repo}:${run.id}`;
  const url = run.html_url || `https://github.com/${repo}/actions/runs/${run.id}`;
  notifTarget.set(notifId, url);

  chrome.notifications.create(notifId, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: `✅ Actions success: ${repo}`,
    message: run.name ? `Workflow: ${run.name}` : `Run #${run.id}`,
    priority: 2
  });
}

async function setBadgeSuccess() {
  await chrome.action.setBadgeText({ text: "OK" });
  await chrome.action.setBadgeBackgroundColor({ color: "#22c55e" }); // 綠色
  // 幾秒後清空
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 6000);
}


// chrome.action.setBadgeText({ text: "OK" });
// chrome.action.setBadgeBackgroundColor({ color: "#22c55e" });

// chrome.notifications.create("test", {
//   type: "basic",
//   iconUrl: "icons/icon128.png",
//   title: "✅ 測試通知",
//   message: "這是 GitHub Success Sound 的測試通知"
// });
