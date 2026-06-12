const enabledCheckbox = document.getElementById('enabled');
const siteStatus = document.getElementById('site-status');
const statTotal = document.getElementById('stat-total');
const statSession = document.getElementById('stat-session');
const openSettingsBtn = document.getElementById('open-settings');
const clearVaultBtn = document.getElementById('clear-vault');

async function getActiveHost() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return null;
    return new URL(tab.url).hostname.replace(/^www\./, '');
  } catch { return null; }
}

async function render() {
  const { settings, stats } = await chrome.storage.local.get(['settings', 'stats']);
  const vault = await chrome.storage.session.get('vault').catch(() => ({}));

  enabledCheckbox.checked = settings?.enabled !== false;
  statTotal.textContent = stats?.total ?? 0;
  statSession.textContent = Object.keys(vault.vault || {}).length;

  const host = await getActiveHost();
  const supported = settings?.sites && Object.prototype.hasOwnProperty.call(settings.sites, host);
  const siteOn = supported && settings.sites[host];
  if (!supported) {
    siteStatus.textContent = 'Not supported';
    siteStatus.className = 'status-value off';
  } else if (siteOn) {
    siteStatus.textContent = 'Active';
    siteStatus.className = 'status-value on';
  } else {
    siteStatus.textContent = 'Disabled';
    siteStatus.className = 'status-value off';
  }
}

enabledCheckbox.addEventListener('change', async () => {
  const { settings } = await chrome.storage.local.get('settings');
  settings.enabled = enabledCheckbox.checked;
  await chrome.storage.local.set({ settings });
});

openSettingsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());

clearVaultBtn.addEventListener('click', async () => {
  await chrome.storage.session.set({ vault: {}, reverseMap: {}, counters: {} });
  render();
});

chrome.storage.onChanged.addListener(render);
render();
