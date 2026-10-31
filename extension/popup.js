// Popup logic. Ticket text is held in memory only while this popup is open.
// It is never written to chrome.storage. Only settings are stored.
// Ticket text is always inserted with textContent (never innerHTML).

const $ = (id) => document.getElementById(id);

const DEFAULT_SETTINGS = {
  backendUrl: 'http://localhost:3000',
  token: '',
  allowedDomains: [],
  agentName: '',
};

const ROLE_LABELS = {
  customer: 'Customer',
  agent: 'Agent',
  internal_note: 'Internal note',
  system: 'System',
  unlabeled: 'Unknown sender',
};

let settings = { ...DEFAULT_SETTINGS };
let state = { subject: '', messages: [], contextIncomplete: true };

// ---------- small helpers ----------
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(props).forEach(([k, v]) => {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  });
  [].concat(children).forEach((c) => node.append(c));
  return node;
}

function showError(message) {
  $('error').textContent = message;
  $('error').hidden = !message;
}

function showWarnings(list) {
  const box = $('warnings');
  box.replaceChildren();
  if (!list.length) {
    box.hidden = true;
    return;
  }
  box.append(el('strong', {}, 'Check before generating:'), el('ul', {}, list.map((w) => el('li', {}, w))));
  box.hidden = false;
}

async function guard(fn) {
  try {
    showError('');
    await fn();
  } catch (err) {
    showError(err.message || String(err));
  }
}

// ---------- settings ----------
async function loadSettings() {
  settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
  $('backendUrl').value = settings.backendUrl;
  $('token').value = settings.token;
  $('domains').value = settings.allowedDomains.join('\n');
  $('agentName').value = settings.agentName;
}

async function saveSettings() {
  const domains = $('domains').value
    .split('\n')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  const bad = domains.find((d) => !/^(\*\.)?[a-z0-9.-]+$/.test(d));
  if (bad) throw new Error(`"${bad}" is not a valid hostname. Use e.g. acme.freshdesk.com`);
  settings = {
    ...settings,
    backendUrl: $('backendUrl').value.trim().replace(/\/+$/, '') || DEFAULT_SETTINGS.backendUrl,
    token: $('token').value.trim(),
    allowedDomains: domains,
  };
  await chrome.storage.local.set(settings);
  $('settingsStatus').textContent = 'Saved.';
  await updateSiteStatus();
}

function hostAllowed(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  return settings.allowedDomains.some((p) => (p.startsWith('*.') ? host.endsWith(p.slice(1)) : host === p));
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab found.');
  return tab;
}

async function updateSiteStatus() {
  try {
    const tab = await activeTab();
    const host = new URL(tab.url).hostname;
    $('siteStatus').textContent = hostAllowed(tab.url)
      ? `Active site: ${host} (allowed)`
      : `Active site: ${host} (not in your allowed list, see Settings)`;
  } catch {
    $('siteStatus').textContent = 'No readable page in this tab.';
  }
}

// ---------- talking to the page ----------
async function runInPage(action, arg = null) {
  const tab = await activeTab();
  if (!hostAllowed(tab.url)) {
    throw new Error('This site is not in your allowed list. Open Settings and add its hostname (https only).');
  }
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['extractor.js'] });
  const [out] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (a, cfg, x) => globalThis.__fdAiExtractor[a](cfg, x),
    args: [action, FD_SELECTORS, arg],
  });
  if (!out || out.result === undefined) throw new Error('The page did not return a result.');
  return out.result;
}

// ---------- reading ----------
function loadState(subject, messages, warnings, contextIncomplete) {
  state = { subject, messages, contextIncomplete };
  $('subject').value = subject;
  messages.forEach((m) => {
    if (m.role === 'internal_note') m.include = $('includeNotes').checked;
  });
  renderMessages();
  showWarnings(warnings);
  $('reviewSection').hidden = false;
  $('generateSection').hidden = false;
  $('draftSection').hidden = true;
}

async function readTicket() {
  const res = await runInPage('extract');
  if (res.missingConfig) {
    throw new Error(
      `Selectors are not configured yet (missing: ${res.missingConfig.join(', ')}). ` +
        'Follow "Verify extraction" in the README, or use "Read selected text" for now.'
    );
  }
  if (!res.ok) {
    showWarnings(res.warnings);
    throw new Error('No messages could be read. Run diagnostics under Developer tools.');
  }
  loadState(res.subject, res.messages, res.warnings, res.contextIncomplete);
}

async function readSelection() {
  const res = await runInPage('selection');
  if (!res.ok) throw new Error('Nothing is selected on the page. Highlight the conversation text first.');
  loadState(
    '',
    [{ kind: 'selection', role: 'unlabeled', author: '', time: '', text: res.text, include: true }],
    [
      'Selected text has no sender information and may include private internal notes. Read it before generating.',
      'Tip: edit the text below and prefix lines with "Customer:" or "Agent:" so the AI can tell who said what.',
    ],
    true
  );
}

function renderMessages() {
  const box = $('messages');
  box.replaceChildren();
  state.messages.forEach((m) => {
    const wrap = el('div', { class: 'msg' });
    const syncStyle = () => wrap.classList.toggle('note', m.role === 'internal_note');

    const cb = el('input', {
      type: 'checkbox',
      checked: m.include,
      title: 'Send this message to the AI',
      onchange: (e) => (m.include = e.target.checked),
    });
    const roleSel = el(
      'select',
      {
        title: 'Who wrote this?',
        onchange: (e) => {
          m.role = e.target.value;
          if (m.role === 'internal_note') {
            m.include = $('includeNotes').checked;
            cb.checked = m.include;
          }
          syncStyle();
        },
      },
      Object.entries(ROLE_LABELS).map(([value, label]) => el('option', { value, textContent: label, selected: value === m.role }))
    );
    const who = [m.author, m.time].filter(Boolean).join(' · ') || (m.kind === 'description' ? 'Original description' : '');
    const head = el('div', { class: 'msg-head' }, [cb, roleSel, el('span', { class: 'who muted' }, who), el('span', { class: 'muted small' }, `${m.text.length} chars`)]);

    const area = el('textarea', { rows: 5, value: m.text, oninput: (e) => (m.text = e.target.value) });
    const preview = m.text.replace(/\s+/g, ' ').slice(0, 70);
    const details = el('details', {}, [el('summary', {}, `${preview}${m.text.length > 70 ? '…' : ''}`), area]);

    wrap.append(head, details);
    syncStyle();
    box.append(wrap);
  });
}

// ---------- redaction (best effort, not a compliance guarantee) ----------
function makeRedactor() {
  const forward = new Map();
  const back = new Map();
  const counts = { EMAIL: 0, PHONE: 0 };
  const tag = (kind, value) => {
    const key = `${kind}|${value.toLowerCase()}`;
    if (!forward.has(key)) {
      counts[kind] += 1;
      const placeholder = `[${kind}_${counts[kind]}]`;
      forward.set(key, placeholder);
      back.set(placeholder, value);
    }
    return forward.get(key);
  };
  const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  const PHONE = /(?<![\w])\+?\d[\d\s().-]{7,}\d(?![\w])/g;
  return {
    apply: (text) =>
      String(text || '')
        .replace(EMAIL, (v) => tag('EMAIL', v))
        .replace(PHONE, (v) => (v.replace(/\D/g, '').length >= 9 ? tag('PHONE', v) : v)),
    restore: (text) => text.replace(/\[(?:EMAIL|PHONE)_\d+\]/g, (ph) => (back.has(ph) ? back.get(ph) : ph)),
  };
}

// ---------- generating ----------
async function generate() {
  const useNotes = $('includeNotes').checked;
  const chosen = state.messages.filter((m) => m.include && m.text.trim() && (useNotes || m.role !== 'internal_note'));
  if (!chosen.length) throw new Error('Tick at least one message to send.');
  if (!settings.token) throw new Error('Set the extension token in Settings first.');

  const redactor = $('redact').checked ? makeRedactor() : null;
  const r = (s) => (redactor ? redactor.apply(s) : String(s || ''));

  const payload = {
    channel: $('channel').value,
    subject: r($('subject').value),
    agentNotes: r($('agentNotes').value),
    agentName: $('agentName').value.trim(),
    contextIncomplete: state.contextIncomplete,
    messages: chosen.map((m) => ({ role: m.role, author: r(m.author), time: m.time, text: r(m.text) })),
  };

  $('generate').disabled = true;
  $('regenerate').disabled = true;
  $('status').textContent = 'Generating…';
  try {
    let resp;
    try {
      resp = await fetch(`${settings.backendUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-extension-token': settings.token },
        body: JSON.stringify(payload),
      });
    } catch {
      throw new Error(
        `Could not reach the backend at ${settings.backendUrl}. Is it running? If you changed the URL, also add it to host_permissions in manifest.json and reload the extension.`
      );
    }
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || `Backend returned HTTP ${resp.status}.`);

    $('draft').value = redactor ? redactor.restore(data.reply) : data.reply;

    const flags = [...(data.notesForAgent || [])];
    if ((data.missingInformation || []).length) flags.push(`Asked the customer for: ${data.missingInformation.join('; ')}`);
    if (data.truncated) flags.push('The conversation was too long, so the middle of it was dropped before sending.');
    if (state.contextIncomplete) flags.push('Context may be incomplete (older messages not loaded or unverifiable).');
    if (useNotes && chosen.some((m) => m.role === 'internal_note')) {
      flags.push('Internal notes were used as background. Make sure the draft does not reveal them.');
    }
    const box = $('agentFlags');
    box.replaceChildren();
    if (flags.length) box.append(el('strong', {}, 'Check before sending:'), el('ul', {}, flags.map((f) => el('li', {}, f))));
    box.hidden = flags.length === 0;

    $('draftSection').hidden = false;
    $('status').textContent = '';
  } finally {
    $('generate').disabled = false;
    $('regenerate').disabled = false;
    if ($('status').textContent === 'Generating…') $('status').textContent = '';
  }
}

async function copyDraft() {
  await navigator.clipboard.writeText($('draft').value);
  $('copy').textContent = 'Copied';
  setTimeout(() => ($('copy').textContent = 'Copy draft'), 1500);
}

// ---------- developer tools ----------
function showDev(text) {
  $('devOut').textContent = text;
  $('devOut').hidden = false;
  $('copyDev').hidden = false;
}

async function diagnose() {
  const d = await runInPage('diagnose');
  const lines = [`host: ${d.host}`, `iframes on page: ${d.iframes}`, `open shadow roots: ${d.openShadowRoots}`, ''];
  d.rows.forEach((row) => {
    if (!row.selector) lines.push(`${row.key}: (not configured)`);
    else if (row.error) lines.push(`${row.key}: ${row.error}  [${row.selector}]`);
    else lines.push(`${row.key}: ${row.count}${row.note ? ' ' + row.note : ''}  [${row.selector}]`);
  });
  lines.push('', 'roles detected across conversationItem matches:');
  Object.entries(d.roleCounts).forEach(([k, v]) => lines.push(`  ${k}: ${v}`));
  showDev(lines.join('\n'));
}

async function testSelector() {
  const sel = $('testSel').value.trim();
  if (!sel) throw new Error('Type a CSS selector first.');
  const r = await runInPage('testSelector', sel);
  if (r.error) return showDev(r.error);
  showDev(`matches: ${r.count}\nfirst match: <${r.firstTag}> class="${r.firstClasses}"\nfirst match text length: ${r.firstTextLength} chars`);
}

async function exportOutline() {
  const r = await runInPage('outline', $('outlineRoot').value.trim() || null);
  if (!r.ok) throw new Error(r.error);
  showDev(`${r.text}\n${r.truncated ? '\n[output truncated]' : ''}`);
}

// ---------- wire up ----------
document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  await updateSiteStatus();

  $('readTicket').addEventListener('click', () => guard(readTicket));
  $('readSelection').addEventListener('click', () => guard(readSelection));
  $('generate').addEventListener('click', () => guard(generate));
  $('regenerate').addEventListener('click', () => guard(generate));
  $('copy').addEventListener('click', () => guard(copyDraft));
  $('saveSettings').addEventListener('click', () => guard(saveSettings));
  $('diagnose').addEventListener('click', () => guard(diagnose));
  $('testSelBtn').addEventListener('click', () => guard(testSelector));
  $('outlineBtn').addEventListener('click', () => guard(exportOutline));
  $('copyDev').addEventListener('click', () => navigator.clipboard.writeText($('devOut').textContent));

  $('addCurrentSite').addEventListener('click', () =>
    guard(async () => {
      const tab = await activeTab();
      const u = new URL(tab.url);
      if (u.protocol !== 'https:') throw new Error('Only https pages can be added.');
      const current = $('domains').value.split('\n').map((d) => d.trim()).filter(Boolean);
      if (!current.includes(u.hostname)) current.push(u.hostname);
      $('domains').value = current.join('\n');
      await saveSettings();
    })
  );

  $('agentName').addEventListener('change', () => chrome.storage.local.set({ agentName: $('agentName').value.trim() }));

  // Keep internal-note ticks consistent with the checkbox.
  $('includeNotes').addEventListener('change', () => {
    state.messages.forEach((m) => {
      if (m.role === 'internal_note') m.include = $('includeNotes').checked;
    });
    renderMessages();
  });
});
