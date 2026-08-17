// cucumbero — service worker
//
// Owns all durable state. The popup and the injected overlays are dumb clients
// that ask this file what's going on. Everything is derived from a wall-clock
// `endsAt` timestamp so an MV3 worker eviction (or a browser restart) can't
// silently end a session or strand an overlay on a page.

const ALARM_END = 'cucumbero:end';
const ALARM_TICK = 'cucumbero:tick';
const BREAK_MS = 10_000;
// A break you can take again immediately is just an off switch. The cooldown
// runs from when the break ends, and is session-wide rather than per-tab —
// per-tab would be defeated by opening the same site in a new tab.
// Kept at a minute because the overlay states the rule in words when you press
// the button too soon — change this and change COOLDOWN_NUDGE in overlay.js.
const BREAK_COOLDOWN_MS = 60_000;

const GREEN = '#7cc243';

// ---------------------------------------------------------------- state ----

async function readSession() {
  const { session = null } = await chrome.storage.local.get('session');
  return session;
}

async function readList() {
  const { blocklist = [] } = await chrome.storage.local.get('blocklist');
  return blocklist;
}

async function writeList(list) {
  await chrome.storage.local.set({ blocklist: list });
}

// Per-tab break expiry, kept in session storage so it survives worker eviction
// but not a browser restart (a break shouldn't outlive the browser).
async function readBreaks() {
  const { breaks = {} } = await chrome.storage.session.get('breaks');
  return breaks;
}

async function breakUntil(tabId) {
  const breaks = await readBreaks();
  const until = breaks[String(tabId)] || 0;
  return until > Date.now() ? until : 0;
}

// When the next break may be taken, session-wide. 0 means "right now".
async function breakReadyAt() {
  const { nextBreakAt = 0 } = await chrome.storage.session.get('nextBreakAt');
  return nextBreakAt;
}

async function setBreak(tabId, until) {
  const breaks = await readBreaks();
  const now = Date.now();
  for (const [k, v] of Object.entries(breaks)) if (v <= now) delete breaks[k];
  if (until) breaks[String(tabId)] = until;
  else delete breaks[String(tabId)];
  await chrome.storage.session.set({ breaks });
}

// Every session boundary starts the break allowance fresh.
async function resetBreaks() {
  await chrome.storage.session.set({ breaks: {}, nextBreakAt: 0 });
}

// --------------------------------------------------------------- domains ----

// Accepts anything vaguely URL-shaped and returns a bare registrable-ish host,
// or null if there's nothing usable in there.
function normalizeDomain(raw) {
  if (!raw) return null;
  let s = String(raw).trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // scheme
  s = s.replace(/^[^/@]*@/, ''); // userinfo
  s = s.split(/[/?#]/)[0]; // path, query, fragment
  s = s.replace(/:\d+$/, ''); // port
  s = s.replace(/^www\./, '');
  s = s.replace(/^\.+|\.+$/g, '');
  if (!s || !/^[a-z0-9.-]+$/.test(s)) return null;
  if (!s.includes('.') && s !== 'localhost') return null;
  return s;
}

function hostMatches(host, domain) {
  return host === domain || host.endsWith('.' + domain);
}

function urlIsBlocked(url, list) {
  if (!url || !list.length) return false;
  let host;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    host = u.hostname.toLowerCase();
  } catch {
    return false;
  }
  return list.some((d) => hostMatches(host, d));
}

// -------------------------------------------------------------- sessions ----

function sessionIsLive(session) {
  return !!session && session.endsAt > Date.now();
}

// ALARM_END is the session's real deadline; ALARM_TICK keeps the badge honest
// and re-sweeps the tabs once a minute as a self-heal.
async function armAlarms(session) {
  await chrome.alarms.clear(ALARM_END);
  await chrome.alarms.clear(ALARM_TICK);
  chrome.alarms.create(ALARM_END, { when: session.endsAt });
  chrome.alarms.create(ALARM_TICK, { periodInMinutes: 1 });
}

async function startSession(durationMs) {
  const now = Date.now();
  const session = { startedAt: now, endsAt: now + durationMs, durationMs };
  // Remembered so the next popup opens on the length you actually use. Recorded
  // at the start, so it reflects what you chose even if you abort early.
  await chrome.storage.local.set({ session, lastMinutes: Math.round(durationMs / 60000) });
  await resetBreaks();
  await armAlarms(session);
  await paintBadge(session);
  await sweepAllTabs();
  return session;
}

// The title already says the session finished, so these only have to carry the
// tone. Kept short — notification bodies get clipped at two lines.
const DONE_LINES = [
  'You can breathe now',
  'Take a breath. Stay fresh. As cucumbers do',
  'You can take a break now. Maybe snack on a cucumber',
  'The internet survived without you',
  'The cucumber is proud of you'
];

// Random, but never the same line twice running.
async function pickLine() {
  const { lastLine = -1 } = await chrome.storage.session.get('lastLine');
  const pool = DONE_LINES.map((_, i) => i).filter((i) => i !== lastLine);
  const next = pool[Math.floor(Math.random() * pool.length)];
  await chrome.storage.session.set({ lastLine: next });
  return DONE_LINES[next];
}

// The deadline has two callers — ALARM_END, and an overlay's CHECK_EXPIRY when
// its own countdown hits zero. Both await readSession() before either writes
// session: null, so the guard below doesn't stop them both getting through, and
// the session ends twice. Harmless for the storage writes, not harmless for the
// notification: the second create reuses the id, which *replaces* the first, and
// the replacement arrives before the icon has been composited. That was the
// icon flashing and vanishing. Coalescing the callers is the fix.
let ending = null;

// reason: 'stopped' (user gave up) | 'finished' (timer ran out)
function endSession(reason) {
  if (ending) return ending;
  ending = endSessionOnce(reason).finally(() => {
    ending = null;
  });
  return ending;
}

async function endSessionOnce(reason) {
  const session = await readSession();
  if (!session) return null;

  await chrome.storage.local.set({ session: null });
  await resetBreaks();
  await chrome.alarms.clear(ALARM_END);
  await chrome.alarms.clear(ALARM_TICK);
  await paintBadge(null);

  await broadcast({ type: reason === 'finished' ? 'CUCUMBERO_FINISH' : 'CUCUMBERO_DISMISS' });

  if (reason === 'finished') {
    const options = {
      type: 'basic',
      // The notification API reserves the icon slot whether or not you fill it,
      // so fill it: the 🥒 glyph on transparency, no plate behind it.
      iconUrl: chrome.runtime.getURL('icons/cucumber.png'),
      title: 'Your session has finished',
      message: await pickLine(),
      priority: 2,
    };
    // Awaited so the worker isn't torn down before Chrome has taken the
    // notification — this is the last thing endSession does.
    await new Promise((resolve) => {
      chrome.notifications.create('cucumbero:done:' + session.endsAt, options, () => {
        if (chrome.runtime.lastError) console.warn('cucumbero:', chrome.runtime.lastError.message);
        resolve();
      });
    });
  }
  return session;
}

// Lazily reconciles an expired session — covers the case where the alarm was
// missed (worker asleep during a browser restart, clock jump, etc).
async function currentSession() {
  const session = await readSession();
  if (session && session.endsAt <= Date.now()) {
    await endSession('finished');
    return null;
  }
  return session;
}

// -------------------------------------------------------------- overlays ----

async function tellTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
    return true;
  } catch {
    return false; // no overlay in that tab (or a page we can't touch)
  }
}

async function showOverlay(tabId, session) {
  const message = {
    type: 'CUCUMBERO_SHOW',
    endsAt: session.endsAt,
    breakUntil: await breakUntil(tabId), // a break survives navigation within the tab
    breakMs: BREAK_MS,
    breakReadyAt: await breakReadyAt(),
  };
  if (await tellTab(tabId, message)) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['overlay.js'],
      injectImmediately: true, // don't wait for document_idle — cover the page before it paints
    });
  } catch {
    return; // chrome://, the web store, a PDF viewer, a tab mid-crash — skip it
  }
  await tellTab(tabId, message);
}

async function broadcast(message) {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((t) => (t.id != null ? tellTab(t.id, message) : null)));
}

// Decides what a single tab deserves right now. A sweep passes `ctx` so one
// pass over every tab doesn't re-read storage per tab; note the check is for
// the context object, not for a truthy session — no session is a valid answer.
async function evaluateTab(tabId, url, ctx) {
  const session = ctx ? ctx.session : await currentSession();
  if (sessionIsLive(session)) {
    const list = ctx ? ctx.list : await readList(); // not read at all when idle
    if (urlIsBlocked(url, list)) {
      await showOverlay(tabId, session);
      return;
    }
  }
  await tellTab(tabId, { type: 'CUCUMBERO_DISMISS' });
}

async function sweepAllTabs() {
  const ctx = { session: await currentSession(), list: await readList() };
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs.map((t) => (t.id != null ? evaluateTab(t.id, t.url || t.pendingUrl, ctx) : null))
  );
}

// ----------------------------------------------------------------- badge ----

async function paintBadge(session) {
  if (!sessionIsLive(session)) {
    await chrome.action.setBadgeText({ text: '' });
    return;
  }
  const left = session.endsAt - Date.now();
  // Always minutes. An "h" reading floored the value, so 1h58 showed as "1h"
  // and kept saying it for the next hour. The badge fits ~4 characters and the
  // longest session is 720 minutes, so three digits are never a problem.
  const mins = Math.ceil(left / 60000);
  await chrome.action.setBadgeBackgroundColor({ color: GREEN });
  await chrome.action.setBadgeText({ text: String(mins) });
}

// ------------------------------------------------------------- bootstrap ----

// Runs on every worker start: install, update, extension reload, browser
// launch, and every wake from eviction. Reloading the extension kills the
// overlays already on people's tabs (they self-destruct once their context is
// invalid), so a live session has to put them straight back.
async function bootstrap(fresh) {
  if (fresh) await resetBreaks();
  const session = await currentSession();
  await paintBadge(session);
  if (!sessionIsLive(session)) return;

  // Cheaper than re-arming blind, and avoids resetting the tick alarm's phase
  // on every wake.
  if (!(await chrome.alarms.get(ALARM_END)) || !(await chrome.alarms.get(ALARM_TICK))) {
    await armAlarms(session);
  }

  // Throttled: a worker can wake many times a minute during normal browsing,
  // and a sweep touches every open tab.
  const { lastSweep = 0 } = await chrome.storage.session.get('lastSweep');
  if (Date.now() - lastSweep < 15_000) return;
  await chrome.storage.session.set({ lastSweep: Date.now() });
  await sweepAllTabs();
}

// ---------------------------------------------------------------- events ----

chrome.runtime.onInstalled.addListener(() => bootstrap(true));
chrome.runtime.onStartup.addListener(() => bootstrap(true));
bootstrap(false);

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_END) {
    await endSession('finished');
  } else if (alarm.name === ALARM_TICK) {
    const session = await currentSession();
    await paintBadge(session);
    if (sessionIsLive(session)) await sweepAllTabs();
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.url && changeInfo.status !== 'loading' && changeInfo.status !== 'complete') return;
  const url = changeInfo.url || tab.url || tab.pendingUrl;
  await evaluateTab(tabId, url);
});

// Single-page-app navigations (YouTube, Reddit, Twitter) never fire a real load.
chrome.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
  if (details.frameId !== 0) return;
  await evaluateTab(details.tabId, details.url);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await setBreak(tabId, 0);
});

// ------------------------------------------------------------- messaging ----

const handlers = {
  async GET_STATE() {
    const session = await currentSession();
    const { lastMinutes = 0 } = await chrome.storage.local.get('lastMinutes');
    return { session: sessionIsLive(session) ? session : null, blocklist: await readList(), lastMinutes };
  },

  async START({ durationMs }) {
    const ms = Math.max(60_000, Math.min(12 * 60 * 60_000, Number(durationMs) || 0));
    const session = await startSession(ms);
    return { session };
  },

  async STOP() {
    await endSession('stopped');
    return { session: null };
  },

  async ADD_SITE({ domain }) {
    const d = normalizeDomain(domain);
    if (!d) return { error: "That doesn't look like a domain." };
    const list = await readList();
    if (list.includes(d)) return { blocklist: list, already: true, domain: d };
    const next = [...list, d].sort();
    await writeList(next);
    await sweepAllTabs();
    return { blocklist: next, domain: d };
  },

  async REMOVE_SITE({ domain }) {
    const session = await currentSession();
    if (sessionIsLive(session)) return { error: 'Not during a session. That is the whole point.' };
    const next = (await readList()).filter((d) => d !== domain);
    await writeList(next);
    await sweepAllTabs();
    return { blocklist: next };
  },

  // From an overlay: give this tab BREAK_MS of peace, if it's owed one.
  async TAKE_BREAK(_payload, sender) {
    const tabId = sender?.tab?.id;
    if (tabId == null) return { error: 'no tab' };
    const now = Date.now();
    const readyAt = await breakReadyAt();
    if (now < readyAt) return { denied: true, breakReadyAt: readyAt };

    const until = now + BREAK_MS;
    await setBreak(tabId, until);
    await chrome.storage.session.set({ nextBreakAt: until + BREAK_COOLDOWN_MS });
    return { breakUntil: until, breakReadyAt: until + BREAK_COOLDOWN_MS };
  },

  async END_BREAK(_payload, sender) {
    const tabId = sender?.tab?.id;
    if (tabId != null) await setBreak(tabId, 0);
    return { ok: true };
  },

  // An overlay's local countdown hit zero — confirm it and end the session
  // immediately rather than waiting on the minute-granularity alarm.
  async CHECK_EXPIRY() {
    const session = await currentSession();
    return { session: sessionIsLive(session) ? session : null };
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return false;
  handler(message, sender).then(
    (result) => sendResponse(result ?? {}),
    (error) => sendResponse({ error: String(error?.message || error) })
  );
  return true; // async response
});
