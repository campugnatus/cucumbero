// Tests for the blocklist matching rules.
//
//     node tools/test-matching.js
//
// This is the one piece of logic where a mistake is both easy to make and
// invisible in use: over-blocking is merely annoying, but under-blocking means
// a site you asked to be kept away from quietly works. The lookalike and suffix
// cases below are the ones worth guarding.
//
// background.js is a service worker, not a module, so the functions are lifted
// out by source markers rather than imported. If the markers move, this fails
// loudly rather than testing nothing.

const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const from = source.indexOf('// Accepts anything vaguely URL-shaped');
const to = source.indexOf('// -------------------------------------------------------------- sessions');
if (from === -1 || to === -1 || to < from) {
  console.error('test-matching: could not find the entry-matching section in background.js');
  process.exit(1);
}
const { normalizeEntry, urlIsBlocked } = new Function(
  source.slice(from, to) + '; return { normalizeEntry, urlIsBlocked };'
)();

let failures = 0;
function check(label, got, want) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failures++;
    console.log(`FAIL  ${label}\n      got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

// --------------------------------------------------------- normalizeEntry ----

const normalizations = [
  ['google.com/maps', 'google.com/maps'],
  ['https://www.google.com/maps/', 'google.com/maps'],
  ['https://yandex.com.ge/maps/10277/tbilisi', 'yandex.com.ge/maps/10277/tbilisi'],
  ['https://youtube.com/watch?v=abc#t=10', 'youtube.com/watch'], // query is per-visit
  ['REDDIT.com/r/Rust', 'reddit.com/r/rust'],
  ['example.com:8080/news', 'example.com/news'],
  ['http://user:pw@news.ycombinator.com/', 'news.ycombinator.com'],
  ['  twitter.com/  ', 'twitter.com'],
  ['reddit.com', 'reddit.com'],
  ['localhost:3000', 'localhost'],
  ['not a domain', null],
  ['', null],
];
for (const [input, want] of normalizations) {
  check(`normalize ${JSON.stringify(input)}`, normalizeEntry(input), want);
}

// ------------------------------------------------------------ urlIsBlocked ----

const matches = [
  // A path narrows to a section without touching the rest of the domain.
  [['google.com/maps'], 'https://google.com/maps/place/x', true],
  [['google.com/maps'], 'https://google.com/maps', true],
  [['google.com/maps'], 'https://mail.google.com/', false],
  [['google.com/maps'], 'https://google.com/', false],

  // ...but the host half still matches subdomains, so alternate front ends
  // for the same section are covered.
  [['reddit.com/r/rust'], 'https://old.reddit.com/r/rust', true],
  [['reddit.com/r/rust'], 'https://reddit.com/r/cooking', false],

  // Prefixes stop at segment boundaries.
  [['google.com/maps'], 'https://google.com/mapsomething', false],

  // Host-only entries behave exactly as they did before paths existed.
  [['reddit.com'], 'https://old.reddit.com/r/x', true],
  [['reddit.com'], 'https://reddit.com', true],
  [['reddit.com'], 'https://notreddit.com/', false],
  [['reddit.com'], 'https://reddit.com.evil.net/', false],
  [['youtube.com'], 'chrome://extensions', false],
  [['youtube.com'], 'file:///home/x/youtube.com', false],

  // Trailing slashes and case shouldn't decide anything.
  [['example.com/news'], 'https://example.com/news/', true],
  [['example.com/news'], 'https://EXAMPLE.com/News', true],

  [[], 'https://reddit.com', false],
];
for (const [list, url, want] of matches) {
  check(`${JSON.stringify(list)} vs ${url}`, urlIsBlocked(url, list), want);
}

const total = normalizations.length + matches.length;
console.log(failures ? `${failures} of ${total} failed` : `all ${total} pass`);
process.exit(failures ? 1 : 0);
