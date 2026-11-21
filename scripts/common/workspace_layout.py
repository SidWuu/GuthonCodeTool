"""The shared Git root and directories of its registered projects."""
from __future__ import annotations

from pathlib import Path
import re
import subprocess

from common.persistence import atomic_text

RESERVED = {"rules", "docs", "runtime", "nexus", "tools", ".guthon", ".codebuddy", ".codex", ".vscode", ".git"}
PROJECTS_DIRECTORY = "workspace"
IGNORE_BEGIN = "# BEGIN Guthon workspace runtime"
IGNORE_END = "# END Guthon workspace runtime"


def directory_name(value, *, reserved=RESERVED):
    if not isinstance(value, str) or not value or value != value.strip():
        raise ValueError("工作区目录名不能为空或包含首尾空格")
    if value in {".", ".."} or re.search(r'[\\/:*?"<>|\x00-\x1f\x7f]', value) or value.endswith("."):
        raise ValueError("工作区目录名包含文件系统不支持的字符")
    if value.casefold() in reserved or re.fullmatch(r"(?i)(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?", value):
        raise ValueError("工作区目录名与共用目录或系统保留名称冲突")
    return value


def workspace_directory_name(name):
    return directory_name(name, reserved={"config", "guthoncodetool", ".git"})


def workspace_directory(home, name):
    home = Path(home).resolve()
    root = home / workspace_directory_name(name)
    if root.is_symlink() or root.exists() and not root.is_dir():
        raise ValueError("开发目录必须是本地数据目录下的独立真实目录")
    return root


def projects_directory(space):
    directory = space / PROJECTS_DIRECTORY
    if directory.is_symlink() or directory.exists() and not directory.is_dir():
        raise ValueError("开发根目录下的 workspace 必须是真实目录")
    return directory


def registered_project_directory(space, value):
    """Resolve the registered relative path, including earlier one-level entries."""
    prefix = PROJECTS_DIRECTORY + "/"
    if isinstance(value, str) and value.startswith(prefix):
        # The root ignore block still covers context/ of prior one-level projects.
        name = directory_name(value[len(prefix):], reserved=RESERVED | {"context"})
        root = projects_directory(space) / name
    else:
        root = space / directory_name(value)
    if root.is_symlink() or root.exists() and not root.is_dir():
        raise ValueError("项目目录必须是真实目录")
    return root


def rules_directory(space):
    """Use the existing team rules root, or the legacy docs root."""
    space = Path(space)
    rules = space / "rules"
    if rules.exists() and not rules.is_dir():
        raise ValueError("rules 路径已存在且不是目录")
    directory = rules if rules.is_dir() else space / "docs"
    if directory.exists() and not directory.is_dir():
        raise ValueError(f"规范目标 {directory.name} 已存在且不是目录")
    return directory


def initialize_space(home, *, existing=False, directory="var", team_source=None):
    """Prepare a single Git root; retain human instructions and unrelated ignore rules."""
    space = workspace_directory(home, directory)
    # Windows setup may create var/nexus before invoking this command.
    # Those runtime files alone do not indicate an existing governance space.
    previous_governance = existing or any(
        (space / name).exists()
        for name in ("AGENTS.md", "docs", ".guthon", ".githooks", "tools", ".git")
    )
    projects = projects_directory(space)
    rules_directory(space)  # Reject occupied paths before changing the space.
    space.mkdir(parents=True, exist_ok=True)
    if not (space / ".git").exists():
        subprocess.run(["git", "init", "--quiet", str(space)], check=True, capture_output=True)
    actual = subprocess.run(["git", "-C", str(space), "rev-parse", "--show-toplevel"], check=True, capture_output=True, text=True)
    if Path(actual.stdout.strip()).resolve() != space:
        raise ValueError("开发目录必须是独立 Git 工作空间根")
    if not previous_governance:
        (space / "rules").mkdir(exist_ok=True)
    (space / "docs").mkdir(exist_ok=True)
    projects.mkdir(exist_ok=True)
    update_workspace_ignores(space)
    agents = space / "AGENTS.md"
    if team_source:
        from common.team_governance import sync_team_governance

        sync_team_governance(space, team_source)
    elif not agents.exists():
        atomic_text(agents, """# Guthon 工作空间

本文件适用于当前 Git 工作空间中的所有已注册目录。

- IDE 打开本开发目录，通过 Guthon Nexus 切换工作区。
- 新登记项目位于根 workspace/ 下。
- Codex 可打开具体工作区目录，继承本 Git 根目录的 AGENTS.md。
- 按任务读取开发规范：根 rules/ 存在时优先使用，否则使用根 docs/；根 docs/ 也保存共用参考资料。
- 每个工作区的 checkout/ 是唯一源码目录；docs/ 保存本工作区文档。
- context/ 保存索引、API 基线和恢复记录；runtime/ 保存运行产物。
- 从当前目录通过 workspace-resolve --path 定位工作区；后端操作始终传入明确 workspaceKey。
- Nexus 的当前选择只用于其窗口，不替代 Codex 当前目录或显式请求的目标。
- 本地修改、上传和平台业务验收分别核实，不把文件保存视为平台已生效。

规范正文由 guthon-team 维护和分发，更新时保留用户内容。
""")
    return space


def update_workspace_ignores(space):
    target = space / ".gitignore"
    original = target.read_text(encoding="utf-8") if target.exists() else ""
    block = "\n".join([
        IGNORE_BEGIN,
        "/*/runtime/", "/*/context/",
        f"/{PROJECTS_DIRECTORY}/*/runtime/", f"/{PROJECTS_DIRECTORY}/*/context/",
        f"/{PROJECTS_DIRECTORY}/**/checkout/",
        f"/{PROJECTS_DIRECTORY}/**/readonly/",
        f"/{PROJECTS_DIRECTORY}/**/database/",
        "/runtime/", "/nexus/", "/tools/", "/.guthon/", "/.codebuddy/settings.json",
        IGNORE_END,
    ])
    if IGNORE_BEGIN in original or IGNORE_END in original:
        if original.count(IGNORE_BEGIN) != 1 or original.count(IGNORE_END) != 1 or original.index(IGNORE_BEGIN) > original.index(IGNORE_END):
            raise ValueError("工作空间 .gitignore 受管区块损坏，请先检查原文件")
        start = original.index(IGNORE_BEGIN)
        end = original.index(IGNORE_END) + len(IGNORE_END)
        updated = original[:start] + block + original[end:]
    else:
        updated = original + ("\n" if original and not original.endswith("\n") else "") + block + "\n"
    if updated != original:
        atomic_text(target, updated)
