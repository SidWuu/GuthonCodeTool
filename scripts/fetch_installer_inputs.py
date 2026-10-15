#!/usr/bin/env python3
"""Fetch pinned installer inputs over HTTPS; never log tokens or signed URLs."""
import argparse
import json
from pathlib import Path

from installer.engine import write_json, validate_download


from common.installer_downloads import fetch


def prepare(metadata, output, *, online=False):
    output.mkdir(parents=True, exist_ok=True)
    spec = json.loads(metadata.read_text(encoding="utf-8"))
    if set(spec) != {"schemaVersion", "python", "prerequisites"} or spec["schemaVersion"] != 1:
        raise ValueError("构建输入清单结构无效")
    if set(spec["python"]) != {"url", "sha256"}:
        raise ValueError("Python 输入清单结构无效")
    print('Preparing official Python runtime', flush=True)
    fetch(spec["python"]["url"], spec["python"]["sha256"], output / "python.zip", limit=64 * 1024 * 1024)
    prerequisites = []
    ids = set()
    for item in spec["prerequisites"]:
        if (set(item) != {"id", "url", "sha256", "args", "elevate", "type"}
                or item["id"] not in {"codebuddy", "git", "svn"} or item["id"] in ids
                or item["type"] not in {"exe", "msi"}):
            raise ValueError("依赖输入必须为唯一的 codebuddy、git、svn 安装包")
        validate_download(item)
        ids.add(item["id"])
        target = output / (item["id"] + "." + item["type"])
        print('Preparing verified ' + item['id'], flush=True)
        if online:
            prerequisites.append(dict(item))
        else:
            fetch(item["url"], item["sha256"], target, limit=512 * 1024 * 1024)
            prerequisites.append({"id": item["id"], "file": str(target.resolve()), "sha256": item["sha256"],
                                  "args": item["args"], "elevate": item["elevate"]})
    if ids != {"codebuddy", "git", "svn"}:
        raise ValueError("完整安装包缺少必需的三项依赖")
    write_json(output / "prerequisites.json", {"schemaVersion": 1, "prerequisites": prerequisites})
    write_json(output / "inputs.json", spec)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=Path(__file__).resolve().parents[1] / "installer/windows/downloads.json")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--online", action="store_true", help="只下载内置 Python，工具依赖安装时按需下载")
    args = parser.parse_args()
    prepare(args.manifest.resolve(), args.output.resolve(), online=args.online)
