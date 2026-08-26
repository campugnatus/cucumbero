// cucumbero — popup

const HOLD_MS = 5000;

const $ = (id) => document.getElementById(id);
const el = {
  minutes: $('minutes'),
  minus: $('minus'),
  plus: $('plus'),
  go: $('go'),
  viewIdle: $('view-idle'),
  viewActive: $('view-active'),
  clock: $('clock'),
  stop: $('stop-hold'),
  input: $('site-input'),
  add: $('add'),
  status: $('status'),
  toggle: $('list-toggle'),
  listWrap: $('list-wrap'),
  list: $('list'),
  count: $('list-count'),
  empty: $('list-empty'),
};

let state = { session: null, blocklist: [] };
let ticker = null;

const send = (type, payload = {}) =>
  new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...payload }, (r) => {
      void chrome.runtime.lastError;
      resolve(r || {});
    });
  });

function clock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

// Remove-button glyph. Inherits its colour from the button via currentColor,
// and is hidden from the accessibility tree — the button carries an aria-label.
const ICON_X =
  '<svg viewBox="0 0 121.31 122.876" aria-hidden="true" focusable="false">' +
  '<path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M90.914,5.296' +
  'c6.927-7.034,18.188-7.065,25.154-0.068c6.961,6.995,6.991,18.369,0.068,25.397L85.743,61.452' +
  'l30.425,30.855c6.866,6.978,6.773,18.28-0.208,25.247c-6.983,6.964-18.21,6.946-25.074-0.031' +
  'L60.669,86.881L30.395,117.58c-6.927,7.034-18.188,7.065-25.154,0.068c-6.961-6.995-6.992-18.369' +
  '-0.068-25.397l30.393-30.827L5.142,30.568c-6.867-6.978-6.773-18.28,0.208-25.247' +
  'c6.983-6.963,18.21-6.946,25.074,0.031l30.217,30.643L90.914,5.296L90.914,5.296z"/></svg>';

// Errors only. Anything that worked speaks for itself in the UI; pass '' to
// clear a stale complaint once the user has fixed it.
function say(text) {
  el.status.textContent = text;
}

// ---------------------------------------------------------------- render ----

function render() {
  const active = !!state.session;

  el.viewIdle.hidden = active;
  el.viewActive.hidden = !active;

  el.count.textContent = String(state.blocklist.length);
  el.list.innerHTML = '';
  for (const domain of state.blocklist) {
    const li = document.createElement('li');
    const host = document.createElement('span');
    host.className = 'host';
    host.textContent = domain;
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.innerHTML = ICON_X;
    rm.title = active ? 'Locked during a session' : 'Remove';
    // The glyph is decorative, so the button needs a name of its own.
    rm.setAttribute('aria-label', `Remove ${domain}`);
    rm.disabled = active;
    rm.addEventListener('click', async () => {
      const res = await send('REMOVE_SITE', { domain });
      if (res.error) return say(res.error);
      state.blocklist = res.blocklist;
      say('');
      render();
    });
    li.append(host, rm);
    el.list.appendChild(li);
  }
  // The "locked during a session" note is gone from the markup; the disabled
  // × buttons carry a title attribute instead.
  el.empty.hidden = state.blocklist.length !== 0;

  syncAddButton();
  tick();
}

// One span per character so CSS can pin each digit to a fixed cell — see the
// .clock rules. Rebuilt only when the string actually changes.
function paintClock(text) {
  if (el.clock.dataset.value === text) return;
  el.clock.dataset.value = text;
  el.clock.textContent = '';
  for (const ch of text) {
    const cell = document.createElement('span');
    cell.className = ch >= '0' && ch <= '9' ? 'digit' : 'sep';
    cell.textContent = ch;
    el.clock.appendChild(cell);
  }
}

function tick() {
  if (!state.session) return;
  const left = state.session.endsAt - Date.now();
  paintClock(clock(left));
  if (left <= 0) refresh();
}

async function refresh() {
  state = await send('GET_STATE');
  render();
  if (state.session && !ticker) ticker = setInterval(tick, 250);
  if (!state.session && ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

// ------------------------------------------------------------- duration ----

const STEP = 15; // the +/- buttons work in quarter hours
const MIN_TYPED = 1; // you can type a 1-minute session; the buttons won't go there
const MAX_MIN = 720;
// The last length actually started, seeded at boot; 45 until there's a session
// to learn from. Stands in wherever the field holds nothing usable — you
// probably want the same length again.
let defaultMinutes = 45;

// What the field currently means, empty or mistyped included.
function currentMinutes() {
  const n = parseInt(el.minutes.value, 10);
  return Number.isFinite(n) ? n : defaultMinutes;
}

// Normalizes the box into a number we're willing to run with, and writes it back.
function commitMinutes() {
  const v = Math.min(MAX_MIN, Math.max(MIN_TYPED, currentMinutes()));
  el.minutes.value = String(v);
  syncStepper();
  return v;
}

function syncStepper() {
  const v = currentMinutes();
  el.minus.disabled = v <= STEP;
  el.plus.disabled = v >= MAX_MIN;
}

// Snaps to the 15-minute grid rather than blindly adding: from 20, "+" gives
// 30, not 35.
function stepBy(dir) {
  const base = currentMinutes();
  if (dir < 0 && base <= STEP) return;
  const next =
    dir > 0 ? Math.floor(base / STEP) * STEP + STEP : Math.ceil(base / STEP) * STEP - STEP;
  el.minutes.value = String(Math.min(MAX_MIN, Math.max(STEP, next)));
  syncStepper();
  el.minutes.focus();
  el.minutes.select();
}

el.minus.addEventListener('click', () => stepBy(-1));
el.plus.addEventListener('click', () => stepBy(1));

el.minutes.addEventListener('input', () => {
  const digits = el.minutes.value.replace(/\D+/g, '').slice(0, 3);
  if (digits !== el.minutes.value) el.minutes.value = digits;
  syncStepper();
});
el.minutes.addEventListener('blur', commitMinutes);
el.minutes.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') el.go.click();
  else if (e.key === 'ArrowUp') (e.preventDefault(), stepBy(1));
  else if (e.key === 'ArrowDown') (e.preventDefault(), stepBy(-1));
});

el.go.addEventListener('click', async () => {
  if (!state.blocklist.length) {
    // Refused rather than allowed as a bare timer, because of who hits this:
    // someone with an empty list is almost always a first-timer, and a session
    // that blocks nothing looks identical to an extension that doesn't work.
    say('Add at least one site first, or this does nothing.');
    el.input.focus();
    return;
  }
  const minutes = commitMinutes();
  const res = await send('START', { durationMs: minutes * 60_000 });
  if (res.error) return say(res.error);
  say('');
  await refresh();
});

// --------------------------------------------------------- hold to abort ----

(function wireHold() {
  const b = el.stop;
  const fill = b.querySelector('.fill');
  const label = b.querySelector('.label-text');
  // Authored in popup.html — captured so the reset path can't drift from it.
  const idleLabel = label.textContent;
  let raf = null;
  let start = 0;

  const reset = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = null;
    b.classList.remove('armed');
    b.classList.add('releasing');
    fill.style.width = '0%';
    label.textContent = idleLabel;
  };

  b.addEventListener('pointerdown', (e) => {
    if (raf) return;
    e.preventDefault();
    start = performance.now();
    b.classList.add('armed');
    b.classList.remove('releasing');
    try {
      b.setPointerCapture(e.pointerId);
    } catch {}
    const step = async () => {
      const held = performance.now() - start;
      const pct = Math.min(1, held / HOLD_MS);
      fill.style.width = pct * 100 + '%';
      label.textContent = pct >= 1 ? 'ok, fine.' : `keep holding… ${((HOLD_MS - held) / 1000).toFixed(1)}s`;
      if (pct >= 1) {
        raf = null;
        await send('STOP');
        reset();
        await refresh();
        return;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => b.addEventListener(ev, reset));
  b.addEventListener('contextmenu', (e) => e.preventDefault());
})();

// -------------------------------------------------------------- add site ----

// Named for what it updates: the Block button, not the input it reads from.
// It goes inert and reads "Blocked" once what's typed is already on the list.
function syncAddButton() {
  const typed = el.input.value.trim().toLowerCase().replace(/^www\./, '');
  const known = typed && state.blocklist.some((d) => d === typed);
  el.add.textContent = known ? 'Blocked' : 'Block';
  el.add.disabled = !!known;
}

el.input.addEventListener('input', syncAddButton);

async function addSite() {
  const raw = el.input.value.trim();
  if (!raw) return say('Type a domain first.');
  const res = await send('ADD_SITE', { domain: raw });
  if (res.error) return say(res.error);
  state.blocklist = res.blocklist;
  say('');
  el.input.value = res.domain;
  render();
}

el.add.addEventListener('click', addSite);
el.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addSite();
});

// ------------------------------------------------------------------ list ----

el.toggle.addEventListener('click', () => {
  const open = el.toggle.getAttribute('aria-expanded') === 'true';
  el.toggle.setAttribute('aria-expanded', String(!open));
  el.listWrap.hidden = open;
});

// ------------------------------------------------------------------ boot ----

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.session || changes.blocklist)) refresh();
});

(async function init() {
  await refresh();

  // Seeded once here rather than in render(), which re-runs on every storage
  // change and would overwrite whatever you were typing.
  if (state.lastMinutes) {
    defaultMinutes = state.lastMinutes;
    el.minutes.value = String(state.lastMinutes);
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const url = new URL(tab?.url || '');
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      el.input.value = url.hostname.replace(/^www\./, '');
    }
  } catch {
    /* chrome://, new tab, etc. — leave the field empty */
  }
  syncAddButton();
  syncStepper();

  // Open with the duration selected so you can type over it and hit Enter.
  // Only when idle — during a session there's nothing to type there, and the
  // site field is pre-filled with something we don't want clobbered.
  if (!state.session) {
    el.minutes.focus();
    el.minutes.select();
  }
})();
