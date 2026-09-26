#!/usr/bin/env python3
"""Smoke-check one installed tool entry without touching a real toolHome."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path


def run(command: list[str], *, input_text: str | None = None) -> str:
    result = subprocess.run(
        command, input=input_text, capture_output=True, text=True, encoding="utf-8", timeout=120,
    )
    if result.returncode:
        raise RuntimeError(f"{' '.join(command[:2])} exited {result.returncode}: {result.stderr.strip()}")
    return result.stdout.strip()


def mcp_tools(command: list[str], home: str, *, read_only: bool) -> list[dict]:
    args = [*command, "mcp", "--stdio", *(["--read-only"] if read_only else []), "--home", home]
    messages = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-11-25", "capabilities": {},
            "clientInfo": {"name": "release-smoke", "version": "1"},
        }},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
    ]
    output = run(args, input_text="\n".join(json.dumps(item) for item in messages) + "\n")
    responses = [json.loads(line) for line in output.splitlines() if line.strip()]
    by_id = {item.get("id"): item for item in responses if "id" in item}
    initialized = by_id.get(1, {}).get("result", {})
    if initialized.get("protocolVersion") != "2025-11-25":
        raise RuntimeError("MCP protocol negotiation did not return 2025-11-25")
    tools = by_id.get(2, {}).get("result", {}).get("tools")
    expected = 15 if read_only else 28
    if not isinstance(tools, list) or len(tools) != expected:
        raise RuntimeError(f"MCP tool count: expected {expected}, received {len(tools) if isinstance(tools, list) else 'none'}")
    if read_only and any(not item.get("annotations", {}).get("readOnlyHint") for item in tools):
        raise RuntimeError("Read-only MCP exposed a write tool")
    return tools


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--entry", type=Path, required=True, help="Path to EXE, macOS app, pyz, or source CLI")
    parser.add_argument("--python", type=Path, help="Python path for a .py or .pyz entry; defaults to this interpreter")
    args = parser.parse_args()
    entry = args.entry.expanduser().resolve()
    if not entry.is_file():
        parser.error("--entry must be an existing file path")
    if entry.suffix in {".py", ".pyz"}:
        python = (args.python or Path(sys.executable)).expanduser().resolve()
        if not python.is_file():
            parser.error("--python must be an existing file path")
        command = [str(python), str(entry)]
    else:
        if args.python:
            parser.error("--python is only valid with a .py or .pyz entry")
        command = [str(entry)]

    version = json.loads(run([*command, "version"]))
    if not version.get("version"):
        raise RuntimeError("Version response is empty")
    with tempfile.TemporaryDirectory(prefix="guthon-release-smoke-") as home:
        run([*command, "self-test", "--home", home])
        run([*command, "setup", "--home", home])
        mcp_tools(command, home, read_only=False)
        mcp_tools(command, home, read_only=True)
    print(f"PASS: {version['version']} · self-test · MCP 28/15 tools · temporary toolHome")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
