#!/usr/bin/env python3
"""
Checks every relative markdown link in the repository, and every #anchor into a markdown file.

Repo-level tooling, so it lives here rather than in box/software/scripts: it has to be runnable on a
docs-only change without an `npm ci` first. Python 3 standard library only, no dependencies, no
install step.

Broken relative links are the specific thing that rots in a monorepo — this whole layout moved once
already, and both times the only thing that caught the fallout was running a check like this by hand.

Usage:
    .github/scripts/check-doc-links.py            # every tracked *.md
    .github/scripts/check-doc-links.py a.md b.md  # only these (used by the pre-commit hook)

Exits 1 on the first broken target or anchor, listing every failure with file:line.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

# [text](target) — target captured up to the first whitespace or closing paren, so an optional
# "title" after the path is ignored. Images (![alt](src)) match too, which is what we want.
LINK = re.compile(r"\[[^\]]*\]\(\s*([^)\s]+)")

# Fenced code blocks are skipped: they routinely contain paths that are illustrative rather than
# real (a directory tree, an example command), and flagging those is noise.
FENCE = re.compile(r"^\s*(```|~~~)")

SKIP_PREFIXES = ("http://", "https://", "mailto:", "tel:", "data:", "//")


def tracked_markdown() -> list[Path]:
    out = subprocess.run(
        ["git", "ls-files", "*.md"], capture_output=True, text=True, check=True
    ).stdout
    return [Path(line) for line in out.splitlines() if line]


def slugify(heading: str) -> str:
    """
    GitHub's heading-to-anchor rule, closely enough for our own docs.

    Strips inline markdown, lowercases, drops punctuation, turns spaces into hyphens.
    """
    text = heading.strip().lstrip("#").strip()
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)  # links -> their text
    text = text.replace("`", "")
    text = re.sub(r"[*_~]", "", text)  # emphasis
    text = text.lower()
    text = re.sub(r"[^\w\s-]", "", text)  # punctuation, keeping - and _
    return re.sub(r"\s+", "-", text).strip("-")


def anchors_of(path: Path) -> set[str]:
    """Every anchor a markdown file offers: its headings, plus any explicit id= attribute."""
    found: set[str] = set()
    in_fence = False
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if FENCE.match(line):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        if line.startswith("#"):
            slug = slugify(line)
            if slug:
                found.add(slug)
        for explicit in re.findall(r"""(?:id|name)=["']([^"']+)["']""", line):
            found.add(explicit.lower())
    return found


def check(path: Path) -> list[str]:
    problems: list[str] = []
    anchor_cache: dict[Path, set[str]] = {}
    in_fence = False

    for number, line in enumerate(
        path.read_text(encoding="utf-8", errors="replace").splitlines(), start=1
    ):
        if FENCE.match(line):
            in_fence = not in_fence
            continue
        if in_fence:
            continue

        for target in LINK.findall(line):
            if target.startswith(SKIP_PREFIXES) or target.startswith("<"):
                continue

            # A bare "#anchor" points inside this same file.
            if target.startswith("#"):
                anchor = target[1:].lower()
                if path not in anchor_cache:
                    anchor_cache[path] = anchors_of(path)
                if anchor and anchor not in anchor_cache[path]:
                    problems.append(f"{path}:{number}: no heading matches '{target}'")
                continue

            file_part, _, anchor = target.partition("#")
            if not file_part:
                continue

            resolved = (path.parent / file_part).resolve()
            if not resolved.exists():
                problems.append(f"{path}:{number}: missing target '{target}'")
                continue

            if anchor and resolved.suffix == ".md":
                if resolved not in anchor_cache:
                    anchor_cache[resolved] = anchors_of(resolved)
                if anchor.lower() not in anchor_cache[resolved]:
                    problems.append(
                        f"{path}:{number}: '{file_part}' has no heading matching '#{anchor}'"
                    )

    return problems


def main() -> int:
    paths = [Path(a) for a in sys.argv[1:]] or tracked_markdown()
    paths = [p for p in paths if p.suffix == ".md" and p.is_file()]

    problems: list[str] = []
    for path in paths:
        problems.extend(check(path))

    if problems:
        print(f"broken links in {len(paths)} markdown file(s):\n", file=sys.stderr)
        for problem in problems:
            print(f"  {problem}", file=sys.stderr)
        print(f"\n{len(problems)} problem(s).", file=sys.stderr)
        return 1

    print(f"doc links ok ({len(paths)} markdown files)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
