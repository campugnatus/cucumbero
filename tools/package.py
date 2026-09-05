#!/usr/bin/env python3
"""Build the upload zip for the Chrome Web Store.

    python3 tools/package.py

What ships is listed explicitly in SHIP below. That's an allowlist rather than
an ignore list on purpose: a stray file in the working tree can't end up in a
public upload by accident, and anything genuinely new has to be added here
deliberately. The cost is that forgetting to add a new file breaks the packaged
extension — hence the manifest cross-checks further down.
"""

import json
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"

SHIP = [
    "manifest.json",
    "background.js",
    "overlay.js",
    "popup.html",
    "popup.css",
    "popup.js",
    "icons/icon16.png",
    "icons/icon32.png",
    "icons/icon48.png",
    "icons/icon128.png",
    "icons/cucumber.png",
    "fonts/nunito-var.woff2",
    # The SIL Open Font License requires the licence to be distributed with the
    # font, so this one isn't optional.
    "fonts/OFL-Nunito.txt",
    # MIT asks the same of its own notice, and an upload to the store is a
    # distribution like any other. Cheap, and it would be odd to honour one
    # font's licence terms and not our own.
    "LICENSE",
]


def fail(message):
    sys.exit("package: " + message)


def check_manifest():
    """Parse the manifest and make sure everything it points at is shipping."""
    try:
        manifest = json.loads((ROOT / "manifest.json").read_text())
    except json.JSONDecodeError as e:
        fail(f"manifest.json is not valid JSON: {e}")

    referenced = set()
    referenced.update(manifest.get("icons", {}).values())
    referenced.update(manifest.get("action", {}).get("default_icon", {}).values())
    if popup := manifest.get("action", {}).get("default_popup"):
        referenced.add(popup)
    if worker := manifest.get("background", {}).get("service_worker"):
        referenced.add(worker)

    missing = sorted(r for r in referenced if r not in SHIP)
    if missing:
        fail("manifest references files that aren't in SHIP: " + ", ".join(missing))

    # web_accessible_resources are globs; each pattern must match something.
    for entry in manifest.get("web_accessible_resources", []):
        for pattern in entry.get("resources", []):
            if not [f for f in SHIP if Path(f).match(pattern)]:
                fail(f"web_accessible_resources pattern matches nothing shipped: {pattern}")

    return manifest


# Quoted relative paths to the kinds of file we ship.
ASSET = re.compile(r"""["'(]([\w./-]+\.(?:png|woff2|js|css|html|txt))["')]""")


def check_references():
    """The failure mode of an allowlist is shipping a file that asks for one
    that didn't make the list — a font 404 or a script that never loads, and
    only in the packaged build. So read what ships and follow its pointers."""
    for name in SHIP:
        if Path(name).suffix not in {".js", ".css", ".html", ".json"}:
            continue
        text = (ROOT / name).read_text()
        for ref in sorted(set(ASSET.findall(text))):
            if "://" in ref or ref.startswith("data:"):
                continue  # remote URL or inline payload, nothing to ship
            if ref not in SHIP:
                fail(f"{name} references {ref}, which is not in SHIP")


def main():
    manifest = check_manifest()
    check_references()

    missing = [f for f in SHIP if not (ROOT / f).is_file()]
    if missing:
        fail("listed but not on disk: " + ", ".join(missing))

    # overlay.js is injected by path, and the popup pulls its own two files, so
    # neither shows up in the manifest. Catch them going missing anyway.
    for needed in ("overlay.js", "popup.css", "popup.js"):
        if needed not in SHIP:
            fail(f"{needed} must ship; it is loaded by name at runtime")

    DIST.mkdir(exist_ok=True)
    out = DIST / f"{manifest['name']}-{manifest['version']}.zip"

    # Entries are written relative to the repo root: the store rejects a zip
    # whose manifest sits inside a wrapping folder.
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for name in sorted(SHIP):
            zf.write(ROOT / name, arcname=name)

    print(f"{out.relative_to(ROOT)}  ({out.stat().st_size / 1024:.0f} KB)")
    for name in sorted(SHIP):
        print(f"  {(ROOT / name).stat().st_size / 1024:7.1f} KB  {name}")


if __name__ == "__main__":
    main()
