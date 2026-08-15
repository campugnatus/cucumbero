// cucumbero — service worker
//
// Owns all durable state. The popup and the injected overlays are dumb clients
// that ask this file what's going on. Everything is derived from a wall-clock
// `endsAt` timestamp so an MV3 worker eviction (or a browser restart) can't
// silently end a session or strand an overlay on a page.

const ALARM_END = 'cucumbero:end';
const ALARM_TICK = 'cucumbero:tick';
const BREAK_MS = 20_000;

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

async function setBreak(tabId, until) {
  const breaks = await readBreaks();
  const now = Date.now();
  for (const [k, v] of Object.entries(breaks)) if (v <= now) delete breaks[k];
  if (until) breaks[String(tabId)] = until;
  else delete breaks[String(tabId)];
  await chrome.storage.session.set({ breaks });
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

async function startSession(durationMs) {
  const now = Date.now();
  const session = { startedAt: now, endsAt: now + durationMs, durationMs };
  await chrome.storage.local.set({ session });
  await chrome.storage.session.set({ breaks: {} });

  await chrome.alarms.clear(ALARM_END);
  await chrome.alarms.clear(ALARM_TICK);
  chrome.alarms.create(ALARM_END, { when: session.endsAt });
  chrome.alarms.create(ALARM_TICK, { periodInMinutes: 1 });

  await paintBadge(session);
  await sweepAllTabs();
  return session;
}

// The title already says the session finished, so these only have to carry the
// tone. Kept short — notification bodies get clipped at two lines.
const DONE_LINES = [
  'You can breathe now.',
  'Stay fresh. As cucumbers do.',
  'Was it productive? Was it?',
  'Take a break. Maybe snack on a cucumber.',
  'The internet survived without you.',
];

// Random, but never the same line twice running.
async function pickLine() {
  const { lastLine = -1 } = await chrome.storage.session.get('lastLine');
  const pool = DONE_LINES.map((_, i) => i).filter((i) => i !== lastLine);
  const next = pool[Math.floor(Math.random() * pool.length)];
  await chrome.storage.session.set({ lastLine: next });
  return DONE_LINES[next];
}

// reason: 'stopped' (user gave up) | 'finished' (timer ran out)
async function endSession(reason) {
  const session = await readSession();
  if (!session) return null;

  await chrome.storage.local.set({ session: null });
  await chrome.storage.session.set({ breaks: {} });
  await chrome.alarms.clear(ALARM_END);
  await chrome.alarms.clear(ALARM_TICK);
  await paintBadge(null);

  await broadcast({ type: reason === 'finished' ? 'CUCUMBERO_FINISH' : 'CUCUMBERO_DISMISS' });

  if (reason === 'finished') {
    const minutes = Math.round(session.durationMs / 60000);
    chrome.notifications.create('cucumbero:done:' + session.endsAt, {
      type: 'basic',
      // The notification API reserves the icon slot whether or not you fill it,
      // so fill it: the 🥒 glyph on transparency, no plate behind it.
      iconUrl: chrome.runtime.getURL('icons/cucumber.png'),
      title: `Your ${minutes}-minute session has finished`,
      message: await pickLine(),
      priority: 2,
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

async function showOverlay(tabId, session, resumeBreakUntil) {
  const message = {
    type: 'CUCUMBERO_SHOW',
    endsAt: session.endsAt,
    breakUntil: resumeBreakUntil || 0,
    breakMs: BREAK_MS,
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

// Decides what a single tab deserves right now.
async function evaluateTab(tabId, url, sessionArg, listArg) {
  const session = sessionArg !== undefined ? sessionArg : await currentSession();
  if (!sessionIsLive(session)) {
    await tellTab(tabId, { type: 'CUCUMBERO_DISMISS' });
    return;
  }
  const list = listArg !== undefined ? listArg : await readList();
  if (!urlIsBlocked(url, list)) {
    await tellTab(tabId, { type: 'CUCUMBERO_DISMISS' });
    return;
  }
  await showOverlay(tabId, session, await breakUntil(tabId));
}

async function sweepAllTabs() {
  const session = await currentSession();
  const list = await readList();
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs.map((t) => (t.id != null ? evaluateTab(t.id, t.url || t.pendingUrl, session, list) : null))
  );
}

// ----------------------------------------------------------------- badge ----

async function paintBadge(session) {
  if (!sessionIsLive(session)) {
    await chrome.action.setBadgeText({ text: '' });
    return;
  }
  const left = session.endsAt - Date.now();
  const mins = Math.ceil(left / 60000);
  await chrome.action.setBadgeBackgroundColor({ color: GREEN });
  await chrome.action.setBadgeText({ text: mins >= 60 ? Math.floor(mins / 60) + 'h' : String(mins) });
}

// ------------------------------------------------------------- bootstrap ----

// Runs on every worker start: install, update, extension reload, browser
// launch, and every wake from eviction. Reloading the extension kills the
// overlays already on people's tabs (they self-destruct once their context is
// invalid), so a live session has to put them straight back.
async function bootstrap(resetBreaks) {
  if (resetBreaks) await chrome.storage.session.set({ breaks: {} });
  const session = await currentSession();
  await paintBadge(session);
  if (!sessionIsLive(session)) return;

  if (!(await chrome.alarms.get(ALARM_END))) chrome.alarms.create(ALARM_END, { when: session.endsAt });
  if (!(await chrome.alarms.get(ALARM_TICK))) chrome.alarms.create(ALARM_TICK, { periodInMinutes: 1 });

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
    return { session: sessionIsLive(session) ? session : null, blocklist: await readList() };
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

  // From an overlay: give this tab BREAK_MS of peace.
  async TAKE_BREAK(_payload, sender) {
    const tabId = sender?.tab?.id;
    if (tabId == null) return { error: 'no tab' };
    const until = Date.now() + BREAK_MS;
    await setBreak(tabId, until);
    return { breakUntil: until };
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
