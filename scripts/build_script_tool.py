#!/usr/bin/env python3
"""Build the dependency-free GuthonCodeTool zipapp source asset."""

from __future__ import annotations

import argparse
import shutil
import tempfile
import zipapp
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_NAME = "GuthonCodeTool-python.pyz"


def build(destination: Path) -> Path:
    destination = destination.expanduser().resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="guthon-pyz-") as temporary:
        stage = Path(temporary)
        for source in (ROOT / "scripts").rglob("*.py"):
            if "__pycache__" in source.parts:
                continue
            target = stage / source.relative_to(ROOT / "scripts")
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
        shutil.copy2(ROOT / "VERSION", stage / "VERSION")
        shutil.copytree(ROOT / "config" / "example", stage / "config" / "example")
        data = ROOT / "plugins" / "GuthonNexus" / "gushen-vscode-completion" / "data"
        shutil.copytree(data, stage / "plugins" / "GuthonNexus" / "gushen-vscode-completion" / "data")
        (stage / "__main__.py").write_text(
            "from guthon_tool import main\nraise SystemExit(main())\n", encoding="utf-8"
        )
        zipapp.create_archive(stage, target=destination, compressed=True)
    return destination


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "dist" / DEFAULT_NAME)
    args = parser.parse_args()
    print(build(args.output))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
