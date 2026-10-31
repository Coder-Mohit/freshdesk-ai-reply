// Injected into the Freshdesk tab on demand (only after the agent opens the popup).
// It only READS the page. It never types into, clicks, or sends anything.
// Exposes: globalThis.__fdAiExtractor = { extract, selection, diagnose, testSelector, outline }

(() => {
  const clean = (s) =>
    (s || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

  // querySelectorAll that reports bad selectors instead of throwing.
  function qsa(root, selector, warnings) {
    if (!selector) return [];
    try {
      return Array.from(root.querySelectorAll(selector));
    } catch {
      if (warnings) warnings.push(`Invalid CSS selector in config: ${selector}`);
      return [];
    }
  }

  function matchesSafe(el, selector) {
    try {
      return el.matches(selector);
    } catch {
      return false;
    }
  }

  // Reads visible text. If stripSelectors are given, reads from a hidden copy with those parts removed.
  function textOf(el, stripSelectors) {
    if (!el) return '';
    if (!stripSelectors || stripSelectors.length === 0) return clean(el.innerText || el.textContent);
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-99999px;top:0;width:800px;pointer-events:none;';
    const clone = el.cloneNode(true);
    stripSelectors.forEach((s) => qsa(clone, s).forEach((n) => n.remove()));
    host.appendChild(clone);
    document.body.appendChild(host);
    const text = clean(clone.innerText || clone.textContent);
    host.remove();
    return text;
  }

  function timeOf(el) {
    if (!el) return '';
    return clean(el.getAttribute('datetime') || el.getAttribute('title') || el.textContent).slice(0, 60);
  }

  function roleOf(item, roles) {
    // internal_note is checked first on purpose: a private note must never be mistaken for a public message.
    for (const role of ['internal_note', 'customer', 'agent', 'system']) {
      const sel = roles && roles[role];
      if (!sel) continue;
      if (matchesSafe(item, sel)) return role;
      try {
        if (item.querySelector(sel)) return role;
      } catch {
        /* invalid selector already reported elsewhere */
      }
    }
    return 'unlabeled';
  }

  function extract(cfg) {
    const warnings = [];
    const missingConfig = [];
    if (!cfg.conversationItem) missingConfig.push('conversationItem');
    if (cfg.domOrder !== 'oldest-first' && cfg.domOrder !== 'newest-first') missingConfig.push('domOrder');
    if (missingConfig.length) {
      return { ok: false, missingConfig, warnings, messages: [], subject: '' };
    }

    const messages = [];
    const itemCfg = cfg.item || {};
    const roles = cfg.roles || {};

    // Subject
    const subjectEl = cfg.subject ? qsa(document, cfg.subject, warnings)[0] : null;
    const subject = subjectEl ? textOf(subjectEl) : '';
    if (cfg.subject && !subjectEl) warnings.push('Subject selector matched nothing.');

    // Original description
    let descEl = null;
    if (cfg.description) {
      descEl = qsa(document, cfg.description, warnings)[0] || null;
      if (!descEl) warnings.push('Description selector matched nothing.');
    }

    // Conversation items
    let items = qsa(document, cfg.conversationItem, warnings);
    if (items.length === 0) warnings.push('conversationItem matched nothing on this page.');
    if (cfg.domOrder === 'newest-first') items = items.slice().reverse();

    if (descEl) {
      if (items.some((it) => it.contains(descEl) && it !== descEl)) {
        warnings.push('The description element sits inside a conversation item. Check for duplicated text.');
      }
      items = items.filter((it) => it !== descEl && !descEl.contains(it));
      const t = textOf(descEl, itemCfg.stripSelectors);
      if (t) messages.push({ kind: 'description', role: 'customer', author: '', time: '', text: t });
    }

    let skipped = 0;
    items.forEach((item) => {
      const bodyEl = itemCfg.body ? qsa(item, itemCfg.body, warnings)[0] : item;
      if (!bodyEl) {
        skipped += 1;
        return;
      }
      const text = textOf(bodyEl, itemCfg.stripSelectors);
      if (!text) {
        skipped += 1;
        return;
      }
      const authorEl = itemCfg.author ? qsa(item, itemCfg.author, warnings)[0] : null;
      messages.push({
        kind: 'message',
        role: roleOf(item, roles),
        author: authorEl ? textOf(authorEl).slice(0, 100) : '',
        time: itemCfg.time ? timeOf(qsa(item, itemCfg.time, warnings)[0]) : '',
        text,
      });
    });
    if (skipped) warnings.push(`${skipped} conversation item(s) were skipped (no body found or empty text).`);

    // Safety default: which messages are pre-ticked for sending to the AI.
    const canDetectNotes = Boolean(roles.internal_note);
    if (!canDetectNotes) {
      warnings.push(
        'Internal-note detection is not configured, so private notes cannot be told apart. Nothing is pre-selected: tick only messages you know are customer-visible.'
      );
    }
    messages.forEach((m) => {
      m.include = canDetectNotes && (m.role === 'customer' || m.role === 'agent');
    });
    if (messages.some((m) => m.role === 'unlabeled')) {
      warnings.push('Some messages have no detected sender and are unticked. Set their role, then tick them if they should be used.');
    }

    // Incomplete-context hints
    const hints = cfg.incompleteHints || {};
    const loadMore = qsa(document, hints.loadMore, warnings).length;
    const collapsed = qsa(document, hints.collapsedContent, warnings).length;
    let contextIncomplete = false;
    if (loadMore) {
      warnings.push(`Found ${loadMore} control(s) that load earlier messages. Older messages are probably missing.`);
      contextIncomplete = true;
    }
    if (collapsed) {
      warnings.push(`Found ${collapsed} collapsed/"show more" element(s). Some message text may be cut off.`);
      contextIncomplete = true;
    }
    if (!hints.loadMore && !hints.collapsedContent) {
      warnings.push('No incomplete-content hints are configured, so I cannot tell whether older messages are hidden.');
      contextIncomplete = true;
    }

    return {
      ok: messages.length > 0,
      subject,
      messages,
      warnings,
      contextIncomplete,
      host: location.hostname,
    };
  }

  // Fallback that needs no selectors: whatever text the agent has highlighted on the page.
  function selection() {
    const text = clean(String(window.getSelection ? window.getSelection() : ''));
    return { ok: Boolean(text), text: text.slice(0, 60000), host: location.hostname };
  }

  // Counts only; never returns page text.
  function diagnose(cfg) {
    const rows = [];
    const add = (key, selector) => {
      if (!selector) return rows.push({ key, selector: null, count: null });
      try {
        rows.push({ key, selector, count: document.querySelectorAll(selector).length });
      } catch {
        rows.push({ key, selector, count: null, error: 'invalid selector' });
      }
    };
    add('subject', cfg.subject);
    add('description', cfg.description);
    add('conversationItem', cfg.conversationItem);
    const itemCfg = cfg.item || {};
    const items = cfg.conversationItem ? qsa(document, cfg.conversationItem) : [];
    ['body', 'author', 'time'].forEach((k) => {
      if (!itemCfg[k]) return rows.push({ key: `item.${k}`, selector: null, count: null });
      const withMatch = items.filter((it) => qsa(it, itemCfg[k]).length > 0).length;
      rows.push({ key: `item.${k}`, selector: itemCfg[k], count: withMatch, note: `items containing a match (of ${items.length})` });
    });
    const roleCounts = { internal_note: 0, customer: 0, agent: 0, system: 0, unlabeled: 0 };
    items.forEach((it) => {
      roleCounts[roleOf(it, cfg.roles || {})] += 1;
    });
    const hints = cfg.incompleteHints || {};
    add('incompleteHints.loadMore', hints.loadMore);
    add('incompleteHints.collapsedContent', hints.collapsedContent);

    let shadowRoots = 0;
    const all = document.querySelectorAll('*');
    for (let i = 0; i < all.length && i < 30000; i += 1) if (all[i].shadowRoot) shadowRoots += 1;

    return {
      host: location.hostname,
      rows,
      roleCounts,
      iframes: document.querySelectorAll('iframe').length,
      openShadowRoots: shadowRoots,
    };
  }

  // Reports how many elements a selector matches, without returning their text.
  function testSelector(cfg, selector) {
    try {
      const found = document.querySelectorAll(selector);
      const first = found[0];
      return {
        count: found.length,
        firstTag: first ? first.tagName.toLowerCase() : null,
        firstClasses: first ? String(first.className || '').slice(0, 200) : null,
        firstTextLength: first ? (first.innerText || first.textContent || '').trim().length : null,
      };
    } catch {
      return { error: 'Invalid CSS selector.' };
    }
  }

  // Builds a text-free outline of the page structure: tags, classes, a few attribute values.
  // All visible text is replaced by "[text:N]" (N = number of characters). Digit runs are masked.
  function outline(cfg, rootSelector) {
    let root;
    try {
      root = rootSelector ? document.querySelector(rootSelector) : document.body;
    } catch {
      return { ok: false, error: 'Invalid root selector.' };
    }
    if (!root) return { ok: false, error: 'Root selector matched nothing.' };

    const MAX_NODES = 2500;
    const MAX_DEPTH = 30;
    const SKIP = new Set(['script', 'style', 'svg', 'noscript', 'path', 'link', 'meta']);
    const KEEP_VALUE = new Set(['role', 'type', 'data-test-id', 'data-testid', 'data-test', 'data-type', 'data-qa', 'data-cy', 'data-component']);
    const mask = (s) => String(s).replace(/\d{2,}/g, '#');
    const lines = [];
    let nodes = 0;
    let truncated = false;

    function walk(el, depth) {
      if (nodes >= MAX_NODES || depth > MAX_DEPTH) {
        truncated = true;
        return;
      }
      nodes += 1;
      const tag = el.tagName.toLowerCase();
      const pad = '  '.repeat(depth);
      if (SKIP.has(tag)) {
        lines.push(`${pad}<${tag}> (skipped)`);
        return;
      }
      const attrs = [];
      for (const a of Array.from(el.attributes)) {
        if (a.name === 'class') attrs.push(`class="${mask(a.value).slice(0, 200)}"`);
        else if (a.name === 'id') attrs.push(`id="${mask(a.value).slice(0, 80)}"`);
        else if (KEEP_VALUE.has(a.name)) attrs.push(`${a.name}="${mask(a.value).slice(0, 80)}"`);
        else if (a.name !== 'style') attrs.push(a.name); // name only, value removed
      }
      let textLen = 0;
      el.childNodes.forEach((n) => {
        if (n.nodeType === 3) textLen += n.textContent.trim().length;
      });
      lines.push(`${pad}<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>${textLen ? ` [text:${textLen}]` : ''}`);
      Array.from(el.children).forEach((c) => walk(c, depth + 1));
      if (el.shadowRoot) {
        lines.push(`${pad}  #shadow-root (open)`);
        Array.from(el.shadowRoot.children).forEach((c) => walk(c, depth + 2));
      }
      if (tag === 'iframe') lines.push(`${pad}  (iframe contents are not included)`);
    }

    walk(root, 0);
    return { ok: true, text: lines.join('\n'), nodes, truncated };
  }

  globalThis.__fdAiExtractor = { extract, selection, diagnose, testSelector, outline };
})();
