#!/usr/bin/env python3
"""Maintainer-only mirror of signed GitHub releases; never builds or signs files."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import getpass
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
TRUST = ROOT / "plugins/GuthonNexus/gushen-vscode-completion/data/release-trust.json"
KEYCHAIN_SERVICE = "GuthonCodeTool.ReleaseMirror"
MAX_ASSET_BYTES = 512 * 1024 * 1024
METADATA_BYTES = 4 * 1024 * 1024
EXPECTED_ASSETS = frozenset((
    "GuthonCodeTool-windows-x64.exe", "GuthonCodeTool-macos-arm64.zip",
    "GuthonCodeTool-python.pyz", "GuthonCodeTool-python-requirements.txt",
    "GuthonCodeTool-chrome.zip", "guthon-nexus-vscode.vsix", "guthon-testing.zip",
    "GuthonCodeTool-release.json", "GuthonCodeTool-checksums.txt",
    "GuthonCodeTool-checksums.signature.json",
))
CORE_ASSETS = EXPECTED_ASSETS - {"GuthonCodeTool-release.json"}
INSTALLER_ASSETS = EXPECTED_ASSETS | {"GuthonCodeSetup.exe", "GuthonCodeSetup.sha256"}
ASSET_SETS = (CORE_ASSETS, EXPECTED_ASSETS, INSTALLER_ASSETS)


class MirrorError(Exception):
    pass


class TransferError(MirrorError):
    pass


def log(message: str) -> None:
    print(message, flush=True)


def file_hash(file: Path) -> str:
    digest = hashlib.sha256()
    with file.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_tag(tag: str) -> str:
    if not re.fullmatch(r"v\d+\.\d+\.\d+", tag):
        raise MirrorError("版本必须为 v0.3.1 这样的稳定发行标签")
    return tag


def validate_repository(repository: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*", repository):
        raise MirrorError("仓库必须为 owner/repository，不接受 URL 或路径")
    return repository


def validate_token(token: str) -> str:
    if not token or not re.fullmatch(r"[A-Za-z0-9_.-]{1,4096}", token):
        raise MirrorError("Gitee 令牌为空或格式无效")
    return token


def credential_store():
    try:
        import keyring
        store = keyring.get_keyring()
    except Exception:
        raise MirrorError("无法访问系统钥匙串；请使用仓库 .venv Python 或 CI 的 GITEE_TOKEN") from None
    if type(store).__module__ not in ("keyring.backends.macOS", "keyring.backends.Windows", "keyring.backends.SecretService"):
        raise MirrorError("需要系统凭据存储后端，不接受文件或明文 keyring 后端")
    return store


def configure_token(repository: str) -> None:
    if not sys.stdin.isatty():
        raise MirrorError("请在本机交互终端配置令牌，不通过聊天、命令参数或重定向传入")
    store = credential_store()
    token = validate_token(getpass.getpass(f"输入 {repository} 的 Gitee 上传令牌（不回显）："))
    try:
        store.set_password(KEYCHAIN_SERVICE, repository, token)
    except Exception:
        raise MirrorError("系统钥匙串保存失败") from None
    log(f"已保存 {repository} 的令牌到系统钥匙串；未写入仓库或配置文件")


def load_token(repository: str) -> str:
    if "GITEE_TOKEN" in os.environ:
        return validate_token(os.environ["GITEE_TOKEN"])
    try:
        token = credential_store().get_password(KEYCHAIN_SERVICE, repository)
    except MirrorError:
        raise
    except Exception:
        raise MirrorError("系统钥匙串读取失败") from None
    if not token:
        raise MirrorError("尚未配置 Gitee 令牌；先运行 .venv/bin/python scripts/sync_release_to_gitee.py --configure-token")
    return validate_token(token)


def run_command(command: list[str], *, timeout: int = 300) -> str:
    try:
        environment = {k: v for k, v in os.environ.items() if k != "GITEE_TOKEN"}
        result = subprocess.run(command, capture_output=True, text=True, timeout=timeout, check=False, env=environment)
    except (OSError, subprocess.TimeoutExpired):
        raise MirrorError(f"{Path(command[0]).name} 不可用或执行超时") from None
    if result.returncode:
        # Do not print child output: authenticated URLs or environment values may be present.
        raise MirrorError(f"{Path(command[0]).name} 执行失败（退出码 {result.returncode}）")
    return result.stdout


def verify_assets(directory: Path, tag: str) -> dict[str, str]:
    files = list(directory.iterdir())
    names = {file.name for file in files}
    if names not in ASSET_SETS:
        raise MirrorError("发行目录必须包含完整签名附件（9/10 个，含统一安装器时为 12 个），不接受缺失或额外文件")
    for file in files:
        if file.is_symlink() or not file.is_file() or not 0 < file.stat().st_size <= MAX_ASSET_BYTES:
            raise MirrorError(f"发行附件类型或大小无效：{file.name}")
    try:
        evidence = json.loads(run_command([
            "node", str(ROOT / "scripts/verify_release.mjs"), "--release-dir", str(directory),
            "--trust-file", str(TRUST), "--version", tag[1:],
        ]))
    except MirrorError:
        raise MirrorError("发行签名、版本或附件哈希验证未通过；不会写入 Gitee") from None
    signed_assets = names - {"GuthonCodeTool-checksums.txt", "GuthonCodeTool-checksums.signature.json"}
    if (evidence.get("ok") is not True or evidence.get("signature", {}).get("verified") is not True
            or set(evidence.get("verifiedFiles", [])) != signed_assets):
        raise MirrorError("发行签名验证失败")
    log(f"{tag} 独立发行签名及附件哈希验证通过")
    return {file.name: file_hash(file) for file in files}


def curl_quote(value: str) -> str:
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"').replace('\n', '\\n').replace('\r', '\\r').replace('\t', '\\t') + '"'


@contextmanager
def mirror_lock(repository: str):
    # Keep the lock inode after release; unlinking would let another process bypass it.
    user = str(os.getuid()) if hasattr(os, "getuid") else getpass.getuser()
    folder = Path(tempfile.gettempdir()) / ("guthon-release-mirror-locks-" + hashlib.sha256(user.encode()).hexdigest()[:16])
    folder.mkdir(mode=0o700, exist_ok=True)
    if folder.is_symlink() or not folder.is_dir():
        raise MirrorError("同步锁目录无效")
    if hasattr(os, "getuid") and (folder.stat().st_uid != os.getuid() or folder.stat().st_mode & 0o077):
        raise MirrorError("同步锁目录必须仅由当前用户访问")
    name = hashlib.sha256(repository.encode()).hexdigest() + ".lock"
    file = folder / name
    if file.is_symlink():
        raise MirrorError("同步锁不能是符号链接")
    fd = os.open(file, os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        try:
            if os.name == "nt":
                import msvcrt
                if os.fstat(fd).st_size == 0:
                    os.write(fd, b"0")
                os.lseek(fd, 0, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise MirrorError("本机已有此仓库的镜像同步在运行，请等待完成") from None
        yield
    finally:
        os.close(fd)


class GiteeClient:
    def __init__(self, repository: str, work: Path, token: str = ""):
        self.repository = validate_repository(repository)
        self.api = f"https://gitee.com/api/v5/repos/{repository}"
        self.work = work
        self.token = token

    def transfer(self, url: str, target: Path, *, method: str = "GET", fields: dict[str, str] | None = None,
                 upload: Path | None = None, limit: int = METADATA_BYTES, download: bool = False) -> int:
        parsed = urlsplit(url)
        if parsed.scheme != "https" or parsed.username or parsed.password or parsed.fragment:
            raise MirrorError("仅接受无凭据的 HTTPS 地址")
        if parsed.hostname != "gitee.com":
            raise MirrorError("初始请求地址必须属于 gitee.com")
        if method != "GET" and not url.startswith(self.api + "/"):
            raise MirrorError("写入请求必须属于指定 Gitee 仓库 API")
        config = []
        if method != "GET":
            field_option = "data-urlencode" if method == "PATCH" else "form-string"
            config.append(field_option + " = " + curl_quote("access_token=" + validate_token(self.token)))
            for name, value in (fields or {}).items():
                config.append(field_option + " = " + curl_quote(name + "=" + value))
        if upload:
            # Curl multipart file paths need their own quoted envelope.
            file_value = str(upload).replace('\\', '\\\\').replace('"', '\\"')
            config.append("form = " + curl_quote('file=@"' + file_value + '"'))
        size = upload.stat().st_size if upload else limit
        budget = min(300, max(90, math.ceil(size / (128 * 1024)) + 30)) if upload or download else 30
        # Gitee's 302 redirect body can exceed a tiny signature/checksum file.
        # Bound the redirect response separately; final bytes still require exact size/hash.
        response_limit = max(METADATA_BYTES, limit) if download else limit
        command = [
            "curl", "--disable", "--silent", "--show-error", "--http1.1", "--proto", "=https",
            "--proto-redir", "=https", "--connect-timeout", "8", "--max-time", str(budget),
            "--speed-limit", "32768", "--speed-time", "30", "--max-filesize", str(response_limit),
            "--request", method, "--output", str(target), "--write-out", "%{json}",
            "--config", "-", "--user-agent", "GuthonCodeTool-ReleaseMirror", url,
        ]
        if download:
            command[1:1] = ["--location", "--max-redirs", "5"]
            # --disable must be first, so ~/.curlrc cannot alter credential routing.
            command.remove("--disable")
            command.insert(1, "--disable")
        environment = {k: v for k, v in os.environ.items() if k not in ("GITEE_TOKEN", "GH_TOKEN", "GITHUB_TOKEN")}
        started = time.monotonic()
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment)
        try:
            initial_input = ("\n".join(config) + "\n").encode()
            while True:
                try:
                    stdout, _ = process.communicate(input=initial_input, timeout=10)
                    break
                except subprocess.TimeoutExpired:
                    initial_input = None
                    elapsed = time.monotonic() - started
                    if (target.exists() and target.stat().st_size > response_limit) or elapsed > budget + 10:
                        process.kill()
                        process.communicate()
                        raise TransferError("传输超过大小或时间上限")
                    log(f"  传输中：已耗时 {elapsed:.0f}s（本次上限 {budget}s）")
            try:
                metrics = json.loads(stdout)
                status = int(metrics.get("http_code", 0))
            except (ValueError, TypeError):
                raise TransferError("curl 未返回有效传输结果") from None
            rate = metrics.get("speed_upload" if upload else "speed_download", 0)
            log(f"  HTTP {status} · {metrics.get('time_total', 0):.1f}s · TLS {metrics.get('time_appconnect', 0):.2f}s · {rate / 1024:.1f} KiB/s")
            if process.returncode or (target.exists() and target.stat().st_size > limit):
                raise TransferError(f"传输失败（curl {process.returncode}，HTTP {status}）；不输出响应或令牌")
            return status
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate()

    def json_request(self, suffix: str, *, method: str = "GET", fields: dict[str, str] | None = None,
                     upload: Path | None = None, allow_missing: bool = False):
        target = self.work / "api-response.json"
        for attempt in range(3 if method == "GET" else 1):
            try:
                status = self.transfer(self.api + suffix, target, method=method, fields=fields, upload=upload)
                if status == 404 and allow_missing:
                    return None
                if not 200 <= status < 300:
                    raise TransferError(f"Gitee API 请求失败（HTTP {status}）")
                try:
                    body = json.loads(target.read_bytes())
                except ValueError:
                    raise TransferError("Gitee API 返回无效 JSON") from None
                if body is None and not allow_missing:
                    raise TransferError("Gitee API 返回空结果")
                return body
            except TransferError:
                if method != "GET" or attempt == 2:
                    raise
                log("  只读请求失败，短暂等待后重试")
                time.sleep(2 * (attempt + 1))

    def release(self, tag: str):
        body = self.json_request("/releases/tags/" + validate_tag(tag), allow_missing=True)
        if body is None:
            return None
        if not isinstance(body, dict) or type(body.get("id")) is not int or body["id"] <= 0 or body.get("tag_name") != tag:
            raise MirrorError("Gitee 响应缺少有效发行 ID 或标签不一致")
        if body.get("prerelease") is not False or not isinstance(body.get("assets"), list):
            raise MirrorError("Gitee 目标不是有效的稳定发行")
        return body

    def download_hash(self, asset: dict, file: Path) -> str:
        url = asset.get("browser_download_url")
        if not isinstance(url, str) or not url.startswith(f"https://gitee.com/{self.repository}/releases/download/"):
            raise MirrorError("Gitee 附件地址与目标仓库不一致")
        target = self.work / "download-verification"
        for attempt in range(3):
            try:
                status = self.transfer(url, target, limit=file.stat().st_size, download=True)
                if status != 200 or target.stat().st_size != file.stat().st_size:
                    raise TransferError(f"附件下载失败或大小不一致：{file.name}")
                return file_hash(target)
            except TransferError:
                if attempt == 2:
                    raise
                time.sleep(2 * (attempt + 1))


def asset_map(release: dict) -> dict[str, dict]:
    result = {}
    for asset in release["assets"]:
        if not isinstance(asset, dict) or not isinstance(asset.get("name"), str):
            raise MirrorError("Gitee 返回无效附件记录")
        name = asset["name"]
        if name in INSTALLER_ASSETS:
            if name in result:
                raise MirrorError(f"Gitee 存在重复附件，请人工核查：{name}")
            result[name] = asset
    return result


def mirror(client: GiteeClient, tag: str, directory: Path, hashes: dict[str, str], notes: str,
           *, verify_only: bool = False) -> None:
    release = client.release(tag)
    if release is None:
        if verify_only:
            raise MirrorError("Gitee 尚无此版本；只读验收不会创建发行")
        try:
            client.json_request("/releases", method="POST", fields={
                "tag_name": tag, "target_commitish": tag, "name": "GuthonCodeTool " + tag,
                "body": notes, "prerelease": "false",
            })
        except TransferError:
            log("创建请求未确认，先重新查询目标发行，避免重复创建")
        release = client.release(tag)
        if release is None:
            raise MirrorError("未确认 Gitee 发行已创建；可重新运行同一命令")
    if not verify_only and release.get("body", "").replace("\r\n", "\n").strip() != notes.strip():
        client.json_request(f"/releases/{release['id']}", method="PATCH", fields={
            "tag_name": tag, "name": "GuthonCodeTool " + tag, "body": notes, "prerelease": "false",
        })
        release = client.release(tag)
        if release is None or release.get("body", "").replace("\r\n", "\n").strip() != notes.strip():
            raise MirrorError("Gitee 发行说明更新未通过核验")
    for name in sorted(hashes):
        file = directory / name
        confirmed = False
        for attempt in range(3):
            release = client.release(tag)
            if release is None:
                raise MirrorError("同步期间目标发行消失，停止操作")
            existing = asset_map(release).get(name)
            if existing:
                log(f"下载核验 {name}（{file.stat().st_size} 字节）")
                if client.download_hash(existing, file) != hashes[name]:
                    raise MirrorError(f"远端附件哈希冲突，保留原文件并停止：{name}")
                log(f"已验证 {name}，不重复上传")
                confirmed = True
                break
            if verify_only:
                raise MirrorError(f"Gitee 缺少 {name}；只读验收不会补传")
            if attempt == 2:
                break
            # Recheck local bytes before transmission: the verifier may use a caller-owned folder.
            if file.is_symlink() or file_hash(file) != hashes[name]:
                raise MirrorError(f"上传前本地附件发生变化：{name}")
            log(f"上传 {name}（{file.stat().st_size} 字节，第 {attempt + 1}/2 次）")
            try:
                client.json_request(f"/releases/{release['id']}/attach_files", method="POST", upload=file)
            except TransferError:
                log("上传结果未确认；重新查询并下载核验后，才决定是否补传")
            time.sleep(2)
        if not confirmed:
            raise MirrorError(f"未确认 {name} 已上传；已完成附件保留，重新运行可补齐")
    final = client.release(tag)
    if final is None or set(asset_map(final)) != set(hashes):
        raise MirrorError("同步结束后附件集合发生变化")
    if final.get("body", "").replace("\r\n", "\n").strip() != notes.strip():
        raise MirrorError("Gitee 发行说明与指定 GitHub 版本不一致")
    log(f"完成：Gitee {tag} 的全部 {len(hashes)} 个附件与 GitHub 签名发行一致")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", help="稳定发行标签，例如 v0.3.1")
    parser.add_argument("--github-repo", default="SidWuu/GuthonCodeTool")
    parser.add_argument("--gitee-repo", default="sidwu/GuthonCodeTool")
    parser.add_argument("--configure-token", action="store_true", help="交互输入令牌并保存到系统钥匙串")
    parser.add_argument("--verify-only", action="store_true", help="只读下载验收，不需要令牌，不写入 Gitee")
    parser.add_argument("--release-dir", type=Path, help="使用已下载的正式签名附件目录（CI）")
    parser.add_argument("--notes-file", type=Path, help="与指定版本匹配的发行说明（CI）")
    args = parser.parse_args(argv)
    try:
        github = validate_repository(args.github_repo)
        gitee = validate_repository(args.gitee_repo)
        if args.configure_token:
            if args.tag or args.verify_only or args.release_dir or args.notes_file:
                raise MirrorError("令牌配置需单独执行，不同时同步发行")
            configure_token(gitee)
            return 0
        if not args.tag:
            raise MirrorError("请显式指定 --tag，不自动选择或创建版本")
        tag = validate_tag(args.tag)
        for program in ("node", "curl", "gh"):
            if program == "gh" and args.release_dir and args.notes_file:
                continue
            if not shutil.which(program):
                raise MirrorError(f"缺少 {program}，请先安装本机维护工具")
        token = "" if args.verify_only else load_token(gitee)
        with mirror_lock(gitee), tempfile.TemporaryDirectory(prefix="guthon-release-mirror-") as temporary:
            work = Path(temporary)
            directory = work / "release"
            directory.mkdir()
            if args.release_dir:
                if args.release_dir.is_symlink():
                    raise MirrorError("附件目录不能是符号链接")
                source = args.release_dir.resolve(strict=True)
                if {file.name for file in source.iterdir()} not in ASSET_SETS:
                    raise MirrorError("输入目录必须只包含完整的 9/10/12 个正式签名附件")
                for file in source.iterdir():
                    if file.is_symlink() or not file.is_file() or not 0 < file.stat().st_size <= MAX_ASSET_BYTES:
                        raise MirrorError("输入附件类型或大小无效")
                    shutil.copyfile(file, directory / file.name)
            else:
                log(f"从 GitHub 下载 {github} {tag} 的正式附件，不重新构建")
                metadata = json.loads(run_command(["gh", "release", "view", tag, "--repo", github,
                                                   "--json", "tagName,isDraft,isPrerelease,assets"]))
                assets = metadata.get("assets", [])
                names = {asset.get("name") for asset in assets}
                if (metadata.get("tagName") != tag or metadata.get("isDraft") is not False
                        or metadata.get("isPrerelease") is not False or len(assets) != len(names)
                        or names not in ASSET_SETS
                        or any(type(asset.get("size")) is not int or not 0 < asset["size"] <= MAX_ASSET_BYTES for asset in assets)):
                    raise MirrorError("GitHub 目标不是包含完整签名附件的稳定发行")
                run_command(["gh", "release", "download", tag, "--repo", github, "--dir", str(directory)])
            hashes = verify_assets(directory, tag)
            if args.notes_file:
                if args.notes_file.is_symlink() or args.notes_file.stat().st_size > METADATA_BYTES:
                    raise MirrorError("发行说明文件无效或过大")
                notes = args.notes_file.read_text(encoding="utf-8")
            else:
                notes = run_command(["gh", "release", "view", tag, "--repo", github, "--json", "body", "--jq", ".body"]).strip()
            if not notes.strip() or len(notes.encode()) > METADATA_BYTES:
                raise MirrorError("指定发行说明为空或过大")
            log(f"目标 Gitee {gitee} · {'只读验收' if args.verify_only else '核验后补传'}")
            mirror(GiteeClient(gitee, work, token), tag, directory, hashes, notes, verify_only=args.verify_only)
        return 0
    except (MirrorError, OSError, ValueError) as error:
        # Arbitrary child/keyring errors are deliberately excluded from output.
        message = str(error) if isinstance(error, MirrorError) else type(error).__name__
        print("同步失败：" + message, file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
