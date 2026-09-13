const status = document.getElementById('status');
document.getElementById('connect').addEventListener('click', async () => {
  const button = document.getElementById('connect'); button.disabled = true;
  status.textContent = 'Connecting the selected tab…';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const result = await chrome.runtime.sendMessage({ operation: 'pair', tabId: tab.id, endpoint: document.getElementById('endpoint').value.trim(), token: document.getElementById('token').value.trim() });
    if (result.error) throw new Error(result.error);
    status.textContent = 'Connected. Return to Scout in VS Code and select Start teaching.';
    document.getElementById('token').value = '';
  } catch (error) { status.textContent = error.message; }
  finally { button.disabled = false; }
});
document.getElementById('disconnect').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ operation: 'disconnect' });
  status.textContent = 'Disconnected.';
});
