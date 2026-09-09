#!/usr/bin/env python3
"""Generate the Guthon backend API allowlist from authoritative Markdown."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path


API_RE = re.compile(
    r"(?:\$vs\.[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+|"
    r"(?<![$A-Za-z0-9_])SQLTools\.[A-Za-z_][A-Za-z0-9_]*)\s*(?=\()"
)
DEFAULT_SOURCES = (
    "docs/谷神方言API/java.md",
    "docs/谷神方言API/custom.md",
    "docs/谷神方言API/sql.md",
)


def build_index(repo: Path, sources: tuple[str, ...]) -> dict[str, object]:
    apis: set[str] = set()
    metadata: list[dict[str, str]] = []
    for relative in sources:
        path = repo / relative
        content = path.read_text(encoding="utf-8")
        apis.update(re.sub(r"\s+", "", match.group(0)) for match in API_RE.finditer(content))
        metadata.append(
            {
                "path": relative,
                "sha256": hashlib.sha256(content.encode("utf-8")).hexdigest(),
            }
        )
    return {"schemaVersion": 1, "sources": metadata, "apis": sorted(apis)}


def main() -> int:
    completed = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        check=False,
        capture_output=True,
        text=True,
    )
    default_repo = (
        Path(completed.stdout.strip())
        if completed.returncode == 0 and completed.stdout.strip()
        else Path.cwd()
    )
    parser = argparse.ArgumentParser(prog="generate-guthon-api-index")
    parser.add_argument("--repo", type=Path, default=default_repo)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    repo = args.repo.resolve()
    output = args.output or repo / ".guthon" / "api-index.json"
    payload = build_index(repo, DEFAULT_SOURCES)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"generated {len(payload['apis'])} APIs: {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
