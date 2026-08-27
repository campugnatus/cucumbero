// cucumbero — the black rectangle.
//
// Injected on demand by the service worker into tabs that match the blocklist.
// Self-contained and idempotent: re-injection into the same document is a no-op,
// and all state arrives by message so the worker stays the source of truth.

(() => {
  // An extension reload/update invalidates the chrome.* context of any overlay
  // already on the page: its message listener goes deaf and it can never be
  // told to go away. So don't just bail when one exists — check it's still
  // wired to a live extension, and evict it if it isn't.
  if (window.__cucumbero) {
    if (window.__cucumbero.alive?.()) return; // healthy instance owns this document
    window.__cucumbero.destroy?.();
  }

  const Z = '2147483647';
  // Namespaced: the face goes into the page's own font set, so a plain "Nunito"
  // would shadow the page's if it happens to use one.
  const FONT_FAMILY = 'CucumberoNunito';
  // Shown on the button itself when you press it during the cooldown.
  const COOLDOWN_NUDGE = 'One break a minute';

  let host = null;
  let root = null;
  let els = {};
  let endsAt = 0;
  let breakEndsAt = 0;
  let breakMs = 10000;
  let breakReadyAt = 0; // session-wide: when another break may be taken
  let mode = 'hidden'; // hidden | blocking | break | fading
  let ticker = null;
  let nudgeTimer = null;
  let fadeTimer = null; // the pending teardown behind the end-of-session fade
  let expiryReported = false;
  let scrollLocked = false;
  let observer = null;

  // ------------------------------------------------------------- helpers ----

  // False once the extension has been reloaded, updated, or disabled out from
  // under this content script. An overlay that can't be reached must not be a
  // permanent one — it removes itself.
  const contextAlive = () => {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  };

  const send = (type, payload = {}) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, ...payload }, (r) => {
          void chrome.runtime.lastError;
          resolve(r || {});
        });
      } catch {
        resolve({});
      }
    });

  function clock(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  // Chrome ignores @font-face declared inside a shadow root and font matching is
  // document-scoped, so the face has to be added to the page's own font set. A
  // strict page CSP can still refuse the fetch — then the fallback stack stands
  // in, which is why the digit cells exist.
  //
  // Alone among what we put on the page, this survives teardown. Removing it
  // there would race its own add: the add is async, so a teardown mid-load
  // deletes nothing and the add lands on a page with no overlay left. And with
  // font-display: block, re-adding the face would leave the next overlay in this
  // tab painting invisible for a beat while it reloads — on a blocklist entry
  // with a path, that's every navigation back into it. So it stays, and
  // __cucumberoFont stays with it: clearing the flag without deleting the face
  // would stack a second copy on the next build.
  function loadFont() {
    if (window.__cucumberoFont || typeof FontFace !== 'function' || !document.fonts) return;
    window.__cucumberoFont = true;
    try {
      const url = chrome.runtime.getURL('fonts/nunito-var.woff2');
      // One variable face for the whole range, so any font-weight below renders
      // exactly rather than being snapped to the nearest static cut.
      const face = new FontFace(FONT_FAMILY, `url(${url})`, { weight: '200 1000', display: 'block' });
      face.load().then(
        (loaded) => document.fonts.add(loaded),
        () => {}
      );
    } catch {}
  }

  // Picture-in-picture draws in a browser surface above anything the page can
  // put on screen, so a blocked video could be popped out and watched over the
  // top of us. Same hole as fullscreen, which setMode already closes. Killing
  // the window handles one that's already open; disablePictureInPicture takes
  // the button out of Chrome's media hub and the video's context menu so it
  // doesn't just get reopened. Only touch videos that weren't already opted
  // out, so the page's own choice is restored intact.
  const pipDisabled = new Set();

  function blockPip() {
    if (document.pictureInPictureElement) document.exitPictureInPicture?.().catch(() => {});
    for (const video of document.querySelectorAll('video')) {
      if (!video.disablePictureInPicture) {
        video.disablePictureInPicture = true;
        pipDisabled.add(video);
      }
    }
  }

  function restorePip() {
    for (const video of pipDisabled) video.disablePictureInPicture = false;
    pipDisabled.clear();
  }

  // Re-asserted on every tick rather than set once, because the lock lives in
  // the DOM while the bookkeeping lives per-instance. An overlay orphaned by an
  // extension reload still thinks it holds the lock, so its teardown clears one
  // a fresh instance has since applied — and pages with their own scroll-lock
  // logic can overwrite the style too. Setting it is idempotent, so re-checking
  // costs a property read.
  function lockScroll(on) {
    const de = document.documentElement;
    if (!de) return;
    if (on) {
      if (de.style.overflow !== 'hidden') de.style.setProperty('overflow', 'hidden', 'important');
      scrollLocked = true;
    } else if (scrollLocked) {
      de.style.removeProperty('overflow');
      scrollLocked = false;
    }
  }

  // --------------------------------------------------------------- build ----

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; margin: 0; }

    /* Not on \`*\`: a universal font-family matches every element directly, which
       beats inheritance, so the clock's per-digit spans could never pick up the
       font set on their parent. Buttons don't inherit fonts on their own. */
    .wrap, .pill { font-family: ui-sans-serif, system-ui, -apple-system,
        "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
    button { font-family: inherit; }

    .wrap { position: fixed; inset: 0; z-index: ${Z}; }

    .veil {
      position: absolute; inset: 0;
      background: rgba(6, 8, 6, 0.94);
      backdrop-filter: blur(5px) saturate(0.4);
    }

    .panel {
      position: absolute; inset: 0;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 12px; padding: 6vh 24px; text-align: center;
      color: #e9f0e4; user-select: none; -webkit-user-select: none;
    }

    /* The variable face covers 200–1000, so any weight here is exact. */
    h1 {
      font-family: ${FONT_FAMILY}, ui-rounded, system-ui, sans-serif;
      font-size: clamp(24px, 3.8vw, 42px); line-height: 1.15; font-weight: 500;
      letter-spacing: -0.02em; max-width: 18ch; color: #f3f7f0;
    }

    .clock {
      font-family: ${FONT_FAMILY}, ui-rounded, system-ui, sans-serif;
      font-size: clamp(46px, 11vw, 88px); font-weight: 800; line-height: 1;
      color: #7cc243;
    }
    /* Nunito's digits share one advance (0.6em); the cells match it exactly and
       keep the countdown from lurching if the font is blocked and we fall back. */
    .clock .digit { display: inline-block; width: 0.6em; text-align: center; }
    .clock .sep { display: inline-block; width: 0.28em; text-align: center; }

    .actions { display: flex; flex-direction: column; gap: 10px; align-items: center; margin-top: 10px; }

    button {
      position: relative; overflow: hidden; cursor: pointer;
      border-radius: 999px; border: 1px solid rgba(233,240,228,0.22);
      background: rgba(233,240,228,0.06); color: #cfd8ca;
      font-size: 14px; font-weight: 550; letter-spacing: 0.01em;
      padding: 12px 26px; min-width: 268px;
      transition: background .15s ease, color .15s ease, border-color .15s ease;
      -webkit-tap-highlight-color: transparent;
    }
    button:hover:not([aria-disabled="true"]) { background: rgba(233,240,228,0.11); color: #f3f7f0; }
    button:focus-visible { outline: 2px solid #7cc243; outline-offset: 3px; }

    .brk {
      display: inline-flex; align-items: center; gap: 8px;
      border-color: transparent; background: transparent; color: #6f7c6b;
      font-size: 14px; min-width: 0;
    }
    .brk:hover:not([aria-disabled="true"]) { background: rgba(233,240,228,0.07); color: #cfd8ca; }
    .brk[aria-disabled="true"] { color: #4c5849; cursor: default; }
    /* Brighter while explaining itself — the inert colour is too dim to read.
       The colour transition on the button rule above makes the swap fade in. */
    .brk.nudge { color: #9fb197; }

    .brand {
      font-family: ${FONT_FAMILY}, ui-rounded, system-ui, sans-serif;
      font-weight: 700;
      position: absolute; bottom: 22px; left: 0; right: 0;
      font-size: 14px; letter-spacing: 0.18em; text-transform: lowercase; color: #6e7a6b;
    }

    .pill {
      position: fixed; right: 16px; bottom: 16px; z-index: ${Z};
      background: rgba(6,10,6,0.86); color: #9fb197; border: 1px solid rgba(124,194,67,0.3);
      border-radius: 999px; padding: 7px 14px; font-size: 12.5px; font-weight: 550;
      font-variant-numeric: tabular-nums; pointer-events: none;
      box-shadow: 0 6px 20px rgba(0,0,0,0.35);
    }

    .wrap { transition: opacity 1.6s ease; }
    .wrap.fade { opacity: 0; }

    /* No prefers-reduced-motion block: the only animation left is the fade at
       the end, and cutting that would just freeze the overlay and then blink. */
  `;

  function build() {
    const parent = document.documentElement || document.body;
    if (!parent) return false;

    // Sweep up any host left behind by a previous, now-dead instance.
    document.querySelectorAll('[data-cucumbero]').forEach((n) => n.remove());

    loadFont();

    host = document.createElement('div');
    host.setAttribute('data-cucumbero', '');
    host.style.cssText =
      `all: initial !important; position: fixed !important; inset: 0 !important;` +
      `z-index: ${Z} !important; display: block !important; visibility: visible !important;` +
      `opacity: 1 !important; pointer-events: auto !important;`;

    root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;

    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    wrap.innerHTML =
      '<div class="veil"></div>' +
      '<div class="panel">' +
      '<div class="clock">--:--</div>' +
      '<h1></h1>' +
      '<div class="actions">' +
      '<button class="brk" type="button"><span class="brk-label"></span></button>' +
      '</div>' +
      '<div class="brand">🥒 cucumbero</div>' +
      '</div>';

    const pill = document.createElement('div');
    pill.className = 'pill';
    pill.style.display = 'none';

    root.append(style, wrap, pill);
    parent.appendChild(host);

    els = {
      wrap,
      pill,
      title: wrap.querySelector('h1'),
      clock: wrap.querySelector('.clock'),
      panel: wrap.querySelector('.panel'),
      brk: wrap.querySelector('.brk'),
      brkLabel: wrap.querySelector('.brk-label'),
    };
    els.title.textContent = 'You know what you should be doing...';

    els.brk.addEventListener('click', takeBreak);

    // Some sites nuke unknown top-level nodes. Put it back.
    if (document.documentElement) {
      observer = new MutationObserver(() => {
        if (mode !== 'hidden' && host && !host.isConnected) {
          (document.documentElement || document.body)?.appendChild(host);
        }
      });
      observer.observe(document.documentElement, { childList: true });
    }

    return true;
  }

  async function takeBreak() {
    if (Date.now() < breakReadyAt) return explainCooldown();
    const res = await send('TAKE_BREAK');
    if (res.denied) {
      // Another tab used the allowance first.
      breakReadyAt = res.breakReadyAt || breakReadyAt;
      syncBreak();
      explainCooldown();
      return;
    }
    breakEndsAt = res.breakUntil || Date.now() + breakMs;
    breakReadyAt = res.breakReadyAt || breakReadyAt;
    setMode('break');
  }

  // Pressing the button mid-cooldown is the moment the rule matters, and the
  // only moment it matters — so nothing advertises the cooldown until then. A
  // click that does nothing at all reads as broken rather than refused, so the
  // button says the rule for a couple of seconds and goes back to normal.
  function explainCooldown() {
    if (!els.brk) return;
    els.brkLabel.textContent = COOLDOWN_NUDGE;
    els.brk.classList.add('nudge');
    clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(() => {
      if (!els.brk) return;
      els.brk.classList.remove('nudge');
      els.brk.dataset.cooling = ''; // force syncBreak past its flip guard
      syncBreak();
    }, 2200);
  }

  // The label never changes — spelling out the remaining seconds would invite
  // you to sit and wait for them, and you aren't meant to. On cooldown the
  // button just goes dim; the rule itself is only stated if you press it.
  // That's why this is aria-disabled and not the disabled property: a disabled
  // button receives no mouse events, so the click would be swallowed in silence
  // and there'd be nothing to explain itself. takeBreak() does the refusing.
  function syncBreak() {
    if (!els.brk) return;
    const cooling = Date.now() < breakReadyAt;
    if (els.brk.dataset.cooling === String(cooling)) return;
    els.brk.dataset.cooling = String(cooling);
    els.brk.classList.remove('nudge'); // in case the wait ended mid-explanation
    els.brkLabel.textContent = `${Math.round(breakMs / 1000)}-second break`;
    els.brk.setAttribute('aria-disabled', String(cooling));
  }

  // ---------------------------------------------------------------- modes ----

  function setMode(next) {
    // Starting a session while the last one is still fading out reuses this
    // overlay rather than rebuilding it, so the teardown fadeOut queued is still
    // pending — left alone it would fire a second later and strip the new
    // session's overlay off the page. fadeOut sets 'fading' itself and never
    // routes through here, so reaching this line means the fade was overtaken.
    clearTimeout(fadeTimer);
    fadeTimer = null;

    mode = next;
    if (!host) return;

    if (next === 'hidden') {
      lockScroll(false);
      host.style.setProperty('display', 'none', 'important');
      return;
    }

    host.style.setProperty('display', 'block', 'important');

    if (next === 'break') {
      lockScroll(false);
      restorePip(); // the break hands the page back, popping out included
      host.style.setProperty('pointer-events', 'none', 'important');
      els.wrap.style.display = 'none';
      els.pill.style.display = 'block';
    } else {
      host.style.setProperty('pointer-events', 'auto', 'important');
      els.wrap.style.display = 'block';
      els.pill.style.display = 'none';
      if (next === 'blocking') {
        lockScroll(true);
        els.wrap.classList.remove('fade');
        // A fullscreen video sits in the top layer, above any z-index we can set.
        if (document.fullscreenElement) {
          try {
            document.exitFullscreen()?.catch(() => {});
          } catch {}
        }
        blockPip();
      }
    }
    tick();
  }

  function teardown() {
    mode = 'hidden';
    lockScroll(false);
    restorePip();
    stopTicker();
    clearTimeout(nudgeTimer);
    clearTimeout(fadeTimer);
    fadeTimer = null;
    observer?.disconnect();
    observer = null;
    host?.remove();
    host = null;
    root = null;
    els = {};

    // Nothing of ours runs past this line: host, observer, ticker, nudge timer,
    // scroll lock and PiP override are all released above. The listener and the
    // window marker go too, which leaves nothing referencing this closure, so
    // the isolated world can collect it. Chrome won't unload the script itself —
    // no extension can un-inject — and an uninstall only invalidates the context
    // rather than clearing the page, so leaving it inert and unreferenced is as
    // far as this goes.
    //
    // The two have to go together. Drop the listener alone and the next inject
    // finds the marker still there, the guard up top sees alive() — the context
    // is fine, it's only this instance that's spent — and returns early without
    // registering one, leaving the tab deaf for the rest of its life.
    //
    // Cheap to undo: showOverlay messages before it injects, so a torn-down tab
    // costs one executeScript the next time it needs covering.
    //
    // The font face is the one thing left behind on purpose — see loadFont.
    try {
      chrome.runtime.onMessage.removeListener(onMessage);
    } catch {
      /* already invalidated — a reload orphan tearing itself down */
    }
    delete window.__cucumbero;
  }

  // One span per character so each digit sits in a fixed cell — see the .clock
  // rules. Rebuilt only when the string actually changes.
  function paintClock(text) {
    if (els.clock.dataset.value === text) return;
    els.clock.dataset.value = text;
    els.clock.textContent = '';
    for (const ch of text) {
      const cell = document.createElement('span');
      cell.className = ch >= '0' && ch <= '9' ? 'digit' : 'sep';
      cell.textContent = ch;
      els.clock.appendChild(cell);
    }
  }

  function tick() {
    if (!host) return;

    // Orphaned by an extension reload — nothing can control us any more.
    if (!contextAlive()) {
      teardown();
      return;
    }

    if (mode === 'break') {
      const left = breakEndsAt - Date.now();
      if (left <= 0) {
        send('END_BREAK');
        setMode('blocking');
        return;
      }
      els.pill.textContent = `🥒 back in ${Math.ceil(left / 1000)}s`;
      return;
    }

    if (mode === 'blocking') {
      syncBreak();
      lockScroll(true); // re-asserted: see the note on lockScroll
      blockPip(); // videos the page adds later, and any pop-out that slips through
      const left = endsAt - Date.now();
      paintClock(clock(left));
      // Once, not every tick: tell the worker the countdown is up, in case the
      // alarm is late. The flag is what keeps it to one message.
      if (left <= 0 && !expiryReported) {
        expiryReported = true;
        send('CHECK_EXPIRY');
      }
    }
  }

  function startTicker() {
    if (ticker) return;
    ticker = setInterval(tick, 250);
  }

  function stopTicker() {
    clearInterval(ticker);
    ticker = null;
  }

  // Timer's up. No fanfare — just get out of the way.
  function fadeOut() {
    if (!host) return;
    stopTicker();
    lockScroll(false);
    els.pill.style.display = 'none';
    if (mode === 'break') {
      teardown(); // nothing was on screen to fade
      return;
    }
    mode = 'fading';
    host.style.setProperty('pointer-events', 'none', 'important');
    els.wrap.classList.add('fade');
    fadeTimer = setTimeout(teardown, 1750); // must outlast the CSS transition
  }

  // ------------------------------------------------------------ messaging ----

  // Named rather than inline so teardown() can unregister it again.
  function onMessage(msg, _sender, sendResponse) {
    if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('CUCUMBERO_')) return false;

    if (msg.type === 'CUCUMBERO_SHOW') {
      if (!host && !build()) {
        sendResponse({ ok: false });
        return false;
      }
      endsAt = msg.endsAt;
      breakMs = msg.breakMs || breakMs;
      breakReadyAt = msg.breakReadyAt || 0;
      expiryReported = false;
      if (msg.breakUntil && msg.breakUntil > Date.now()) {
        breakEndsAt = msg.breakUntil;
        setMode('break');
      } else if (mode !== 'break') {
        setMode('blocking');
      }
      startTicker();
    } else if (msg.type === 'CUCUMBERO_DISMISS') {
      if (host) teardown();
    } else if (msg.type === 'CUCUMBERO_FINISH') {
      if (host) fadeOut();
    }

    sendResponse({ ok: true });
    return false;
  }

  chrome.runtime.onMessage.addListener(onMessage);
  // Taken down again by teardown(), together with the listener — see the note
  // there for why neither can go without the other.
  window.__cucumbero = { version: 2, alive: contextAlive, destroy: teardown };
})();
