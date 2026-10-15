"""Pinned HTTPS downloads shared by installer build and runtime."""
import hashlib
import os
from pathlib import Path
import re
import tempfile
import urllib.request
from urllib.parse import urlsplit


def file_digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        original, target = urlsplit(request.full_url), urlsplit(newurl)
        if target.scheme != "https" or not target.hostname or target.username or target.password or target.fragment:
            raise ValueError("依赖文件重定向地址无效")
        if request.has_header("Authorization") and (target.hostname, target.port) != (original.hostname, original.port):
            raise ValueError("私有输入授权不允许跨主机重定向")
        return super().redirect_request(request, fp, code, msg, headers, newurl)


def fetch(url, checksum, target, *, limit, token=None, auth_host=None, opener=None):
    parsed = urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
        raise ValueError("依赖文件只能使用无账号信息的 HTTPS 地址")
    if not re.fullmatch(r"[a-f0-9]{64}", checksum):
        raise ValueError("依赖文件必须指定核定的 SHA-256")
    if target.is_file() and not target.is_symlink() and file_digest(target) == checksum:
        print('Using verified cached ' + target.name, flush=True)
        return
    headers = {"User-Agent": "GuthonCodeSetup"}
    if token and parsed.hostname == auth_host:
        headers["Authorization"] = "Bearer " + token
    request = urllib.request.Request(url, headers=headers)
    opener = opener or urllib.request.build_opener(SafeRedirect()).open
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=target.name + ".", suffix=".part", dir=target.parent)
    os.close(fd)
    temporary = target.parent / Path(name).name
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
                        raise ValueError("依赖文件超过大小上限")
                    hasher.update(block)
                    output.write(block)
        except (OSError, urllib.error.URLError):
            raise ValueError("依赖文件下载失败，请核对来源或私有访问授权") from None
        if hasher.hexdigest() != checksum:
            raise ValueError("依赖文件 SHA-256 不匹配，已停止")
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)
