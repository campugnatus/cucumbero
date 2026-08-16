// cucumbero — the black rectangle.
//
// Injected on demand by the service worker into tabs that match the block list.
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

  const HOLD_MS = 5000; // hold-to-stop duration
  const Z = '2147483647';
  // Namespaced: the face goes into the page's own font set, so a plain "Nunito"
  // would shadow the page's if it happens to use one.
  const FONT_FAMILY = 'CucumberoNunito';
  const COOLDOWN_HINT = 'One break a minute';

  let host = null;
  let root = null;
  let els = {};
  let endsAt = 0;
  let breakEndsAt = 0;
  let breakMs = 10000;
  let breakReadyAt = 0; // session-wide: when another break may be taken
  let mode = 'hidden'; // hidden | blocking | break | fading
  let ticker = null;
  let holdRaf = null;
  let holdStart = 0;
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
  function loadFont() {
    if (window.__cucumberoFont || typeof FontFace !== 'function' || !document.fonts) return;
    window.__cucumberoFont = true;
    try {
      const url = chrome.runtime.getURL('fonts/nunito-800.woff2');
      const face = new FontFace(FONT_FAMILY, `url(${url})`, { weight: '800', display: 'block' });
      face.load().then(
        (loaded) => document.fonts.add(loaded),
        () => {}
      );
    } catch {}
  }

  function lockScroll(on) {
    const de = document.documentElement;
    if (!de) return;
    if (on && !scrollLocked) {
      de.style.setProperty('overflow', 'hidden', 'important');
      scrollLocked = true;
    } else if (!on && scrollLocked) {
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
      background: rgba(6, 10, 6, 0.93);
      backdrop-filter: blur(3px) saturate(0.4);
      -webkit-backdrop-filter: blur(3px) saturate(0.4);
    }

    .panel {
      position: absolute; inset: 0;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 22px; padding: 6vh 24px; text-align: center;
      color: #e9f0e4; user-select: none; -webkit-user-select: none;
    }

    h1 {
      font-size: clamp(24px, 3.8vw, 46px); line-height: 1.15; font-weight: 650;
      letter-spacing: -0.02em; max-width: 18ch; color: #f3f7f0;
    }

    .clock {
      font-family: ${FONT_FAMILY}, ui-rounded, system-ui, sans-serif;
      font-size: clamp(46px, 11vw, 104px); font-weight: 800; line-height: 1;
      color: #7cc243;
    }
    /* Nunito's digits share one advance (0.6em); the cells match it exactly and
       keep the countdown from lurching if the font is blocked and we fall back. */
    .clock .digit { display: inline-block; width: 0.6em; text-align: center; }
    .clock .sep { display: inline-block; width: 0.28em; text-align: center; }
    .sub { font-size: 13px; letter-spacing: 0.14em; text-transform: uppercase; color: #7d8a78; }

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

    .hold { touch-action: none; }
    .hold .fill {
      position: absolute; inset: 0; width: 0%;
      background: linear-gradient(90deg, rgba(124,194,67,0.35), rgba(124,194,67,0.6));
      transition: width .08s linear;
    }
    .hold.releasing .fill { transition: width .25s ease-out; }
    .hold .label { position: relative; }
    .hold.armed { border-color: rgba(124,194,67,0.65); color: #f3f7f0; }

    .brk { border-color: transparent; background: transparent; color: #6f7c6b; font-size: 13px; min-width: 0; }
    .brk:hover:not([aria-disabled="true"]) { background: rgba(233,240,228,0.07); color: #cfd8ca; }
    .brk[aria-disabled="true"] { color: #4c5849; cursor: default; }

    .brand {
      font-family: ${FONT_FAMILY}, ui-rounded, system-ui, sans-serif;
      font-weight: 700;
      position: absolute; bottom: 22px; left: 0; right: 0;
      font-size: 12px; letter-spacing: 0.18em; text-transform: lowercase; color: #4c5849;
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

    @media (prefers-reduced-motion: reduce) {
      /* the fade stays — cutting it would just freeze the overlay, then blink */
      .hold .fill { transition: none; }
    }
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
      '<h1></h1>' +
      '<div><div class="clock">--:--</div><div class="sub">left in this session</div></div>' +
      '<div class="actions">' +
      '<button class="hold" type="button"><span class="fill"></span><span class="label">hold to stop focusing</span></button>' +
      '<button class="brk" type="button"></button>' +
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
      sub: wrap.querySelector('.sub'),
      panel: wrap.querySelector('.panel'),
      hold: wrap.querySelector('.hold'),
      holdFill: wrap.querySelector('.fill'),
      holdLabel: wrap.querySelector('.label'),
      brk: wrap.querySelector('.brk'),
    };
    els.title.textContent = 'You know what you should be doing...';

    wireHold();
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

  // ------------------------------------------------------ hold-to-stop ----

  function wireHold() {
    const b = els.hold;
    const start = (e) => {
      if (mode !== 'blocking') return;
      e.preventDefault();
      if (holdRaf) return;
      holdStart = performance.now();
      b.classList.add('armed');
      b.classList.remove('releasing');
      try {
        b.setPointerCapture(e.pointerId);
      } catch {}
      const step = () => {
        const held = performance.now() - holdStart;
        const pct = Math.min(1, held / HOLD_MS);
        els.holdFill.style.width = pct * 100 + '%';
        const left = Math.max(0, HOLD_MS - held) / 1000;
        els.holdLabel.textContent = pct >= 1 ? 'ok, fine.' : `keep holding… ${left.toFixed(1)}s`;
        if (pct >= 1) {
          holdRaf = null;
          giveUp();
          return;
        }
        holdRaf = requestAnimationFrame(step);
      };
      holdRaf = requestAnimationFrame(step);
    };
    const cancel = () => {
      if (!holdRaf) return;
      cancelAnimationFrame(holdRaf);
      holdRaf = null;
      b.classList.remove('armed');
      b.classList.add('releasing');
      els.holdFill.style.width = '0%';
      els.holdLabel.textContent = 'hold to stop focusing';
    };
    b.addEventListener('pointerdown', start);
    b.addEventListener('pointerup', cancel);
    b.addEventListener('pointercancel', cancel);
    b.addEventListener('pointerleave', cancel);
    b.addEventListener('contextmenu', (e) => e.preventDefault());
    b.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') e.preventDefault(); // no keyboard shortcut out of it
    });
  }

  async function giveUp() {
    els.holdLabel.textContent = 'stopping…';
    await send('STOP');
    // The worker broadcasts CUCUMBERO_DISMISS; this is just a safety net.
    setTimeout(() => {
      if (mode === 'blocking') teardown();
    }, 600);
  }

  async function takeBreak() {
    if (Date.now() < breakReadyAt) return; // button is disabled; belt and braces
    const res = await send('TAKE_BREAK');
    if (res.denied) {
      // Another tab used the allowance first.
      breakReadyAt = res.breakReadyAt || breakReadyAt;
      syncBreak();
      return;
    }
    breakEndsAt = res.breakUntil || Date.now() + breakMs;
    breakReadyAt = res.breakReadyAt || breakReadyAt;
    setMode('break');
  }

  // The label never changes — a visible countdown would just invite you to sit
  // and wait for it. On cooldown the button goes inert and explains itself on
  // hover. aria-disabled rather than the disabled property, because a disabled
  // button gets no mouse events and so never shows its tooltip; takeBreak()
  // does the actual refusing.
  function syncBreak() {
    if (!els.brk) return;
    const cooling = Date.now() < breakReadyAt;
    if (els.brk.dataset.cooling === String(cooling)) return;
    els.brk.dataset.cooling = String(cooling);
    els.brk.textContent = `${Math.round(breakMs / 1000)}-second break`;
    els.brk.setAttribute('aria-disabled', String(cooling));
    els.brk.title = cooling ? COOLDOWN_HINT : '';
  }

  // ---------------------------------------------------------------- modes ----

  function setMode(next) {
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
        // Reset anything the tail end of a previous session left behind.
        els.sub.textContent = 'left in this session';
        els.holdFill.style.width = '0%';
        els.holdLabel.textContent = 'hold to stop focusing';
        // A fullscreen video sits in the top layer, above any z-index we can set.
        if (document.fullscreenElement) {
          try {
            document.exitFullscreen()?.catch(() => {});
          } catch {}
        }
      }
    }
    tick();
  }

  function teardown() {
    mode = 'hidden';
    lockScroll(false);
    if (ticker) {
      clearInterval(ticker);
      ticker = null;
    }
    observer?.disconnect();
    observer = null;
    host?.remove();
    host = null;
    root = null;
    els = {};
    // window.__cucumbero stays set on purpose: the message listener below is
    // still live and will rebuild on demand, so a re-inject would only add a
    // duplicate listener.
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
      const left = endsAt - Date.now();
      paintClock(clock(left));
      if (left <= 0 && !expiryReported) {
        expiryReported = true;
        els.sub.textContent = 'wrapping up…';
        send('CHECK_EXPIRY');
      }
    }
  }

  function startTicker() {
    if (ticker) return;
    ticker = setInterval(tick, 250);
  }

  // Timer's up. No fanfare — just get out of the way.
  function fadeOut() {
    if (!host) return;
    if (ticker) {
      clearInterval(ticker);
      ticker = null;
    }
    lockScroll(false);
    els.pill.style.display = 'none';
    if (mode === 'break') {
      teardown(); // nothing was on screen to fade
      return;
    }
    mode = 'fading';
    host.style.setProperty('pointer-events', 'none', 'important');
    els.wrap.classList.add('fade');
    setTimeout(teardown, 1750); // must outlast the CSS transition
  }

  // ------------------------------------------------------------ messaging ----

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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
  });

  window.__cucumbero = { version: 2, alive: contextAlive, destroy: teardown };
})();
