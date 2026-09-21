#!/usr/bin/env python3
"""Verify that repository paths referenced by AI_CODE_INDEX.md still exist.

Scope is deliberately narrow: it only extracts backticked repository-relative
paths from the index, checks their existence, and fails when a path was deleted
or renamed. It does not parse business semantics and never scans ``var``.

``tests/`` is an intentionally ignored local directory, so missing paths under
it are reported as skipped instead of failing; pass ``--strict`` to check them.
"""

from __future__ import annotations

import argparse
import re
from pathlib import Path


SOURCE_ROOT = Path(__file__).resolve().parents[1]
INDEX_FILE = SOURCE_ROOT / "AI_CODE_INDEX.md"
OPTIONAL_PREFIXES = ("tests/",)

BACKTICKED = re.compile(r"`([^`\n]+)`")
SKIPPED_CHARACTERS = set(" \t<>*?|\"'{}")


def referenced_paths(text: str) -> list[str]:
    """Return deduplicated repo-relative paths mentioned between backticks."""

    found: list[str] = []
    for token in BACKTICKED.findall(text):
        value = token.strip().rstrip("/")
        if not value or "/" not in value:
            continue
        if any(character in SKIPPED_CHARACTERS for character in value):
            continue
        if "://" in value or value.startswith(("-", "~", "/")):
            continue
        if value not in found:
            found.append(value)
    return found


def classify(index_file: Path, root: Path, strict: bool = False) -> dict[str, list[str]]:
    text = index_file.read_text(encoding="utf-8")
    stale: list[str] = []
    skipped: list[str] = []
    for value in referenced_paths(text):
        if (root / value).exists():
            continue
        if not strict and value.startswith(OPTIONAL_PREFIXES):
            skipped.append(value)
        else:
            stale.append(value)
    return {"stale": stale, "skipped": skipped}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--index", default=str(INDEX_FILE), help="index file to check")
    parser.add_argument("--root", default=str(SOURCE_ROOT), help="repository root the paths are relative to")
    parser.add_argument("--strict", action="store_true", help="also fail on intentionally ignored paths")
    args = parser.parse_args(argv)

    index_file = Path(args.index).expanduser().resolve()
    root = Path(args.root).expanduser().resolve()
    if not index_file.is_file():
        print(f"AI_CODE_INDEX missing: {index_file}")
        return 1

    outcome = classify(index_file, root, strict=args.strict)
    for value in outcome["skipped"]:
        print(f"AI_CODE_INDEX skip (ignored path): {value}")
    if outcome["stale"]:
        print("AI_CODE_INDEX stale path:")
        for value in outcome["stale"]:
            print(value)
        return 1
    print("AI_CODE_INDEX: ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
