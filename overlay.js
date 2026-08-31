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

  // Drawn instead of the 🥒 character, which the OS renders from whatever emoji
  // font it has — Windows supplied a different cucumber from the one in the
  // toolbar. Guarded because a throw out here would take the whole script with
  // it, listener included; an empty url simply doesn't paint.
  const ICON_URL = (() => {
    try {
      return chrome.runtime.getURL('icons/cucumber.png');
    } catch {
      return '';
    }
  })();

  let host = null;
  let els = {};
  let startedAt = 0;
  let endsAt = 0; // null on an open-ended session, which counts up from startedAt
  let breakEndsAt = 0;
  let breakMs = 10000;
  let breakReadyAt = 0; // session-wide: when another break may be taken
  let coolingShown = null; // what syncBreak last painted; null means repaint it
  let mode = 'hidden'; // hidden | blocking | break | fading
  let ticker = null;
  let nudgeTimer = null;
  let fadeTimer = null; // the pending teardown behind the end-of-session fade
  // One shot per session: we've told the worker the local clock says this
  // session shouldn't still be running — either its countdown reached zero or
  // it claims to have started in the future.
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

  // The blur sits on the host rather than on .veil (see the note there), which
  // puts it outside .wrap — so it neither hides with the wrap during a break nor
  // fades with it at the end. Driven by hand instead: off while a break hands
  // the page back, and eased out over 1s when a session ends, against the 1.6s
  // the veil itself takes. Zeroed rather than set to none, because a filter list
  // interpolates against another list and not against a keyword.
  const BLUR = 'blur(6px) saturate(0.4)';
  // Only the eased path needs this: a filter list interpolates against another
  // list and not against a keyword. Switching off outright uses `none`, which
  // drops the compositing layer instead of leaving a full-viewport one applying
  // an identity filter for the length of a break.
  const ZERO_BLUR = 'blur(0px) saturate(1)';

  function setBlur(on, ease = false) {
    if (!host) return;
    // Set first: the transition has to be in place before the value it applies
    // to changes, or the recalc sees a plain assignment and jumps.
    host.style.setProperty('transition', ease ? 'backdrop-filter 1s ease' : 'none', 'important');
    const to = on ? BLUR : ease ? ZERO_BLUR : 'none';
    host.style.setProperty('backdrop-filter', to, 'important');
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

    .wrap {
      position: fixed; inset: 0; z-index: ${Z};
      transition: opacity 1.6s ease;
    }
    .wrap.fade { opacity: 0; }

    /* The blur is on the host, not here: view-transition-name makes the host a
       backdrop root, and backdrop-filter only samples what's painted behind the
       element up to its nearest backdrop-root ancestor. From in here that's the
       host, with nothing behind us inside it — the rule applied and filtered an
       empty backdrop. On the host itself it reaches the page again. */
    .veil {
      position: absolute; inset: 0;
      background: rgba(6, 8, 6, 0.95);
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

    /* A pseudo-element, so the pill's per-tick textContent write doesn't have to
       rebuild it. Sized in em to track whatever font-size it sits next to. */
    .brand::before, .pill::before {
      content: '';
      display: inline-block;
      width: 1.6em; height: 1.6em;
      margin-right: 0.35em;
      vertical-align: -0.5em;
      background: url("${ICON_URL}") center / contain no-repeat;
    }

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
      `opacity: 1 !important; pointer-events: auto !important;` +
      // No backdrop-filter here even though this is where it ends up: setBlur
      // owns it, and setMode('blocking') runs it in the same task as this build,
      // so there's nothing to see in between. Naming the blur twice is how the
      // two got out of step in the first place.
      //
      // A view transition paints its pseudo-element tree in the top layer, which
      // outranks any z-index we can set, the way a modal dialog does. Every
      // element the page named is captured as its own group above the root
      // snapshot — and an overlay without a name of its own sits inside that
      // root snapshot, underneath, so the page's UI draws over the veil for the
      // length of the transition. YouTube runs one when the watch page settles
      // into its real layout, and its spinner and player buttons came through.
      //
      // Naming ourselves makes us a participant instead: groups paint in capture
      // order, capture follows paint order, and a fixed element at the top of the
      // z-order is captured last, so ours lands above the page's. Inert whenever
      // no transition is running. For the ~300ms one does run we're a snapshot,
      // so the clock holds still and clicks land on the page's root — both too
      // brief to notice, and neither lets anything through.
      //
      // Our group picks up the UA's own animations, which are visible in exactly
      // two cases: the viewport changing size across a transition, which morphs
      // the group and leaves a strip at the edge, and the overlay appearing
      // mid-transition, which fades it in from transparent. Both were left
      // alone. What shows through either way is the frozen snapshot, not a live
      // page, and in the second case the transition was already showing a
      // snapshot taken before we existed. A stylesheet zeroing those durations
      // fixed neither case fully and cost a style element in someone else's
      // document, re-asserted every tick.
      `view-transition-name: cucumbero-overlay !important;`;

    const root = host.attachShadow({ mode: 'closed' });
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
      '<div class="brand">cucumbero</div>' +
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
      brk: wrap.querySelector('.brk'),
      brkLabel: wrap.querySelector('.brk-label'),
    };
    els.title.textContent = 'You know what you should be doing...';
    coolingShown = null; // a fresh button carries none of the old one's state

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
      coolingShown = null; // the label is the nudge now, so make syncBreak repaint
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
    if (coolingShown === cooling) return; // called four times a second; paint on the flip
    coolingShown = cooling;
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

    // The two branches below are exhaustive: going quiet is teardown's job, and
    // it removes the host rather than hiding it. 'hidden' and 'fading' are still
    // modes, but both are set directly by whoever enters them — 'hidden' so the
    // observer knows not to re-append what teardown just took out. A third mode
    // arriving here would match neither and leave the overlay as it was, which
    // is the better failure: stuck where you can see it, rather than quietly
    // blocking under a mode that never meant to.
    host.style.setProperty('display', 'block', 'important');

    if (next === 'break') {
      lockScroll(false);
      restorePip(); // the break hands the page back, popping out included
      setBlur(false); // unblurred, or the page stays behind frosted glass
      host.style.setProperty('pointer-events', 'none', 'important');
      els.wrap.style.display = 'none';
      els.pill.style.display = 'block';
    } else if (next === 'blocking') {
      lockScroll(true);
      setBlur(true); // back on after a break, and undoes a fade we overtook
      host.style.setProperty('pointer-events', 'auto', 'important');
      els.wrap.style.display = 'block';
      els.pill.style.display = 'none';
      els.wrap.classList.remove('fade');
      // A fullscreen video sits in the top layer, above any z-index we can set.
      if (document.fullscreenElement) {
        try {
          document.exitFullscreen()?.catch(() => {});
        } catch {}
      }
      blockPip();
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
      els.pill.textContent = `back in ${Math.ceil(left / 1000)}s`;
      return;
    }

    if (mode === 'blocking') {
      syncBreak();
      lockScroll(true); // re-asserted: see the note on lockScroll
      blockPip(); // videos the page adds later, and any pop-out that slips through
      // Started in the future, so the system clock moved backwards. Checked for
      // both modes and before either of them: a countdown can't notice this on
      // its own, because a backward jump only pushes its deadline further out
      // and makes `left` larger. The worker decides what to do about it; this is
      // here so it finds out now rather than on its next minute alarm, which the
      // same jump may have pushed hours away. Our own interval is unaffected —
      // it measures elapsed time, not wall-clock arrivals.
      const up = Date.now() - startedAt;
      if (up < 0 && !expiryReported) {
        expiryReported = true;
        send('CHECK_EXPIRY');
      }

      // Counting up has no deadline to report and nothing to reach zero, so the
      // expiry check below belongs only to the countdown.
      if (endsAt === null) {
        paintClock(clock(up));
        return;
      }
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
    setBlur(false, true); // eased out alongside the veil
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
      startedAt = msg.startedAt || 0;
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
  window.__cucumbero = { alive: contextAlive, destroy: teardown };
})();
