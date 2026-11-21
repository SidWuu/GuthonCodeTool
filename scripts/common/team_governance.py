"""Install the team's published governance bundle into a development Git root."""
from __future__ import annotations

import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit

from common.command_errors import CommandError


GIT_AUTH_FAILURE = re.compile(
    r"could not read (?:username|password)|authentication failed|http basic: access denied"
    r"|permission denied \(publickey|host key verification failed|returned error: (?:401|403)\b",
    re.IGNORECASE,
)


def _source(value):
    # Explicit local Git checkouts are useful for development and offline testing.
    # Clone main even for a local checkout so working tree edits are never used.
    local = Path(value).expanduser()
    if local.is_absolute() and local.is_dir():
        return str(local.resolve())
    try:
        url = urlsplit(value)
        if (
            url.scheme in {"ssh", "https", "http"} and url.hostname and url.path.strip("/")
            and not url.password and not url.query and not url.fragment
            and (url.scheme == "ssh" or not url.username)
            and not re.search(r'[\x00-\x20"\\]', value)
        ):
            return value
    except ValueError:
        pass
    raise CommandError("TEAM_SOURCE_INVALID", "请提供团队的内网 Git 地址（不含密码或令牌），或本机 Git 仓库的绝对路径")


def sync_team_governance(workspace, source):
    source = _source(source)
    python = os.environ.get("GUTHON_PYTHON")
    if not python:
        python = (sys.executable if not getattr(sys, "frozen", False)
                  else shutil.which("python3") or shutil.which("python"))
    if not python:
        raise CommandError("TEAM_PYTHON_MISSING", "未找到团队规范安装所需的 Python 3，请设置 GUTHON_PYTHON")
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "LC_ALL": "C",
           "GIT_SSH_COMMAND": os.environ.get("GIT_SSH_COMMAND") or "ssh -o BatchMode=yes -o ConnectTimeout=10"}

    def run(command, phase, timeout, *, allow_check_failure=False, git_auth=False):
        interactive = git_auth and sys.stdin.isatty() and sys.stderr.isatty()
        try:
            if interactive:
                # Leave Git's prompts attached to the terminal. Keep its stdout out of CLI JSON.
                result = subprocess.run(command, env={**os.environ, "GIT_TERMINAL_PROMPT": "1"},
                                        stdout=subprocess.DEVNULL, timeout=300)
            else:
                result = subprocess.run(command, env=env if git_auth else os.environ, stdin=subprocess.DEVNULL,
                                        capture_output=True, text=True, encoding="utf-8",
                                        errors="replace", timeout=timeout)
        except (OSError, subprocess.TimeoutExpired) as error:
            raise CommandError("TEAM_SYNC_FAILED", f"{phase}失败：{type(error).__name__}") from error
        if result.returncode and not allow_check_failure:
            detail = ((result.stderr or "").strip() or (result.stdout or "").strip())[-4000:]
            if git_auth and GIT_AUTH_FAILURE.search(detail):
                raise CommandError("TEAM_GIT_AUTH_REQUIRED", f"guthon-team 需要 Git 认证或仓库权限：{detail}")
            raise CommandError("TEAM_SYNC_FAILED", f"{phase}失败：{detail or result.returncode}")
        return result

    with tempfile.TemporaryDirectory(prefix="guthon-team-") as temporary:
        checkout = Path(temporary) / "team"
        run(["git", "clone", "--no-local", "--depth", "1", "--single-branch", "--branch", "main",
             "--no-tags", "--", source, str(checkout)], "读取 guthon-team（请检查内网连接、凭据与仓库授权）", 40, git_auth=True)
        script = checkout / "plugins/guthon-guard/scripts/guthon_workspace.py"
        if not script.is_file():
            raise CommandError("TEAM_SOURCE_INVALID", "guthon-team 的 main 缺少工作区安装器")
        command = [python, "-X", "utf8", "-B", str(script)]
        target = ["--workspace", str(workspace)]
        status = run([*command, "status", *target], "检查团队规范", 15, allow_check_failure=True)
        hooks = run(["git", "-C", str(workspace), "config", "--local", "--get", "core.hooksPath"],
                    "检查 Git pre-commit", 10, allow_check_failure=True)
        if status.returncode == 0 and hooks.returncode == 0 and hooks.stdout.strip() == ".githooks":
            return
        # Preview and apply the same immutable bundle. The installer checks conflicts again on apply.
        run([*command, "init", *target, "--dry-run"], "预检查团队规范", 15)
        run([*command, "init", *target], "安装团队规范和开发门禁", 20)
