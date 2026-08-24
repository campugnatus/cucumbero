# 🥒 cucumbero

A focus-session blocker for Chrome. You pick a duration, it covers your time-sink
sites with a black rectangle that says *"You know what you should be doing."*

## Install

1. `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select this folder
4. Pin it to the toolbar

## Use

Click the icon:

- **Duration** — type a number of minutes (1–720), or use the −/+ buttons, which
  step in quarter hours and snap to the grid. The field opens focused and
  selected, so typing a number and pressing Enter is the whole interaction. It
  remembers the last length you started and opens on that; 45 until then.
- **Block field** — pre-filled with the domain of the tab you're on, so blocking
  the site currently wasting your time is one click. Blocking `reddit.com` also
  blocks `old.reddit.com` and every other subdomain.

  You can paste a path to narrow it, and the more URL you give, the more
  specific the rule: `google.com/maps` covers that section without touching
  `mail.google.com` or `google.com` itself. The host half of the rule doesn't
  change, though, so `reddit.com/r/rust` still catches `old.reddit.com/r/rust`.
  Prefixes stop at segment boundaries — `/maps` never matches `/mapsomething` —
  and query strings are dropped, being per-visit rather than per-site, so
  pasting a video URL leaves you with `youtube.com/watch`.

  The field still pre-fills with the bare domain, so blocking a whole site stays
  a one-click job and narrowing is something you opt into by typing more.
- **Blocklist** — expands; the `×` buttons work only when no session is running.
- **Start session** — every open, new, or navigated-to tab on a blocked domain
  gets the overlay immediately.
- **hold to abort the session** — a genuine 5-second press-and-hold, no
  click-through, and only here. The overlay deliberately offers no way out:
  ending a session is a session-level act, so it lives in the session UI rather
  than in front of you at the moment of weakness.

The overlay itself has one control:

- **10-second break** — hides the overlay in *that tab only* so you can pause a
  video or leave a call. A small pill in the corner counts you back down. Then
  a 60-second cooldown, during which the button goes dim and does nothing;
  press it anyway and it tells you why. The cooldown is session-wide rather
  than per-tab, or you could just reopen the site in a new tab.

When the timer runs out every live overlay just fades away, and you get a system
notification.

## How it works

| File | Role |
| --- | --- |
| `background.js` | Service worker. Owns all state, decides which tabs get covered. |
| `overlay.js` | Injected on demand into blocked tabs only. Closed shadow DOM. |
| `popup.html/css/js` | The popup. A dumb client of the worker. |
| `fonts/` | Nunito as one variable face (latin subset, weights 200–1000) for the wordmark, the duration field, the overlay title and both countdowns. Bundled, so nothing is fetched over the network and it works offline. SIL OFL 1.1, see `fonts/OFL-Nunito.txt`. |

Session state is a wall-clock `endsAt` timestamp in `chrome.storage.local` plus a
`chrome.alarms` timer, so an MV3 worker eviction or a browser restart can't end
your session early or strand an overlay on a page. A per-minute alarm re-sweeps
every tab as a self-heal and keeps the toolbar badge honest.

The overlay lives in a closed shadow root with inline `!important` styling on the
host, and a `MutationObserver` puts it back if the page removes the node.

## Working on it

```sh
python3 tools/preview.py --open   # the popup in a normal tab, no extension reload
python3 tools/preview.py --shot   # ...or screenshot its three states
python3 tools/make-icons.py       # regenerate the icons from the 🥒 glyph
node tools/test-matching.js       # blocklist matching rules
```

The matching tests are the only ones here, because that's the only logic where
a mistake hides: over-blocking is obvious and annoying, under-blocking means a
site you asked to be kept from quietly works. The lookalike cases
(`notreddit.com`, `reddit.com.evil.net`) are the ones to keep.

`preview.py` serves the real `popup.html/css/js` and fakes only the `chrome.*`
calls (`tools/preview-stub.js`), so it renders exactly what the extension does —
which makes CSS work a page refresh instead of a reload-and-reopen loop. It
builds into a temp dir; nothing is written back into the repo.

## Known limits (deliberate)

- **It's a speed bump, not a cage.** Anyone who opens devtools, uses incognito
  (the extension isn't enabled there by default), or disables the extension gets
  right past it. It's built to beat your reflexes, not your intent.
- **Some pages can't be covered**: `chrome://*`, the Chrome Web Store, the PDF
  viewer, and other extensions' pages. Chrome forbids injection there.
- **A break follows the tab, not the page.** Start a break, navigate to a
  *different* blocked site in the same tab, and you keep the remaining seconds.
  That's the cost of "let me pause this video and get out."
- **Audio keeps playing** behind the overlay on purpose — otherwise the break
  button would have nothing to do.
