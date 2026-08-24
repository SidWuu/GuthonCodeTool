#!/usr/bin/env python3
"""Generate an authorized SVN scope manifest from a Guthon platform checkout BAT."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from providers.svn.scope_import import build_manifest, read_bat, write_manifest


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bat", required=True, help="Path to svnCheckoutHere.bat downloaded from Guthon")
    parser.add_argument("--workspace", required=True, help="Exact workspace key: products.<id> or projects.<id>")
    parser.add_argument("--output", required=True, help="Target authorized-scope.json path")
    parser.add_argument(
        "--replace",
        action="store_true",
        help="atomically replace an existing manifest after reviewing the reported scope change",
    )
    args = parser.parse_args(argv)
    bat_path = Path(args.bat).expanduser().resolve()
    output_path = Path(args.output).expanduser().resolve()
    result = build_manifest(read_bat(bat_path), args.workspace)
    summary = write_manifest(output_path, result, replace=args.replace)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
