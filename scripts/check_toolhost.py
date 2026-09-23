#!/usr/bin/env python3
"""Smoke-test a CLI or zipapp ToolHost with a disposable toolHome."""

from __future__ import annotations

import argparse
import json
import subprocess
import tempfile


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", nargs="+")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="guthon-toolhost-check-") as home:
        subprocess.run([*args.command, "setup", "--home", home], check=True, capture_output=True)
        process = subprocess.Popen(
            [*args.command, "serve", "--stdio", "--home", home],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8",
        )
        try:
            ready = json.loads(process.stdout.readline())
            if ready.get("protocolVersion") != 1:
                raise RuntimeError("ToolHost protocol version mismatch")
            for index in range(3):
                process.stdin.write(json.dumps({
                    "id": str(index), "command": "workspaces", "requestKind": "read",
                }) + "\n")
                process.stdin.flush()
                response = json.loads(process.stdout.readline())
                if response.get("id") != str(index) or response.get("result", {}).get("workspaces") != []:
                    raise RuntimeError("ToolHost request failed")
        finally:
            process.stdin.close()
            exit_code = process.wait(timeout=10)
            process.stdout.close()
            process.stderr.close()
        if exit_code != 0:
            raise RuntimeError(f"ToolHost exited with {exit_code}")
    print("ToolHost smoke: ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
