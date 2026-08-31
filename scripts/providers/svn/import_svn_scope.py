#!/usr/bin/env python3
"""Generate an authorized SVN scope manifest from a Guthon checkout script."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from providers.svn.scope_import import (
    build_manifest,
    build_manifest_from_config,
    read_checkout_script,
    write_manifest,
)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--script", help="Path to svnCheckoutHere.sh or svnCheckoutHere.bat")
    source.add_argument("--bat", help="Windows-specific alias for a svnCheckoutHere.bat path")
    source.add_argument("--config", help="Path to an editable svn-scope.yaml/json configuration")
    parser.add_argument("--workspace", required=True, help="Exact workspace key: products.<id> or projects.<id>")
    parser.add_argument("--output", required=True, help="Target authorized-scope.json path")
    parser.add_argument(
        "--replace",
        action="store_true",
        help="atomically replace an existing manifest after reviewing the reported scope change",
    )
    args = parser.parse_args(argv)
    output_path = Path(args.output).expanduser().resolve()
    if args.config:
        config_path = Path(args.config).expanduser().resolve()
        try:
            result = build_manifest_from_config(config_path.read_text(encoding="utf-8"), args.workspace)
        except (OSError, UnicodeDecodeError) as error:
            raise SystemExit(f"Cannot read SVN scope configuration: {config_path}") from error
    else:
        script_path = Path(args.script or args.bat).expanduser().resolve()
        result = build_manifest(read_checkout_script(script_path), args.workspace)
    summary = write_manifest(output_path, result, replace=args.replace)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
