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


def mcp_tools(command: list[str], home: str, *, read_only: bool, provider: str = "api",
              platform: bool = False) -> list[dict]:
    args = [*command, "mcp", "--home", home, "--", "--stdio", "--provider", provider]
    if read_only:
        args.append("--read-only")
    if platform:
        args.append("--enable-platform-tools")
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
    if provider == "auto":
        from providers.source_helper import SourceHelperMcpServer

        if initialized.get("serverInfo", {}).get("name") != "guthon-source-helper":
            raise RuntimeError("MCP auto provider did not identify as guthon-source-helper")
        expected = {tool["name"] for tool in SourceHelperMcpServer(
            home, "smoke", enable_writes=not read_only, enable_platform_tools=platform
        ).tools}
    else:
        from providers.api.mcp_server import TOOLS, WRITE_TOOLS

        expected = {tool["name"] for tool in TOOLS + WRITE_TOOLS
                    if not read_only or tool["annotations"]["readOnlyHint"]}
    if not isinstance(tools, list) or {tool["name"] for tool in tools} != expected:
        raise RuntimeError(f"MCP {provider} tool inventory does not match the registered contract")
    if read_only and any(not item.get("annotations", {}).get("readOnlyHint") for item in tools):
        raise RuntimeError("Read-only MCP exposed a write tool")
    return tools


def resolve_entry(entry: Path) -> Path:
    """Accept either the launcher file or the macOS onedir folder that holds it."""

    if entry.is_dir():
        for name in ("GuthonCodeTool", "GuthonCodeTool.exe"):
            candidate = entry / name
            if candidate.is_file():
                return candidate
    return entry


def check_doctor(command: list[str], home: str) -> None:
    """Gate shipped resources, independently of the build host's optional services."""
    result = subprocess.run(
        [*command, "doctor", "--json", "--home", home],
        capture_output=True, text=True, encoding="utf-8", timeout=120,
    )
    if result.returncode not in (0, 1):
        raise RuntimeError(f"doctor exited {result.returncode}: {result.stderr.strip()}")
    payload = json.loads(result.stdout)
    checks = payload.get("data")
    if not isinstance(checks, list):
        raise RuntimeError(f"doctor returned no check results: {payload}")
    required = {"python", "config", "vscode-data"}
    passed = {item["name"] for item in checks if item["status"] == "PASS"}
    if required - passed:
        raise RuntimeError(f"doctor required checks failed or missing: {sorted(required - passed)}; {checks}")
    # Database drivers/credential stores and Bridge depend on the build host.
    # Keep their results visible without making them a resource-packaging gate.
    print("doctor: " + json.dumps(checks, ensure_ascii=False))


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="strict")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--entry", type=Path, required=True, help="Path to EXE, macOS app, pyz, or source CLI")
    parser.add_argument("--python", type=Path, help="Python path for a .py or .pyz entry; defaults to this interpreter")
    args = parser.parse_args()
    entry = resolve_entry(args.entry.expanduser().resolve())
    if not entry.is_file():
        parser.error("--entry must be an existing file or a folder containing GuthonCodeTool")
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
        run([*command, "setup", "--home", home, "--no-team-sync"])
        check_doctor(command, home)
        all_tools = mcp_tools(command, home, read_only=False)
        readonly_tools = mcp_tools(command, home, read_only=True)
        routed_tools = mcp_tools(command, home, read_only=False, provider="auto")
        routed_readonly = mcp_tools(command, home, read_only=True, provider="auto")
        routed_platform = mcp_tools(command, home, read_only=False, provider="auto", platform=True)
        if {tool["name"] for tool in all_tools} != {
            tool["name"].removeprefix("api_") for tool in routed_platform if tool["name"].startswith("api_")
        }:
            raise RuntimeError("guthon-source-helper does not cover the fixed API tool set")
    print(f"PASS: {version['version']} · self-test · doctor resources · "
          f"API MCP {len(all_tools)}/{len(readonly_tools)} tools · "
          f"guthon-source-helper {len(routed_tools)} local / {len(routed_readonly)} read-only / "
          f"{len(routed_platform)} platform-enabled tools · temporary toolHome")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
