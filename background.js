const DEFAULT_SETTINGS = {
  enabled: true,
  categories: {
    EMAIL: true,
    PHONE: true,
    SSN: true,
    CREDIT_CARD: true,
    IPV4: true,
    DOB: true,
    PASSPORT: true,
    API_KEY: true
  },
  sites: {
    'gemini.google.com': true,
    'chatgpt.com': false,
    'claude.ai': false
  },
  customPatterns: {}
};

const DEFAULT_STATS = {
  total: 0,
  EMAIL: 0, PHONE: 0, SSN: 0, CREDIT_CARD: 0,
  IPV4: 0, DOB: 0, PASSPORT: 0, API_KEY: 0,
  sessions: 0,
  lastReset: null
};

async function enableSessionAccess() {
  try {
    await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
  } catch (_) {}
}

async function ensureDefaults() {
  const { settings, stats } = await chrome.storage.local.get(['settings', 'stats']);
  const next = {};
  if (!settings) {
    next.settings = DEFAULT_SETTINGS;
  } else if (!settings.customPatterns) {
    settings.customPatterns = {};
    next.settings = settings;
  }
  if (!stats) next.stats = { ...DEFAULT_STATS, lastReset: Date.now() };
  if (Object.keys(next).length) await chrome.storage.local.set(next);
}

chrome.runtime.onInstalled.addListener(async () => {
  await enableSessionAccess();
  await ensureDefaults();
});

chrome.runtime.onStartup.addListener(async () => {
  await enableSessionAccess();
  await ensureDefaults();
  const { stats } = await chrome.storage.local.get('stats');
  if (stats) {
    stats.sessions = (stats.sessions || 0) + 1;
    await chrome.storage.local.set({ stats });
  }
});
