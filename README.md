# GitHub Actions Success Sound 🔔
A Chrome Extension that plays a success sound when your GitHub Actions workflow succeeds.

## 🎯 專案目標
當你推 commit、發 PR、CI 成功時，自動播音效或顯示通知。
這個小工具讓你不用每次都開 GitHub 看 build 狀態。

---
Q1: 為什麼需要 PAT？

因為 GitHub 限制匿名 API 每小時只能 60 次，但有 token 的用戶可以到 5000 次。
👉 所以 PAT 是「身分證 + 通行證」。

Q2: 為什麼 Service Worker 能定時跑？

它註冊了 chrome.alarms.create()，Chrome 會在背景喚醒它執行指定任務。
👉 它不是永遠活著，但會在時間到時自動醒來。

Q3: 為什麼能播聲音？

Service Worker 不能直接 new Audio()，所以用 offscreen document 播。
👉 這是一個看不見的隱藏頁面，專門為播放音效設計。

---

| OSI 層級          | 對應這個專案的角色                             | 範例說明                                         |
| --------------- | ------------------------------------- | -------------------------------------------- |
| **L7 應用層**   | 你的 Chrome Extension / GitHub REST API | 透過 HTTPS 調用 `GET /repos/{repo}/actions/runs` |
| **L6 表示層**   | JSON 格式傳輸                             | GitHub 回傳 JSON → SW 解析成物件                    |
| **L5 會話層**   | PAT 驗證、HTTP Headers                   | Authorization: token xxx                     |
| **L4 傳輸層**   | TCP (HTTPS over TLS)                  | Chrome 與 api.github.com 間建立 TCP 連線           |

---
## 我學到的東西
| 主題             | 學到什麼                                                          |
| -------------- | ------------------------------------------------------------- |
| Chrome MV3 架構  | 了解 Manifest v3 如何用 service worker + offscreen 播音效             |
| GitHub API     | 學會用 PAT + REST API + ETag 省額度查 workflow                       |
| HTTP 機制        | 304 Not Modified 節省流量的技巧                                      |
| Web permission | 如何使用 `chrome.action`, `chrome.alarms`, `chrome.notifications` |
| 資料持久化          | 用 `chrome.storage.local` 儲存使用者設定                              |
| 觀念整合           | 能用 OSI 七層對應應用層網路運作                                            |

---



```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant P as Popup UI (popup.html/js)
    participant S as Storage<br/>(local/sync)
    participant SW as Service Worker<br/>(background.js)
    participant A as Chrome Alarms
    participant GH as GitHub API
    participant OS as Offscreen Doc<br/>(offscreen.html/js)
    participant CS as GitHub Tab<br/>(content_script.js)
    participant N as Notifications/Badge

    %% --- 初次設定 ---
    U->>P: 開啟外掛圖示
    U->>P: 點「Enable Sound」
    P->>S: 儲存 sound_enabled=true
    U->>P: 貼入 PAT、輸入 repos 並按「Save」
    P->>S: set { github_pat, watch_repos }
    P->>SW: runtime.sendMessage(CONFIG_SAVED)
    SW->>SW: boot(true) 重新啟動輪詢
    SW->>A: create("gh-poll", period=1min)

    %% --- 輪詢一次 ---
    A-->>SW: onAlarm("gh-poll") / 或 boot()先跑一次
    SW->>S: get { token, repos, last_run_map, etag_map }
    loop 逐一 repo
        SW->>GH: GET /repos/{repo}/actions/runs?per_page=1<br/>If-None-Match: ETag
        alt 304 Not Modified
            GH-->>SW: 304 (無變更)
            SW->>SW: 跳過該 repo
        else 200 OK
            GH-->>SW: 最新 run (status, conclusion, id)
            SW->>SW: 比對 last_run_map<br/>新 run 或同 run 由非 success → success ?
            alt 成功觸發
                SW->>N: setBadgeText("OK"), setBadgeColor(green)
                SW->>OS: ensureOffscreen()
                SW->>OS: runtime.sendMessage(OFFSCREEN_PLAY)
                OS-->>OS: new Audio(success.mp3).play()
                par 有開 GitHub 分頁
                    SW->>CS: sendMessage(PLAY_SOUND, repo, run)
                    CS-->>CS: 可選：顯示 Toast / 再播聲音
                and 系統通知
                    SW->>N: notifications.create(notifId, title/message/icon)
                    U-->>N: 點擊通知
                    N->>SW: onClicked(notifId)
                    SW->>U: 開啟 run 頁面 (tabs.create)
                end
            else 未達成功條件
                SW->>SW: 僅更新 last_run_map
            end
            SW->>S: set { last_run_map, etag_map }
        end
    end

    %% --- 之後循環 ---
    A-->>SW: 每 1 分鐘觸發 tick()
```