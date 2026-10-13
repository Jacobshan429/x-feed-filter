// ==UserScript==
// @name         X feed filter
// @namespace    https://github.com/Jacobshan429/x-feed-filter
// @version      1.0.0
// @description  Uses Jev to collapse engagement bait, slop and promo posts on the X home and list timelines.
// @author       Jacobshan429
// @license      MIT
// @homepageURL  https://github.com/Jacobshan429/x-feed-filter
// @updateURL    https://raw.githubusercontent.com/Jacobshan429/x-feed-filter/main/x-feed-filter.user.js
// @downloadURL  https://raw.githubusercontent.com/Jacobshan429/x-feed-filter/main/x-feed-filter.user.js
// @match        https://x.com/*
// @noframes
// @run-at       document-idle
// @inject-into  content
// @sandbox      DOM
// @grant        GM.xmlHttpRequest
// @grant        GM.getValue
// @grant        GM.setValue
// @connect      api.typesafe.ai
// ==/UserScript==

(async () => {
  'use strict';

  const API = 'https://api.typesafe.ai/v1/systemone';
  const LABELS = ['signal', 'bait', 'slop', 'promo']; // signal first: Jev leans to the first option
  const NOISE = LABELS.slice(1);
  const INSTRUCTIONS = 'Which option best describes the main purpose of `post`? `quoting` is context only.';
  const DEFAULTS = {
    key: '',
    model: 'jev-1.13.0',
    threshold: 0.7,
    hide: { bait: true, slop: true, promo: true },
    allPages: false,
    definitions: {
      signal: 'Worth reading: original thoughts, news or real information, genuine questions or conversation, personal updates, useful links, or anything that does not clearly fit another option.',
      bait: 'Built mainly to farm engagement: rage bait, "reply with / like if", questions asked only to collect replies, giveaways, follow-for-follow, hooks that withhold the point to force a click or thread read.',
      slop: 'Low-effort or machine-made filler: generic AI-written text, recycled listicles and threads, hollow hustle or motivational lines, replies that only restate the post.',
      promo: 'Selling something: ads, product or course pitches, token or airdrop shilling, referral links, self-promotion with nothing else.',
    },
  };
  const MAX_TEXT = 2000;
  const CACHE_SIZE = 2000;
  const MAX_IN_FLIGHT = 4;
  const BLUR_TIMEOUT = 6000;
  const PAUSE_AFTER_FAILURES = 3;
  const PAUSE_MS = 60000;
  const STATUS = /^\/[^/]+\/status\/(\d+)$/;

  const stored = await GM.getValue('settings', {});
  const settings = { ...DEFAULTS, ...stored, hide: { ...DEFAULTS.hide, ...stored.hide }, definitions: { ...DEFAULTS.definitions, ...stored.definitions } };
  const cache = new Map(await GM.getValue('cache', [])); // post id -> { label, probs, model, hash }, oldest first

  // Page-load state.
  const seen = new Set();
  const labelled = new Set();
  const hidden = new Set();
  const revealed = new Set(); // stubs tapped open
  const late = new Set(); // shown unlabelled after the blur timeout
  const failed = new Set();
  const deadlines = new Map(); // post id -> time its blur gives up
  const queue = new Map(); // post id -> { post, quoting }, waiting for a request slot
  const inFlight = new Set();
  const articles = new Map(); // post id -> latest article showing it
  let requests = 0;
  let failures = 0;
  let pausedUntil = 0;
  let rejected = false;
  let hash = defsHash();

  function defsHash() {
    const s = JSON.stringify([settings.model, INSTRUCTIONS, LABELS.map((l) => settings.definitions[l])]);
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) | 0;
    return h;
  }

  let saveTimer = 0;
  function remember(id, entry) {
    cache.delete(id);
    cache.set(id, entry);
    while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => GM.setValue('cache', [...cache]), 2000);
  }

  // ---- Jev ----

  function post(body) {
    return new Promise((resolve) => {
      const fail = () => resolve({ status: 0, responseText: '', responseHeaders: '' });
      GM.xmlHttpRequest({
        method: 'POST',
        url: API,
        timeout: 10000,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.key}` },
        data: JSON.stringify(body),
        onload: resolve,
        onerror: fail,
        ontimeout: fail,
        onabort: fail,
      });
    });
  }

  const retryable = (s) => s === 0 || s === 429 || s >= 500;

  async function label(id, text) {
    const state = { post: text.post };
    if (text.quoting) state.quoting = text.quoting;
    const body = {
      state,
      model: settings.model,
      questions: { kind: { type: 'choice', instructions: INSTRUCTIONS, criteria: settings.definitions } },
    };
    const sentHash = hash;
    requests++;
    let res = await post(body);
    if (retryable(res.status) && !rejected) {
      const after = Number((/retry-after:\s*(\d+)/i.exec(res.responseHeaders || '') || [])[1]);
      await new Promise((r) => setTimeout(r, after > 0 ? after * 1000 : 1000));
      requests++;
      res = await post(body);
    }
    if (res.status === 401 || res.status === 403) {
      rejected = true;
    } else if (res.status === 200) {
      failures = 0;
      try {
        const answer = JSON.parse(res.responseText).answers.kind;
        if (!LABELS.includes(answer.choice)) throw new Error('unknown label');
        if (sentHash === hash) remember(id, { label: answer.choice, probs: answer.probabilities, model: settings.model, hash: sentHash });
      } catch {
        failed.add(id); // unparseable answer: show the post unchanged
      }
    } else {
      failed.add(id);
      if (++failures >= PAUSE_AFTER_FAILURES) {
        failures = 0;
        pausedUntil = Date.now() + PAUSE_MS;
        setTimeout(schedule, PAUSE_MS + 50);
      }
    }
  }

  function pump() {
    while (inFlight.size < MAX_IN_FLIGHT && queue.size && filtering()) {
      // Nearest to the middle of the viewport goes first.
      let best = null;
      let bestDist = Infinity;
      for (const id of queue.keys()) {
        const a = articles.get(id);
        if (!a || !a.isConnected) {
          queue.delete(id);
          continue;
        }
        const r = a.getBoundingClientRect();
        const dist = Math.abs(r.top + r.height / 2 - innerHeight / 2);
        if (dist < bestDist) [best, bestDist] = [id, dist];
      }
      if (!best) return;
      const text = queue.get(best);
      queue.delete(best);
      inFlight.add(best);
      label(best, text).finally(() => {
        inFlight.delete(best);
        schedule();
      });
    }
  }

  // ---- Page ----

  const inScope = () =>
    settings.allPages || location.pathname === '/home' || /^\/i\/lists\/\d+/.test(location.pathname);
  const filtering = () => settings.key && !rejected && Date.now() >= pausedUntil;

  // Works for both the logged-in layout (data-testid hooks) and the newer layout without them.
  function read(article) {
    const own = (el) => el.closest('article') === article;
    const link =
      article.querySelector('time')?.closest('a[href*="/status/"]') ||
      [...article.querySelectorAll('a[href*="/status/"]')].find((a) => own(a) && STATUS.test(a.pathname));
    const id = link && (STATUS.exec(link.pathname) || [])[1]; // pathname: phone layouts link to m.x.com/...?query
    if (!id) return null;
    let post;
    let quoting;
    const tweetText = article.querySelectorAll('[data-testid="tweetText"]');
    if (tweetText.length) {
      post = tweetText[0].textContent;
      quoting = tweetText[1]?.textContent;
    } else {
      const dirs = [...article.querySelectorAll('div[dir="auto"]')];
      post = dirs.filter(own).map((d) => d.textContent).join('\n');
      quoting = dirs.filter((d) => !own(d)).map((d) => d.textContent).join('\n');
    }
    return { id, post: post.trim().slice(0, MAX_TEXT), quoting: quoting?.trim().slice(0, MAX_TEXT) };
  }

  // Sets an article's state and its one stub or chip. Writes nothing when it is already right.
  function render(article, id, state, text) {
    let el = article.querySelector(':scope > .xff');
    const want = state && state !== 'pending' ? `${id}|${state}|${text}` : '';
    if ((article.dataset.xff || '') !== state) {
      if (state) article.dataset.xff = state;
      else delete article.dataset.xff;
    }
    if ((el?.dataset.key || '') === want) return;
    el?.remove();
    if (!want) return;
    if (state === 'hidden') {
      el = document.createElement('button');
      el.type = 'button';
      el.textContent = `Hidden - ${text} - show`;
      el.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        revealed.add(id);
        schedule();
      });
    } else {
      el = document.createElement('div');
      el.textContent = text;
    }
    el.className = 'xff';
    el.dataset.key = want;
    article.appendChild(el);
  }

  function pass() {
    timer = 0;
    const now = Date.now();
    const scoped = inScope();
    const near = innerHeight * 1.5;
    for (const article of document.querySelectorAll('article')) {
      if (article.parentElement.closest('article')) continue; // a quoted post inside another
      const p = scoped && read(article);
      if (!p) {
        render(article, '', '', '');
        continue;
      }
      seen.add(p.id);
      articles.set(p.id, article);
      if (!filtering() || !p.post) {
        render(article, '', '', ''); // no key, key rejected, paused, or media only
        continue;
      }
      const hit = cache.get(p.id);
      if (hit && hit.hash === hash) {
        const score = hit.probs[hit.label] ?? 0;
        const chip = `${hit.label} ${score.toFixed(2)}`;
        const hide = hit.label !== 'signal' && settings.hide[hit.label] && score >= settings.threshold && !late.has(p.id);
        labelled.add(p.id);
        if (hide) hidden.add(p.id);
        else hidden.delete(p.id);
        render(article, p.id, hide && !revealed.has(p.id) ? 'hidden' : 'shown', chip);
        continue;
      }
      if (failed.has(p.id) || now >= (deadlines.get(p.id) ?? Infinity)) {
        late.add(p.id); // already seen unblurred, so a late label only adds a chip
        render(article, p.id, 'shown', 'unlabelled');
        continue;
      }
      render(article, p.id, 'pending', '');
      const r = article.getBoundingClientRect();
      if (!inFlight.has(p.id) && r.bottom > -near && r.top < innerHeight + near) {
        queue.set(p.id, { post: p.post, quoting: p.quoting });
        if (!deadlines.has(p.id)) {
          deadlines.set(p.id, now + BLUR_TIMEOUT);
          setTimeout(schedule, BLUR_TIMEOUT + 50);
        }
      }
    }
    pump();
    updatePill();
  }

  let timer = 0;
  function schedule() {
    if (!timer) timer = setTimeout(pass, 100);
  }

  // ---- Status pill and settings ----

  const style = document.createElement('style');
  style.textContent = `
    article[data-xff="pending"] { filter: blur(8px); }
    article[data-xff="hidden"] > :not(.xff) { display: none !important; }
    .xff { font: 12px/1.4 system-ui, sans-serif; color: rgb(113, 118, 123); text-align: right; padding: 0 16px 6px; }
    button.xff { display: block; width: 100%; text-align: left; padding: 10px 16px; background: none; border: 0; cursor: pointer; font-size: 13px; }
  `;
  document.head.appendChild(style);

  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'closed' }); // keeps the panel and key away from x.com scripts
  root.innerHTML = `
    <style>
      * { box-sizing: border-box; font: 13px/1.4 system-ui, sans-serif; color-scheme: light; }
      .pill { position: fixed; left: 8px; bottom: 80px; z-index: 2147483647; padding: 4px 10px; border: 0; border-radius: 999px;
        background: rgb(29, 155, 240); color: #fff; cursor: pointer; opacity: 0.9; }
      .pill.bad { background: rgb(244, 33, 46); }
      .pill.idle { background: rgb(83, 100, 113); }
      .panel { position: fixed; inset: 0; z-index: 2147483647; background: rgba(0, 0, 0, 0.5); display: flex; align-items: center; justify-content: center; }
      .panel[hidden] { display: none; }
      form { background: #fff; color: #0f1419; width: min(480px, calc(100% - 24px)); max-height: calc(100% - 24px); overflow: auto; padding: 16px; border-radius: 12px; }
      strong { font-size: 15px; font-weight: 700; }
      label { display: block; margin: 10px 0 4px; font-weight: 600; }
      label.row { font-weight: normal; margin: 4px 0; }
      input:not([type=checkbox]), textarea { width: 100%; padding: 6px; border: 1px solid #cfd9de; border-radius: 6px; background: #fff; color: #0f1419; }
      textarea { min-height: 70px; }
      .stats { margin-top: 10px; color: #536471; }
      .buttons { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
      button { padding: 6px 14px; border-radius: 999px; border: 1px solid #cfd9de; background: #fff; color: #0f1419; cursor: pointer; }
      .save { background: #0f1419; color: #fff; border-color: #0f1419; }
    </style>
    <button class="pill" type="button"></button>
    <div class="panel" hidden>
      <form>
        <strong>X feed filter</strong>
        <label for="key">TypeSafe API key</label>
        <input id="key" type="password" autocomplete="off">
        <label for="threshold">Hide when the noise label scores at least</label>
        <input id="threshold" type="number" min="0" max="1" step="0.05">
        <label>Hide these labels</label>
        ${NOISE.map((l) => `<label class="row"><input type="checkbox" name="hide" value="${l}"> ${l}</label>`).join('')}
        ${LABELS.map((l) => `<label for="def-${l}">Definition: ${l}</label><textarea id="def-${l}"></textarea>`).join('')}
        <label for="model">Model</label>
        <input id="model" type="text">
        <label class="row"><input type="checkbox" id="allPages"> Filter every page (testing)</label>
        <div class="stats"></div>
        <div class="buttons"><button type="button" class="close">Close</button><button type="button" class="save">Save</button></div>
      </form>
    </div>`;
  document.body.appendChild(host);

  const $ = (s) => root.querySelector(s);
  const pill = $('.pill');
  const panel = $('.panel');

  function updatePill() {
    let text;
    let cls = '';
    if (!settings.key) text = `Jev: add key - ${seen.size} posts`;
    else if (rejected) [text, cls] = ['Jev: key rejected', 'bad'];
    else if (Date.now() < pausedUntil) [text, cls] = ['Jev error - unfiltered', 'bad'];
    else if (!inScope()) [text, cls] = ['Jev idle on this page', 'idle'];
    else text = `Jev on - ${labelled.size} labelled, ${hidden.size} hidden`;
    if (pill.textContent !== text) pill.textContent = text;
    pill.className = `pill ${cls}`;
  }

  pill.addEventListener('click', () => {
    $('#key').value = '';
    $('#key').placeholder = settings.key ? 'Saved. Paste a new key to replace it.' : 'Paste your key';
    $('#threshold').value = settings.threshold;
    for (const box of root.querySelectorAll('[name=hide]')) box.checked = settings.hide[box.value];
    for (const l of LABELS) $(`#def-${l}`).value = settings.definitions[l];
    $('#model').value = settings.model;
    $('#allPages').checked = settings.allPages;
    $('.stats').textContent = `${requests} API requests since this page loaded, ${cache.size} posts cached.`;
    panel.hidden = false;
  });
  $('.close').addEventListener('click', () => (panel.hidden = true));
  $('.save').addEventListener('click', async () => {
    const key = $('#key').value.trim();
    if (key) {
      settings.key = key;
      rejected = false;
      failures = 0;
      pausedUntil = 0;
    }
    const threshold = Number($('#threshold').value);
    if (threshold >= 0 && threshold <= 1) settings.threshold = threshold;
    for (const box of root.querySelectorAll('[name=hide]')) settings.hide[box.value] = box.checked;
    for (const l of LABELS) settings.definitions[l] = $(`#def-${l}`).value.trim() || DEFAULTS.definitions[l];
    settings.model = $('#model').value.trim() || DEFAULTS.model;
    settings.allPages = $('#allPages').checked;
    await GM.setValue('settings', settings);
    hash = defsHash();
    for (const set of [labelled, hidden, failed, deadlines]) set.clear();
    panel.hidden = true;
    schedule();
  });

  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  addEventListener('scroll', schedule, { passive: true });
  schedule();
})();
