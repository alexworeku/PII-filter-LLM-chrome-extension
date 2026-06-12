(() => {
  'use strict';

  const PII_PATTERNS = [
    { name: 'EMAIL',       regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
    { name: 'SSN',         regex: /\b(?!000|666|9\d{2})\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g },
    { name: 'CREDIT_CARD', regex: /\b(?:4\d{3}|5[1-5]\d{2}|6011|65\d{2}|3[47]\d{2}|3(?:0[0-5]|[68]\d)\d)[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b/g },
    { name: 'PHONE',       regex: /(?:\+?\d{1,3}[-.\s]?)?\(?[2-9]\d{2}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g },
    { name: 'IPV4',        regex: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g },
    { name: 'DOB',         regex: /\b(?:0?[1-9]|1[0-2])[\/\-](?:0?[1-9]|[12]\d|3[01])[\/\-](?:19|20)\d{2}\b/g },
    { name: 'PASSPORT',    regex: /\b[A-PR-WY][0-9]{7,8}\b/g },
    { name: 'API_KEY',     regex: /\b(?:sk|pk|rk)-[A-Za-z0-9]{20,}\b/g }
  ];

  const SITE_CONFIGS = {
    'gemini.google.com': {
      input: 'rich-textarea div[contenteditable="true"], .ql-editor[contenteditable="true"]',
      send:  'button[aria-label*="Send" i], button.send-button',
      response: 'message-content, .model-response-text, [data-message-author-role="model"]'
    },
    'chatgpt.com': {
      input: 'div#prompt-textarea[contenteditable="true"], textarea#prompt-textarea',
      send:  'button[data-testid="send-button"], button[aria-label*="Send" i]',
      response: '[data-message-author-role="assistant"]'
    },
    'claude.ai': {
      input: 'div.ProseMirror[contenteditable="true"]',
      send:  'button[aria-label*="Send" i]',
      response: '.font-claude-message, [data-is-streaming]'
    }
  };

  const HOST = location.hostname.replace(/^www\./, '');
  const SITE = SITE_CONFIGS[HOST];
  if (!SITE) return;

  const TOKEN_REGEX = /\[([A-Z_]+)_(\d+)\]/g;

  const state = {
    settings: null,
    stats: null,
    vault: {},        // token -> original value
    reverseMap: {},   // original value -> token (for stable IDs)
    counters: {}      // type -> last assigned number
  };

  const attached = new WeakSet();
  const responseObservers = new Map(); // Element -> MutationObserver
  let shield = null;
  let lastDetected = [];

  // ---------- bootstrap state ----------
  async function loadState() {
    const local = await chrome.storage.local.get(['settings', 'stats']);
    state.settings = local.settings || { enabled: true, categories: {}, sites: {} };
    state.stats = local.stats || { total: 0 };
    try {
      const sess = await chrome.storage.session.get(['vault', 'reverseMap', 'counters']);
      state.vault = sess.vault || {};
      state.reverseMap = sess.reverseMap || {};
      state.counters = sess.counters || {};
    } catch (_) {}
  }

  async function saveVault() {
    try {
      await chrome.storage.session.set({
        vault: state.vault,
        reverseMap: state.reverseMap,
        counters: state.counters
      });
    } catch (_) {}
  }

  async function bumpStat(typeName) {
    state.stats[typeName] = (state.stats[typeName] || 0) + 1;
    state.stats.total = (state.stats.total || 0) + 1;
    await chrome.storage.local.set({ stats: state.stats });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    const wasActive = activeForSite();
    if (area === 'local') {
      if (changes.settings) state.settings = changes.settings.newValue;
      if (changes.stats) state.stats = changes.stats.newValue;
    }
    if (area === 'session') {
      if (changes.vault) state.vault = changes.vault.newValue || {};
      if (changes.reverseMap) state.reverseMap = changes.reverseMap.newValue || {};
      if (changes.counters) state.counters = changes.counters.newValue || {};
    }
    const isActive = activeForSite();

    if (wasActive && !isActive) {
      // Full halt: stop watching responses and revert any unmasked display back to tokens.
      detachAllResponseObservers();
      remaskDisplayedText();
      lastDetected = [];
    } else if (!wasActive && isActive) {
      scan();
    }

    refreshShield();
    if (isActive) rescanResponses();
  });

  function activeForSite() {
    if (!state.settings?.enabled) return false;
    return state.settings.sites?.[HOST] !== false;
  }

  function categoryOn(name) {
    return state.settings?.categories?.[name] !== false;
  }

  function activePatterns() {
    const out = [];
    for (const p of PII_PATTERNS) {
      if (categoryOn(p.name)) out.push(p);
    }
    const custom = state.settings?.customPatterns || {};
    for (const [name, def] of Object.entries(custom)) {
      if (!def?.enabled || !def.pattern) continue;
      try {
        const baseFlags = typeof def.flags === 'string' ? def.flags : '';
        const flags = baseFlags.includes('g') ? baseFlags : baseFlags + 'g';
        out.push({ name, regex: new RegExp(def.pattern, flags) });
      } catch (_) { /* invalid regex — skip */ }
    }
    return out;
  }

  // ---------- detection / masking ----------
  function detect(text) {
    const found = [];
    for (const { name, regex } of activePatterns()) {
      const re = new RegExp(regex.source, regex.flags);
      let m;
      while ((m = re.exec(text)) !== null) {
        found.push({ type: name, value: m[0], index: m.index });
      }
    }
    return found;
  }

  function tokenFor(type, value) {
    if (state.reverseMap[value]) return state.reverseMap[value];
    state.counters[type] = (state.counters[type] || 0) + 1;
    const token = `[${type}_${state.counters[type]}]`;
    state.vault[token] = value;
    state.reverseMap[value] = token;
    return token;
  }

  async function maskText(text) {
    let changed = false;
    let out = text;
    for (const { name, regex } of activePatterns()) {
      const re = new RegExp(regex.source, regex.flags);
      out = out.replace(re, (match) => {
        const isNew = !state.reverseMap[match];
        const token = tokenFor(name, match);
        if (isNew) bumpStat(name);
        changed = true;
        return token;
      });
    }
    if (changed) await saveVault();
    return out;
  }

  // ---------- input handling ----------
  function getInputText(el) {
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value;
    return el.innerText ?? el.textContent ?? '';
  }

  function replaceInputText(el, text) {
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    const ok = document.execCommand('insertText', false, text);
    if (!ok) {
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }
  }

  async function maskBeforeSend(el) {
    if (!activeForSite()) return false;
    const text = getInputText(el);
    const masked = await maskText(text);
    if (masked === text) return false;
    replaceInputText(el, masked);
    lastDetected = [];
    refreshShield();
    return true;
  }

  function onInput(el) {
    if (!activeForSite()) { lastDetected = []; refreshShield(); return; }
    lastDetected = detect(getInputText(el));
    refreshShield();
  }

  async function onKeydown(el, e) {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    if (!activeForSite()) return;
    if (!detect(getInputText(el)).length) return;
    e.preventDefault();
    e.stopPropagation();
    await maskBeforeSend(el);
    setTimeout(() => {
      const btn = document.querySelector(SITE.send);
      if (btn && !btn.disabled) {
        btn.click();
      } else {
        el.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
          bubbles: true, cancelable: true
        }));
      }
    }, 60);
  }

  function attachInput(el) {
    if (attached.has(el)) return;
    attached.add(el);
    el.addEventListener('input', () => onInput(el));
    el.addEventListener('keydown', (e) => onKeydown(el, e), true);
    el.addEventListener('blur', () => { lastDetected = []; refreshShield(); });
  }

  document.addEventListener('click', async (e) => {
    if (!activeForSite()) return;
    const btn = e.target.closest(SITE.send);
    if (!btn) return;
    const input = document.querySelector(SITE.input);
    if (!input) return;
    if (!detect(getInputText(input)).length) return;
    e.preventDefault();
    e.stopPropagation();
    await maskBeforeSend(input);
    setTimeout(() => btn.click(), 60);
  }, true);

  // ---------- response unmasking ----------
  function unmaskInTextNode(node) {
    if (!activeForSite()) return;
    const text = node.nodeValue;
    if (!text || !text.includes('[')) return;
    TOKEN_REGEX.lastIndex = 0;
    if (!TOKEN_REGEX.test(text)) return;
    const next = text.replace(TOKEN_REGEX, (full) => state.vault[full] ?? full);
    if (next !== text) node.nodeValue = next;
  }

  function unmaskSubtree(root) {
    if (!activeForSite()) return;
    if (!root || root.nodeType === Node.TEXT_NODE) {
      if (root) unmaskInTextNode(root);
      return;
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) unmaskInTextNode(n);
  }

  function attachResponseObserver(el) {
    if (responseObservers.has(el)) return;
    if (!activeForSite()) return;
    unmaskSubtree(el);
    const obs = new MutationObserver((muts) => {
      if (!activeForSite()) return;
      for (const m of muts) {
        if (m.type === 'characterData') unmaskInTextNode(m.target);
        else m.addedNodes.forEach(n => unmaskSubtree(n));
      }
    });
    obs.observe(el, { childList: true, subtree: true, characterData: true });
    responseObservers.set(el, obs);
  }

  function detachAllResponseObservers() {
    for (const obs of responseObservers.values()) obs.disconnect();
    responseObservers.clear();
  }

  // When disabling, walk all response containers and put back tokens for any
  // vault values currently shown — so the page reflects exactly what the LLM has.
  function remaskDisplayedText() {
    const values = Object.keys(state.reverseMap);
    if (!values.length) return;
    const escaped = values
      .sort((a, b) => b.length - a.length)
      .map(v => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const re = new RegExp(escaped.join('|'), 'g');
    document.querySelectorAll(SITE.response).forEach((el) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        const text = n.nodeValue;
        if (!text) continue;
        const next = text.replace(re, (match) => state.reverseMap[match] ?? match);
        if (next !== text) n.nodeValue = next;
      }
    });
  }

  function rescanResponses() {
    if (!activeForSite()) return;
    document.querySelectorAll(SITE.response).forEach(attachResponseObserver);
  }

  // ---------- shield widget ----------
  function ensureShield() {
    if (shield) return shield;
    shield = document.createElement('div');
    shield.className = 'pii-shield pii-state-safe';
    shield.innerHTML = `
      <div class="pii-shield-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
          <path d="M12 1 3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z"/>
          <path class="pii-shield-mark" d="M9.5 12.5l1.8 1.8 3.7-3.7" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
      <div class="pii-shield-body">
        <div class="pii-shield-title">PII Shield</div>
        <div class="pii-shield-sub">Protected</div>
      </div>
      <div class="pii-shield-count" hidden>0</div>
    `;
    shield.addEventListener('mouseenter', () => shield.classList.add('pii-expanded'));
    shield.addEventListener('mouseleave', () => shield.classList.remove('pii-expanded'));
    document.body.appendChild(shield);
    return shield;
  }

  function refreshShield() {
    if (!activeForSite()) { shield?.remove(); shield = null; return; }
    const el = ensureShield();
    const count = lastDetected.length;
    const sub = el.querySelector('.pii-shield-sub');
    const badge = el.querySelector('.pii-shield-count');
    if (count > 0) {
      el.classList.remove('pii-state-safe');
      el.classList.add('pii-state-alert');
      const types = [...new Set(lastDetected.map(d => d.type.replace('_', ' ').toLowerCase()))].join(', ');
      sub.textContent = `${count} item${count > 1 ? 's' : ''} ready to mask · ${types}`;
      badge.textContent = String(count);
      badge.hidden = false;
    } else {
      el.classList.add('pii-state-safe');
      el.classList.remove('pii-state-alert');
      const total = state.stats?.total || 0;
      sub.textContent = total > 0 ? `Protected · ${total} masked all-time` : 'Protected · monitoring input';
      badge.hidden = true;
    }
  }

  // ---------- discovery ----------
  function scan() {
    document.querySelectorAll(SITE.input).forEach(attachInput);
    if (activeForSite()) rescanResponses();
  }

  // ---------- start ----------
  loadState().then(() => {
    new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
    scan();
    refreshShield();
  });
})();
