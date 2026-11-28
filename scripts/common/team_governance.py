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


def _windows_governance_python() -> str | None:
    candidates: list[tuple[Path, tuple[str, ...]]] = []
    if configured := os.environ.get("GUTHON_PYTHON"):
        path = Path(configured)
        if path.is_absolute():
            candidates.append((path, ()))
        elif found := shutil.which(configured):
            candidates.append((Path(found), ()))

    local = Path(os.environ.get("LOCALAPPDATA", ""))
    if local.is_absolute():
        # GuthonCodeSetup also registers its private runtime for other workspaces.
        managed = local / "Guthon"
        try:
            bundle_id = (managed / "python-version.txt").read_text(encoding="utf-8").strip()
        except (OSError, UnicodeError):
            bundle_id = ""
        if re.fullmatch(r"[a-f0-9]{20}", bundle_id):
            candidates.append((managed / "runtimes" / bundle_id / "python.exe", ()))

    directories = [Path(item.strip('"')) for item in os.get_exec_path()]
    python_names = ("python.exe", "python3.exe")
    candidates.extend((directory / name, ()) for directory in directories for name in python_names)
    windows = Path(os.environ.get("SystemRoot") or os.environ.get("WINDIR") or "")
    launcher_dirs = [*directories, windows, local / "Programs/Python/Launcher"]
    candidates.extend((directory / "py.exe", ("-3",)) for directory in launcher_dirs)

    # Discovery only queries installed runtimes, including through the Python launcher.
    env = {**os.environ, "PYTHON_MANAGER_AUTOMATIC_INSTALL": "false"}
    env.pop("PYLAUNCHER_ALLOW_INSTALL", None)
    env.pop("PYLAUNCHER_ALWAYS_INSTALL", None)
    probe = "import sys\nif sys.version_info < (3, 10): sys.exit(1)\nprint(sys.executable)"
    for candidate, args in dict.fromkeys(candidates):
        if not candidate.is_absolute():
            continue
        # The WindowsApps python/python3 aliases can fail with 9009 or open the Store.
        if candidate.parent.name.casefold() == "windowsapps" and candidate.name.casefold() in python_names:
            continue
        try:
            if not candidate.is_file():
                continue
            result = subprocess.run(
                [str(candidate), *args, "-X", "utf8", "-B", "-c", probe],
                env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True,
                encoding="utf-8", errors="replace", timeout=5,
            )
            if result.returncode == 0:
                executable = Path(result.stdout.strip())
                if executable.is_absolute() and executable.is_file():
                    return str(executable)
        except (OSError, subprocess.TimeoutExpired):
            continue
    return None


def sync_team_governance(workspace, source):
    source = _source(source)
    frozen = getattr(sys, "frozen", False)
    if frozen and sys.platform == "win32":
        python = _windows_governance_python()
        if not python:
            raise CommandError(
                "TEAM_PYTHON_MISSING",
                "未找到可用的 Python。请安装 Python 3.10 或更新版本，重新打开 IDE 后重试。"
                "也可以运行 GuthonCodeSetup 安装或修复随附的 Python。",
            )
    else:
        python = os.environ.get("GUTHON_PYTHON") or (
            shutil.which("python3") or shutil.which("python") if frozen else sys.executable
        )
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
