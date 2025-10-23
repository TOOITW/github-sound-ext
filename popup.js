document.getElementById('enable').addEventListener('click', async () => {
  const url = chrome.runtime.getURL('sounds/success.mp3');
  const a = new Audio(url);
  try {
    await a.play();
    chrome.storage.local.set({ sound_enabled: true });
    alert('Sound enabled.');
  } catch (e) {
    console.warn('Autoplay blocked:', e);
    alert('Autoplay blocked by the browser. Try clicking the button again.');
  }
});

document.getElementById('save').addEventListener('click', async () => {
  const pat = document.getElementById('pat').value.trim();
  const repos = document.getElementById('repos').value
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  await chrome.storage.local.set({ github_pat: pat, watch_repos: repos });
  chrome.runtime.sendMessage({ type: 'CONFIG_SAVED' });
  alert('Saved.');
});
