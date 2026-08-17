// Fakes just enough of the extension APIs for popup.js to run on a plain page.
// Loaded before popup.js by tools/preview.py — never shipped in the extension.
//
// State is chosen by query string: ?active=1 for a running session,
// ?list=1 to auto-expand the blocklist.

const params = new URLSearchParams(location.search);

const STATE = {
  session:
    params.get('active') === '1'
      ? { endsAt: Date.now() + 23 * 60000 + 41000, durationMs: 45 * 60000 }
      : null,
  blocklist: ['news.ycombinator.com', 'reddit.com', 'twitter.com', 'youtube.com'],
};

window.chrome = {
  runtime: {
    lastError: null,
    sendMessage(msg, cb) {
      let reply = {};
      if (msg.type === 'GET_STATE') reply = { session: STATE.session, blocklist: STATE.blocklist };
      else if (msg.type === 'ADD_SITE') reply = { blocklist: STATE.blocklist, domain: msg.domain };
      else if (msg.type === 'REMOVE_SITE') reply = { blocklist: STATE.blocklist };
      setTimeout(() => cb(reply), 0);
    },
  },
  tabs: {
    query: () => Promise.resolve([{ url: 'https://www.reddit.com/r/all' }]),
  },
  storage: {
    onChanged: { addListener() {} },
  },
};

if (params.get('list') === '1') {
  addEventListener('load', () => setTimeout(() => document.getElementById('list-toggle').click(), 30));
}
