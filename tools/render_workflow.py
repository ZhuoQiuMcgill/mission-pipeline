"""Render docs/workflow-3.0.html into the README screenshots, light and dark.

Opens the page in capture mode (both views, no controls) with a headless Chromium,
reads the page height the page reports, then takes one full-height screenshot per
theme. Writes docs/workflow-3.0-light.png and docs/workflow-3.0-dark.png.

    python tools/render_workflow.py [--chrome PATH] [--width 1600] [--no-sandbox]

The browser is found from --chrome, then $CHROME, then common executable names,
then a Playwright download under ~/.cache/ms-playwright. Run it after every edit to
the HTML so the README images never drift from the page.
"""
import argparse
import glob
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PAGE = ROOT / "docs" / "workflow-3.0.html"
NAMES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome", "msedge", "microsoft-edge"]
PLAYWRIGHT = ["~/.cache/ms-playwright/chromium_headless_shell-*/chrome-*/chrome-headless-shell",
              "~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome"]


def find_chrome(explicit):
    for candidate in [explicit, os.environ.get("CHROME")]:
        if candidate:
            return candidate
    for name in NAMES:
        found = shutil.which(name)
        if found:
            return found
    for pattern in PLAYWRIGHT:
        hits = sorted(glob.glob(os.path.expanduser(pattern)))
        if hits:
            return hits[-1]
    raise SystemExit("No Chromium found; pass --chrome or set CHROME")


def run(chrome, args, sandbox, profile):
    flags = ["--headless", "--hide-scrollbars", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
             "--virtual-time-budget=10000", f"--user-data-dir={profile}"]
    if not sandbox:
        flags.append("--no-sandbox")
    return subprocess.run([chrome, *flags, *args], capture_output=True, text=True, check=True, timeout=120)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--chrome")
    parser.add_argument("--width", type=int, default=1600)
    parser.add_argument("--no-sandbox", action="store_true", help="needed in some containers and WSL")
    opts = parser.parse_args()
    chrome = find_chrome(opts.chrome)
    sandbox = not opts.no_sandbox
    with tempfile.TemporaryDirectory() as profile:
        # A shared profile keeps the web fonts cached, so measuring and capturing see the same layout.
        run(chrome, [f"--window-size={opts.width},1200", "--dump-dom", f"{PAGE.as_uri()}?capture"], sandbox, profile)
        for theme in ("light", "dark"):
            url = f"{PAGE.as_uri()}?capture&theme={theme}"
            dom = run(chrome, [f"--window-size={opts.width},1200", "--dump-dom", url], sandbox, profile).stdout
            match = re.search(r'<meta name="capture-height" content="(\d+)"', dom)
            if not match:
                raise SystemExit(f"The page did not report its height for the {theme} theme")
            out = ROOT / "docs" / f"workflow-3.0-{theme}.png"
            run(chrome, [f"--window-size={opts.width},{match.group(1)}", f"--screenshot={out}", url], sandbox, profile)
            print(f"{out.relative_to(ROOT)}  {opts.width}x{match.group(1)}")


if __name__ == "__main__":
    sys.exit(main())
