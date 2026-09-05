# 🥒 cucumbero

Yet another vegetable-themed timer + website blocker to help you focus, maybe. You set a timer, and the extension blocks your chosen websites, while you're trying to finally get some work done.

Vibe-coded with Claude 5, mostly.

[The Chrome Web Store page](https://chromewebstore.google.com/detail/cucumbero/olcepfohjjcdnmejpabcbdbcjbacafea)

![A blocked YouTube tab, mid-session](screenshots/Frame%2061.png)

## Features

- Minimalistic. Just a timer and a blocklist.
- Set a length and the timer counts down. Set it to 0 and it counts up until you stop it.
- Covers blocked tabs with an overlay instead of redirecting them, so pages keep their state. When the session ends, you'll find them exactly as you left them.
- Fullscreen and picture-in-picture get closed too, so a video can't play over the top of the overlay. Sound carries on though, and keyboard events go through.
- Keyboard support: type a number or use the arrow keys to set the session length, then press Enter to start the timer. (You can also assign a shortcut under chrome://extensions -> Keyboard shortcuts)
- Catches tabs you already had open, ones you open later, and ones that run into a blocked site mid-session.
- Add the current tab's domain to the blocklist in one click, even during a session.
- Subdomains get blocked automatically, e.g. blocking reddit.com also blocks old.reddit.com. You can also block a specific path, e.g. reddit.com/r/quick_dopamine.
- A 10-second break button in case you need to pause a video or leave a call.
- Shows the remaining time on the toolbar icon.
- No sign-in, no analytics, no network requests, no remote URLs anywhere in the code. Nothing leaves your browser.

## Install

1. `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select this folder
4. Pin it to the toolbar

## Known limits

- **A speed bump, not a cage.** Anyone who disables the extension, uses incognito,
  or a different browser gets right past it. That's fine. It's built to beat your reflexes, not your intent.
- **Some pages can't be covered**: `chrome://*`, the Chrome Web Store, the PDF
  viewer, and other extensions' pages. Chrome forbids injection there.
- **Audio keeps playing** behind the overlay. This is inherent to the overlay-instead-of-redirect approach. So you can listen, but not watch. Depending on your case, this can be a feature or a deal-breaker.
- **Keyboard events go through** so you can still, say, pause/unpause a youtube video using **K** without even using a 10-second break.

## License

MIT — see [LICENSE](LICENSE).

Two things in here aren't mine:

**Nunito**, bundled as `fonts/nunito-var.woff2` and used for the wordmark, the
timers and the overlay title. SIL OFL 1.1, © 2014 The Nunito Project Authors;
the licence travels with it in `fonts/OFL-Nunito.txt`, as the OFL requires.

**The cucumber**, rendered by `tools/make-icons.py` from the 🥒 glyph of Noto
Color Emoji — © Google Inc. 2013–2017, Apache License 2.0. That font isn't
bundled and none of its files ship here: the icons are images produced with it,
so no OFL notice is owed for them the way one is owed for Nunito above.
