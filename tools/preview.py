#!/usr/bin/env python3
"""Render the popup on its own, without loading the extension.

    python3 tools/preview.py           # build and print file:// URLs
    python3 tools/preview.py --open    # ...and open them in a browser
    python3 tools/preview.py --shot    # ...and screenshot them headlessly

The popup's real popup.html / popup.css / popup.js are used verbatim; only the
chrome.* APIs are faked (tools/preview-stub.js), so what you get on screen is
what the extension renders. Handy for CSS work — no reload-the-extension loop.
"""

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BUILD = Path(tempfile.gettempdir()) / "cucumbero-preview"
MARKER = '<script src="popup.js"></script>'

# name -> (query string, window size for --shot)
STATES = {
    "idle": ("", "320,270"),
    "list": ("?list=1", "320,470"),
    "active": ("?active=1", "320,300"),
}

CHROMES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]


def build():
    BUILD.mkdir(parents=True, exist_ok=True)
    for name in ("popup.css", "popup.js"):
        shutil.copy(ROOT / name, BUILD / name)
    shutil.copy(ROOT / "tools" / "preview-stub.js", BUILD / "stub.js")
    # Without the bundled font the preview silently falls back to system sans,
    # which is exactly the thing you'd be trying to look at.
    shutil.copytree(ROOT / "fonts", BUILD / "fonts", dirs_exist_ok=True)

    html = (ROOT / "popup.html").read_text()
    if MARKER not in html:
        sys.exit(f"popup.html no longer contains {MARKER!r} — update tools/preview.py")
    html = html.replace(MARKER, f'<script src="stub.js"></script>\n    {MARKER}')
    (BUILD / "popup.html").write_text(html)


def find_chrome():
    for name in CHROMES:
        found = shutil.which(name)
        if found:
            return found
    sys.exit("no Chrome/Chromium binary found; --shot needs one")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--shot", action="store_true", help="screenshot each state to PNG")
    ap.add_argument("--open", action="store_true", help="open each state in a browser")
    args = ap.parse_args()

    build()
    chrome = find_chrome() if args.shot else None

    for name, (query, size) in STATES.items():
        url = f"file://{BUILD / 'popup.html'}{query}"
        if args.shot:
            out = BUILD / f"{name}.png"
            subprocess.run(
                [chrome, "--headless=new", "--disable-gpu", "--no-sandbox",
                 "--hide-scrollbars", "--virtual-time-budget=1200",
                 f"--window-size={size}", f"--screenshot={out}", url],
                check=True, capture_output=True,
            )
            print(f"{name:7} {out}")
        else:
            print(f"{name:7} {url}")
        if args.open:
            subprocess.run(["xdg-open", url], check=False,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == "__main__":
    main()
