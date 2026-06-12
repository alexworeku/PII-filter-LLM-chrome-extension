const CATEGORY_META = {
  EMAIL:       { label: 'Email addresses',  desc: 'name@example.com' },
  PHONE:       { label: 'Phone numbers',    desc: '+1 (555) 123-4567 and similar' },
  SSN:         { label: 'US SSN',           desc: '123-45-6789' },
  CREDIT_CARD: { label: 'Credit cards',     desc: 'Visa, Mastercard, Amex, Discover' },
  IPV4:        { label: 'IPv4 addresses',   desc: '192.168.0.1' },
  DOB:         { label: 'Dates of birth',   desc: 'MM/DD/YYYY or MM-DD-YYYY' },
  PASSPORT:    { label: 'Passport numbers', desc: 'Common 8–9 char format' },
  API_KEY:     { label: 'API keys',         desc: 'sk-/pk-/rk- prefixed tokens' }
};

const SITE_META = {
  'gemini.google.com': { label: 'Google Gemini',  url: 'https://gemini.google.com' },
  'chatgpt.com':       { label: 'ChatGPT',        url: 'https://chatgpt.com' },
  'claude.ai':         { label: 'Claude',         url: 'https://claude.ai' }
};

const RESERVED_NAMES = new Set(Object.keys(CATEGORY_META));
const NAME_RE = /^[A-Z][A-Z0-9_]{1,39}$/;

const $ = (sel) => document.querySelector(sel);
const masterCheckbox = $('#master-enabled');

function makeRow({ id, label, desc, checked, onChange }) {
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `
    <div class="info">
      <span class="label">${label}</span>
      ${desc ? `<span class="desc">${desc}</span>` : ''}
    </div>
    <label class="switch">
      <input type="checkbox" id="${id}" ${checked ? 'checked' : ''}>
      <span class="slider"></span>
    </label>
  `;
  row.querySelector('input').addEventListener('change', (e) => onChange(e.target.checked));
  return row;
}

async function render() {
  const { settings, stats } = await chrome.storage.local.get(['settings', 'stats']);
  const sess = await chrome.storage.session.get(['vault', 'counters']).catch(() => ({}));
  const vault = sess.vault || {};

  masterCheckbox.checked = settings?.enabled !== false;

  // stats grid
  const grid = $('#stat-grid');
  grid.innerHTML = '';
  const totalCell = document.createElement('div');
  totalCell.className = 'stat-cell total';
  totalCell.innerHTML = `<div class="num">${stats?.total ?? 0}</div><div class="label">Total masked</div>`;
  grid.appendChild(totalCell);
  for (const [name, meta] of Object.entries(CATEGORY_META)) {
    const cell = document.createElement('div');
    cell.className = 'stat-cell';
    cell.innerHTML = `<div class="num">${stats?.[name] ?? 0}</div><div class="label">${meta.label}</div>`;
    grid.appendChild(cell);
  }

  $('#meta-sessions').textContent = stats?.sessions ?? 0;
  $('#meta-vault').textContent = Object.keys(vault).length;

  // categories
  const catList = $('#category-list');
  catList.innerHTML = '';
  for (const [name, meta] of Object.entries(CATEGORY_META)) {
    const on = settings?.categories?.[name] !== false;
    catList.appendChild(makeRow({
      id: `cat-${name}`,
      label: meta.label,
      desc: meta.desc,
      checked: on,
      onChange: async (val) => {
        const { settings: s } = await chrome.storage.local.get('settings');
        s.categories = s.categories || {};
        s.categories[name] = val;
        await chrome.storage.local.set({ settings: s });
      }
    }));
  }

  // sites
  const siteList = $('#site-list');
  siteList.innerHTML = '';
  for (const [host, meta] of Object.entries(SITE_META)) {
    const on = settings?.sites?.[host] === true;
    siteList.appendChild(makeRow({
      id: `site-${host}`,
      label: meta.label,
      desc: meta.url,
      checked: on,
      onChange: async (val) => {
        const { settings: s } = await chrome.storage.local.get('settings');
        s.sites = s.sites || {};
        s.sites[host] = val;
        await chrome.storage.local.set({ settings: s });
      }
    }));
  }

  // custom entities
  const customList = $('#custom-list');
  customList.innerHTML = '';
  const customPatterns = settings?.customPatterns || {};
  const customEntries = Object.entries(customPatterns);
  for (const [name, def] of customEntries) {
      const row = document.createElement('div');
      row.className = 'row custom';
      row.innerHTML = `
        <div class="info">
          <span class="label">${escapeHtml(name)} <small style="color:var(--muted);font-weight:400">→ <code>[${escapeHtml(name)}_n]</code></small></span>
          <span class="pattern">/${escapeHtml(def.pattern)}/${escapeHtml(def.flags || '')}</span>
        </div>
        <div class="row-controls">
          <button class="icon-btn" data-action="delete" title="Delete entity" aria-label="Delete">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M6 19a2 2 0 002 2h8a2 2 0 002-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
          </button>
          <label class="switch">
            <input type="checkbox" ${def.enabled ? 'checked' : ''} data-action="toggle">
            <span class="slider"></span>
          </label>
        </div>
      `;
      row.querySelector('[data-action="toggle"]').addEventListener('change', async (e) => {
        const { settings: s } = await chrome.storage.local.get('settings');
        s.customPatterns = s.customPatterns || {};
        if (s.customPatterns[name]) {
          s.customPatterns[name].enabled = e.target.checked;
          await chrome.storage.local.set({ settings: s });
        }
      });
      row.querySelector('[data-action="delete"]').addEventListener('click', async () => {
        if (!confirm(`Delete custom entity "${name}"?`)) return;
        const { settings: s } = await chrome.storage.local.get('settings');
        if (s.customPatterns) {
          delete s.customPatterns[name];
          await chrome.storage.local.set({ settings: s });
        }
      });
      customList.appendChild(row);
    }

  // vault table
  const vaultMeta = $('#vault-meta');
  const tbody = $('#vault-table tbody');
  tbody.innerHTML = '';
  const entries = Object.entries(vault);
  if (!entries.length) {
    vaultMeta.textContent = 'No entries yet. Type some PII into a supported chat — masked items appear here.';
  } else {
    vaultMeta.textContent = `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} held in session memory.`;
    entries.sort((a, b) => a[0].localeCompare(b[0])).forEach(([token, value]) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${token}</td><td>${escapeHtml(value)}</td>`;
      tbody.appendChild(tr);
    });
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

masterCheckbox.addEventListener('change', async () => {
  const { settings } = await chrome.storage.local.get('settings');
  settings.enabled = masterCheckbox.checked;
  await chrome.storage.local.set({ settings });
});

$('#reset-stats').addEventListener('click', async () => {
  if (!confirm('Reset all masking statistics?')) return;
  const empty = { total: 0, sessions: 0, lastReset: Date.now() };
  for (const k of Object.keys(CATEGORY_META)) empty[k] = 0;
  await chrome.storage.local.set({ stats: empty });
});

$('#clear-vault').addEventListener('click', async () => {
  if (!confirm('Clear the session vault? Any in-flight masked tokens will no longer unmask.')) return;
  await chrome.storage.session.set({ vault: {}, reverseMap: {}, counters: {} });
});

const customForm = $('#custom-form');
const customNameInput = $('#custom-name');
const customPatternInput = $('#custom-pattern');
const customFlagsInput = $('#custom-flags');
const customError = $('#custom-error');

customNameInput.addEventListener('input', () => {
  customNameInput.value = customNameInput.value.toUpperCase().replace(/[^A-Z0-9_]/g, '');
});

customForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  customError.textContent = '';

  const name = customNameInput.value.trim();
  const pattern = customPatternInput.value;
  const flags = customFlagsInput.value.trim();

  if (!NAME_RE.test(name)) {
    customError.textContent = 'Name must start with a letter and use only A–Z, 0–9, and underscores (2–40 chars).';
    return;
  }
  if (RESERVED_NAMES.has(name)) {
    customError.textContent = `"${name}" is a built-in category. Pick a different name.`;
    return;
  }
  if (!pattern) {
    customError.textContent = 'Pattern is required.';
    return;
  }
  try {
    new RegExp(pattern, flags || 'g');
  } catch (err) {
    customError.textContent = `Invalid regex: ${err.message}`;
    return;
  }

  const { settings } = await chrome.storage.local.get('settings');
  settings.customPatterns = settings.customPatterns || {};
  if (settings.customPatterns[name]) {
    customError.textContent = `Entity "${name}" already exists.`;
    return;
  }
  settings.customPatterns[name] = { pattern, flags: flags || 'g', enabled: true };
  await chrome.storage.local.set({ settings });

  customForm.reset();
  customFlagsInput.value = 'gi';
  $('#custom-add').open = false;
});

// tab switching
const tabs = document.querySelectorAll('.tab');
const panels = document.querySelectorAll('.tab-panel');
function activateTab(name) {
  tabs.forEach(t => {
    const on = t.dataset.tab === name;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  panels.forEach(p => p.classList.toggle('active', p.dataset.panel === name));
  try { localStorage.setItem('pii-shield-tab', name); } catch {}
}
tabs.forEach(t => t.addEventListener('click', () => activateTab(t.dataset.tab)));
try {
  const saved = localStorage.getItem('pii-shield-tab');
  if (saved && document.querySelector(`.tab[data-tab="${saved}"]`)) activateTab(saved);
} catch {}

chrome.storage.onChanged.addListener(render);
render();
