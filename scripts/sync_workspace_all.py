#!/usr/bin/env python3
"""Synchronize one explicit Guthon workspace."""

import argparse
from pathlib import Path

import guthon_tool


def main(args=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", required=True)
    parsed = parser.parse_args(args)
    return guthon_tool.run("sync-all", Path(__file__).resolve().parents[1], [], parsed.workspace)


if __name__ == "__main__":
    raise SystemExit(main())
