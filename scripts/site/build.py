#!/usr/bin/env python3
"""Build the website: the landing page (site/) and the docs (docs/user/) (#468).

    python3 scripts/site/build.py                 # landing page + docs/dev into target/site
    python3 scripts/site/build.py --check         # the same, then check commands and links
    python3 scripts/site/build.py --docs-only --version v0.2.0 --out DIR
    python3 -m http.server -d target/site 8000    # then open http://127.0.0.1:8000/

Output layout (as on the gh-pages branch, under https://nexburst.github.io/nauvi/):

    index.html, style.css, tokens.css, site.js, img/, ...   the landing page
    docs/<version>/                                        the docs, built with mdBook

The pages workflow (.github/workflows/pages.yml) publishes it; this script never
touches git. Standard library only. mdBook comes from $MDBOOK or PATH (the
version CI pins is in pages.yml).

--check fails when:
  - a command in site/install.json is missing from README.md or from
    docs/user/src/how-to/install.md (the page and the README must not drift);
  - a link or image between the built pages, or an #anchor, does not resolve
    (links to docs/latest/ are checked against the version just built);
  - a link in README.md to a file of the repository or to this site does not
    resolve.
"""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import shutil
import subprocess
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[2]
SITE = ROOT / "site"
BOOK = ROOT / "docs" / "user"
SITE_URL = "https://nexburst.github.io/nauvi/"
SITE_PATH = "/nauvi/"
VERSION_RE = re.compile(r"^(dev|v\d+\.\d+\.\d+(-\d+)?)$")
LANDING_FILES = ["style.css", "site.js", "favicon.svg", "apple-touch-icon.png", "404.html"]


def fail(msg: str) -> None:
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)


# --- the landing page -------------------------------------------------------


def inline(text: str) -> str:
    """The tiny markup of install.json notes: `code`, **bold**, [text](url)."""
    out = html.escape(text, quote=False)
    out = re.sub(r"`([^`]+)`", r"<code>\1</code>", out)
    out = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", out)
    out = re.sub(r"\[([^\]]+)\]\(([^)\s]+)\)", lambda m: f'<a href="{html.escape(m.group(2))}">{m.group(1)}</a>', out)
    return out


def install_html(tabs: list[dict]) -> str:
    lines = ['  <div class="tablist" role="tablist" aria-label="Install on">']
    for t in tabs:
        lines.append(
            f'    <button type="button" role="tab" id="tab-{t["id"]}" aria-controls="panel-{t["id"]}" '
            f'aria-selected="false" tabindex="-1" data-os="{" ".join(t.get("os", []))}">{html.escape(t["label"])}</button>'
        )
    lines.append("  </div>")
    for t in tabs:
        lines.append(f'  <div class="panel" role="tabpanel" id="panel-{t["id"]}" aria-labelledby="tab-{t["id"]}">')
        lines.append(f'    <h3 class="panel-title">{html.escape(t["label"])}</h3>')
        for s in t["steps"]:
            lines.append('    <div class="step">')
            lines.append(f'      <p class="step-title">{html.escape(s["title"])}</p>')
            lines.append(
                f'      <div class="cmd"><pre><code>{html.escape(s["cmd"], quote=False)}</code></pre>'
                f'<button type="button" aria-label="Copy: {html.escape(s["title"])}">Copy</button></div>'
            )
            lines.append("    </div>")
        if t.get("note"):
            lines.append(f'    <p class="note">{inline(t["note"])}</p>')
        lines.append("  </div>")
    return "\n".join(lines)


def load_install() -> list[dict]:
    data = json.loads((SITE / "install.json").read_text())
    tabs = data["tabs"]
    ids = [t["id"] for t in tabs]
    if len(set(ids)) != len(ids):
        fail("site/install.json: tab ids must be unique")
    return tabs


def build_landing(out: Path) -> None:
    tabs = load_install()
    page = (SITE / "index.html").read_text()
    if page.count("{{install}}") != 1:
        fail("site/index.html must contain {{install}} once")
    (out / "index.html").write_text(page.replace("{{install}}", install_html(tabs)))
    for name in LANDING_FILES:
        shutil.copy2(SITE / name, out / name)
    shutil.copy2(BOOK / "theme" / "tokens.css", out / "tokens.css")
    # The screenshots live with the docs (docs/user/src/img/, made by the
    # site-screenshots QA scenario); the landing page uses the same files.
    shutil.copytree(BOOK / "src" / "img", out / "img", dirs_exist_ok=True)


# --- the docs ---------------------------------------------------------------


def build_docs(out: Path, version: str, mdbook: str) -> Path:
    dest = out / "docs" / version
    if dest.exists():
        shutil.rmtree(dest)
    env = dict(os.environ)
    # mdBook's 404 page links its assets from here.
    env["MDBOOK_OUTPUT__HTML__SITE_URL"] = f"{SITE_PATH}docs/{version}/"
    try:
        subprocess.run([mdbook, "build", str(BOOK), "--dest-dir", str(dest)], check=True, env=env)
    except FileNotFoundError:
        fail(f"{mdbook} not found: install mdBook (see .github/workflows/pages.yml) or set MDBOOK")
    except subprocess.CalledProcessError as e:
        fail(f"mdbook build failed ({e.returncode})")
    # The theme's tokens.css and nauvi.css are copied by mdBook; the font
    # files are not shipped (theme/fonts/fonts.css is empty on purpose).
    return dest


def write_local_index(out: Path, version: str) -> None:
    """docs/index.html and versions.json for a local preview. On gh-pages the
    pages workflow writes these from the versions it finds there."""
    docs = out / "docs"
    (docs / "index.html").write_text(redirect_page(f"{version}/"))
    (docs / "versions.json").write_text(json.dumps({"latest": "", "versions": [], "dev": version == "dev"}) + "\n")


def redirect_page(target: str) -> str:
    t = html.escape(target)
    return (
        "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">"
        f"<meta http-equiv=\"refresh\" content=\"0; url={t}\"><link rel=\"canonical\" href=\"{t}\">"
        f"<title>nauvi docs</title></head><body><p><a href=\"{t}\">nauvi docs</a></p></body></html>\n"
    )


# --- checks -----------------------------------------------------------------


def check_commands(errors: list[str]) -> None:
    readme = (ROOT / "README.md").read_text()
    install_page = (BOOK / "src" / "how-to" / "install.md").read_text()
    for t in load_install():
        for s in t["steps"]:
            cmd = s["cmd"]
            if cmd not in readme:
                errors.append(f"README.md does not show the {t['label']} command from site/install.json: {cmd}")
            if cmd not in install_page:
                errors.append(f"docs/user/src/how-to/install.md does not show the {t['label']} command: {cmd}")


class Links(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.links: list[str] = []
        self.ids: set[str] = set()

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        for key in ("id", "name"):
            if a.get(key):
                self.ids.add(a[key])
        for key in ("href", "src"):
            v = a.get(key)
            if v and not (tag == "link" and a.get("rel") in ("canonical",)):
                self.links.append(v)
        if tag == "source" and a.get("srcset"):
            self.links.append(a["srcset"].split()[0])


def parse(path: Path, cache: dict) -> Links:
    if path not in cache:
        p = Links()
        p.feed(path.read_text(errors="replace"))
        cache[path] = p
    return cache[path]


def resolve(out: Path, base: Path, link: str, version: str) -> tuple[Path | None, str]:
    """The file a link points to inside `out` (None: external), and its fragment."""
    u = urlsplit(link)
    if u.scheme in ("http", "https"):
        if not link.startswith(SITE_URL):
            return None, ""
        path = SITE_PATH + link[len(SITE_URL):].split("#")[0].split("?")[0]
        u = urlsplit(path + (f"#{u.fragment}" if u.fragment else ""))
    elif u.scheme or link.startswith("//"):
        return None, ""
    path = unquote(u.path)
    if not path:
        return base, u.fragment
    if path.startswith(SITE_PATH):
        target = out / path[len(SITE_PATH):]
    elif path.startswith("/"):
        return out / "__absolute__" / path.lstrip("/"), u.fragment
    else:
        target = (base.parent / path)
    rel = target.resolve().relative_to(out.resolve()) if target.resolve().is_relative_to(out.resolve()) else None
    if rel is None:
        return out / "__outside__", u.fragment
    parts = list(rel.parts)
    # docs/latest/ is a copy of the newest release on gh-pages; check it
    # against the version built now.
    if len(parts) >= 2 and parts[0] == "docs" and parts[1] == "latest":
        parts[1] = version
    target = out.joinpath(*parts) if parts else out
    if link.endswith("/") or target.is_dir():
        target = target / "index.html"
    return target, u.fragment


def check_site(out: Path, version: str, errors: list[str]) -> None:
    cache: dict = {}
    pages = sorted(p for p in out.rglob("*.html"))
    for page in pages:
        if page.name == "404.html" and page.parent != out:
            # mdBook's own 404 page uses absolute links to /nauvi/docs/<v>/;
            # GitHub Pages only serves the root one.
            continue
        for link in parse(page, cache).links:
            if link.startswith(("mailto:", "javascript:", "data:")):
                continue
            target, frag = resolve(out, page, link, version)
            if target is None:
                continue
            where = page.relative_to(out)
            if not target.exists():
                errors.append(f"{where}: broken link {link}")
            elif frag and target.suffix == ".html" and frag not in parse(target, cache).ids:
                errors.append(f"{where}: no #{frag} in {target.relative_to(out)} ({link})")


MD_LINK = re.compile(r"\[[^\]]*\]\(([^)\s]+)\)|href=\"([^\"]+)\"|src=\"([^\"]+)\"")


def check_readme(out: Path, version: str, errors: list[str]) -> None:
    text = (ROOT / "README.md").read_text()
    cache: dict = {}
    for m in MD_LINK.finditer(text):
        link = next(g for g in m.groups() if g)
        if link.startswith(SITE_URL):
            target, frag = resolve(out, out / "index.html", link, version)
            if target is None or not target.exists():
                errors.append(f"README.md: {link} is not a page of the site")
            elif frag and target.suffix == ".html" and frag not in parse(target, cache).ids:
                errors.append(f"README.md: no #{frag} in {link}")
        elif not urlsplit(link).scheme and not link.startswith("#"):
            path = link.split("#")[0]
            if path and not (ROOT / path).exists():
                errors.append(f"README.md: {link} is not a file of the repository")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=str(ROOT / "target" / "site"), help="output folder (emptied first)")
    ap.add_argument("--version", default="dev", help="docs version folder: dev or a tag like v0.2.0")
    ap.add_argument("--docs-only", action="store_true", help="only build docs/<version>/ (for a release)")
    ap.add_argument("--check", action="store_true", help="check the install commands and every link")
    ap.add_argument("--mdbook", default=os.environ.get("MDBOOK", "mdbook"))
    a = ap.parse_args()
    if not VERSION_RE.match(a.version):
        fail(f"--version must be dev or vMAJOR.MINOR.PATCH[-N], not {a.version}")
    out = Path(a.out).resolve()
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    if not a.docs_only:
        build_landing(out)
    build_docs(out, a.version, a.mdbook)
    if not a.docs_only:
        write_local_index(out, a.version)
    print(f"built {out}")
    if a.check:
        errors: list[str] = []
        check_commands(errors)
        check_site(out, a.version, errors)
        if not a.docs_only:
            check_readme(out, a.version, errors)
        for e in errors:
            print(f"error: {e}", file=sys.stderr)
        if errors:
            sys.exit(1)
        print("checks passed: install commands match, every link resolves")


if __name__ == "__main__":
    main()
