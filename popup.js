// cucumbero — popup

const HOLD_MS = 5000;

const $ = (id) => document.getElementById(id);
const el = {
  chips: $('chips'),
  custom: $('custom-min'),
  go: $('go'),
  viewIdle: $('view-idle'),
  viewActive: $('view-active'),
  clock: $('clock'),
  activeSub: $('active-sub'),
  stop: $('stop-hold'),
  stateChip: $('state-chip'),
  input: $('site-input'),
  add: $('add'),
  status: $('status'),
  toggle: $('list-toggle'),
  listWrap: $('list-wrap'),
  list: $('list'),
  count: $('list-count'),
  hint: $('list-hint'),
  empty: $('list-empty'),
};

let state = { session: null, blocklist: [], lastEnded: null };
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

function say(text, kind = '') {
  el.status.textContent = text;
  el.status.className = 'status' + (kind ? ' ' + kind : '');
}

// ---------------------------------------------------------------- render ----

function render() {
  const active = !!state.session;

  el.viewIdle.hidden = active;
  el.viewActive.hidden = !active;
  el.stateChip.textContent = active ? 'focusing' : '';
  el.stateChip.classList.toggle('on', active);

  el.count.textContent = String(state.blocklist.length);
  el.list.innerHTML = '';
  for (const domain of state.blocklist) {
    const li = document.createElement('li');
    const host = document.createElement('span');
    host.className = 'host';
    host.textContent = domain;
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.textContent = '×';
    rm.title = active ? 'Locked during a session' : 'Remove';
    rm.disabled = active;
    rm.addEventListener('click', async () => {
      const res = await send('REMOVE_SITE', { domain });
      if (res.error) return say(res.error, 'err');
      state.blocklist = res.blocklist;
      say(`Removed ${domain}.`);
      render();
    });
    li.append(host, rm);
    el.list.appendChild(li);
  }
  el.hint.hidden = !active || state.blocklist.length === 0;
  el.empty.hidden = state.blocklist.length !== 0;

  syncInputAffordance();
  tick();
}

function tick() {
  if (!state.session) return;
  const left = state.session.endsAt - Date.now();
  el.clock.textContent = clock(left);
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
  if (!state.session && state.lastEnded && Date.now() - state.lastEnded.at < 90_000) {
    say(state.lastEnded.reason === 'finished' ? 'Session complete. You can breathe now. 🥒' : 'Session stopped.', 'ok');
  }
}

// ------------------------------------------------------------- duration ----

function selectedMinutes() {
  const custom = Number(el.custom.value);
  if (custom > 0) return Math.min(720, Math.max(1, Math.round(custom)));
  const on = el.chips.querySelector('.chip.is-on');
  return on ? Number(on.dataset.min) : 45;
}

el.chips.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip[data-min]');
  if (!chip) return;
  el.chips.querySelectorAll('.chip').forEach((c) => c.classList.remove('is-on'));
  chip.classList.add('is-on');
  el.custom.value = '';
});

el.custom.addEventListener('input', () => {
  const has = Number(el.custom.value) > 0;
  el.chips.querySelectorAll('.chip[data-min]').forEach((c) => c.classList.remove('is-on'));
  el.custom.closest('.chip').classList.toggle('is-on', has);
  if (!has) el.chips.querySelector('.chip[data-min="45"]').classList.add('is-on');
});

el.go.addEventListener('click', async () => {
  if (!state.blocklist.length) {
    say('Add at least one site first, or this does nothing.', 'err');
    el.input.focus();
    return;
  }
  const minutes = selectedMinutes();
  const res = await send('START', { durationMs: minutes * 60_000 });
  if (res.error) return say(res.error, 'err');
  say(`${minutes} minutes. Go.`, 'ok');
  await refresh();
});

el.custom.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') el.go.click();
});

// ---------------------------------------------------------- hold to stop ----

(function wireHold() {
  const b = el.stop;
  const fill = b.querySelector('.fill');
  const label = b.querySelector('.label-text');
  let raf = null;
  let start = 0;

  const reset = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = null;
    b.classList.remove('armed');
    b.classList.add('releasing');
    fill.style.width = '0%';
    label.textContent = 'hold to stop focusing';
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
        say('Session stopped. Was it worth it?');
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

function syncInputAffordance() {
  const typed = el.input.value.trim().toLowerCase().replace(/^www\./, '');
  const known = typed && state.blocklist.some((d) => d === typed);
  el.add.textContent = known ? 'Blocked' : 'Block';
  el.add.disabled = !!known;
  el.add.style.opacity = known ? '0.5' : '';
}

el.input.addEventListener('input', syncInputAffordance);

async function addSite() {
  const raw = el.input.value.trim();
  if (!raw) return say('Type a domain first.', 'err');
  const res = await send('ADD_SITE', { domain: raw });
  if (res.error) return say(res.error, 'err');
  state.blocklist = res.blocklist;
  say(res.already ? `${res.domain} was already on the list.` : `Blocking ${res.domain}.`, res.already ? '' : 'ok');
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

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const url = new URL(tab?.url || '');
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      el.input.value = url.hostname.replace(/^www\./, '');
    }
  } catch {
    /* chrome://, new tab, etc. — leave the field empty */
  }
  syncInputAffordance();

  if (state.blocklist.length && !state.session) {
    el.toggle.setAttribute('aria-expanded', 'false');
  }
})();
