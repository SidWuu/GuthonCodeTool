#!/usr/bin/env python3
"""Fetch pinned installer inputs over HTTPS; never log tokens or signed URLs."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import urllib.request
from urllib.parse import urlsplit

from installer.engine import digest, write_json


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        original, target = urlsplit(request.full_url), urlsplit(newurl)
        if target.scheme != "https" or target.username or target.password:
            raise ValueError("构建输入重定向地址无效")
        if request.has_header("Authorization") and (target.hostname, target.port) != (original.hostname, original.port):
            raise ValueError("私有输入授权不允许跨主机重定向")
        return super().redirect_request(request, fp, code, msg, headers, newurl)


def fetch(url, checksum, target, *, limit, token=None, auth_host=None, opener=None):
    parsed = urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("构建输入只能使用无账号信息的 HTTPS 地址")
    if not re.fullmatch(r"[a-f0-9]{64}", checksum):
        raise ValueError("构建输入必须指定核定的 SHA-256")
    if target.is_file() and not target.is_symlink() and digest(target) == checksum:
        print('Using verified cached ' + target.name, flush=True)
        return
    headers = {"User-Agent": "GuthonCodeSetup-build"}
    if token and parsed.hostname == auth_host:
        headers["Authorization"] = "Bearer " + token
    request = urllib.request.Request(url, headers=headers)
    opener = opener or urllib.request.build_opener(SafeRedirect()).open
    temporary = target.with_suffix(target.suffix + ".part")
    target.parent.mkdir(parents=True, exist_ok=True)
    hasher, total = hashlib.sha256(), 0
    try:
        try:
            with opener(request, timeout=60) as response, temporary.open("wb") as output:
                # Never forward private authentication to another redirect host.
                if token and headers.get("Authorization") and urlsplit(response.geturl()).hostname != auth_host:
                    raise ValueError("带授权的输入不允许跨主机重定向")
                while block := response.read(1024 * 1024):
                    total += len(block)
                    if total > limit:
                        raise ValueError("构建输入超过大小上限")
                    hasher.update(block)
                    output.write(block)
        except (OSError, urllib.error.URLError):
            raise ValueError("构建输入下载失败，请核对来源或私有访问授权") from None
        if hasher.hexdigest() != checksum:
            raise ValueError("构建输入 SHA-256 不匹配，已停止")
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def prepare(metadata, output):
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
        ids.add(item["id"])
        target = output / (item["id"] + "." + item["type"])
        print('Preparing verified ' + item['id'], flush=True)
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
    args = parser.parse_args()
    prepare(args.manifest.resolve(), args.output.resolve())
