"""Windows setup orchestration with bundled or pinned on-demand prerequisites."""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys

sys.dont_write_bytecode = True
from common.persistence import atomic_text, file_lock
from common.installer_downloads import fetch
if __package__:
    from .ide import IDE_DOWNLOAD_URL, NO_IDE, PRODUCTS, find_ides
else:
    from ide import IDE_DOWNLOAD_URL, NO_IDE, PRODUCTS, find_ides

NEXUS_ID = "gushen-local.guthon-nexus-vscode"
MISSING = object()


def marketplace_url(value):
    from urllib.parse import urlsplit
    url = urlsplit(value)
    if (not value or re.search(r'[\x00-\x20"\\]', value) or url.scheme not in ("ssh", "https", "http")
            or not url.hostname or url.password or url.query or url.fragment):
        raise SetupError("请提供不含密码的内网 Git 插件市场地址")
    return value


class SetupError(RuntimeError):
    pass


def read_json(path):
    value = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    if not isinstance(value, dict):
        raise SetupError("配置必须是 JSON 对象")
    return value


def write_json(path, value):
    atomic_text(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def digest(path):
    with Path(path).open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def payload_path(root, name):
    parts = PurePosixPath(name).parts
    reserved = {"CON", "PRN", "AUX", "NUL", *("COM" + str(i) for i in range(1, 10)), *("LPT" + str(i) for i in range(1, 10))}
    if (not parts or "\\" in name or ":" in name or any(p in ("", ".", "..") for p in name.split("/"))
            or any(p.endswith((".", " ")) or p.split(".")[0].upper() in reserved for p in parts)):
        raise SetupError("安装载荷路径无效")
    target = root.joinpath(*parts)
    if not target.resolve().is_relative_to(root.resolve()) or any(
        path.is_symlink() or path.is_junction() for path in (target, *target.parents) if path.is_relative_to(root)
    ):
        raise SetupError("安装载荷不允许符号链接或目录越界")
    return target


def verify_payload(root):
    manifest = read_json(root / "bundle.json")
    if manifest.get("schemaVersion") != 1 or not isinstance(manifest.get("files"), dict):
        raise SetupError("安装清单无效")
    expected = manifest["files"]
    actual = {p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file()}
    if actual != set(expected) | {"bundle.json"}:
        raise SetupError("安装包包含缺失或未登记的文件")
    for name, checksum in expected.items():
        if not re.fullmatch(r"[a-f0-9]{64}", checksum) or digest(payload_path(root, name)) != checksum:
            raise SetupError("安装包校验失败：" + name)
    unsigned = {k: v for k, v in manifest.items() if k != "bundleId"}
    bundle_id = hashlib.sha256(json.dumps(unsigned, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:20]
    if manifest.get("bundleId") != bundle_id:
        raise SetupError("安装清单身份不匹配")
    for item in manifest.get("prerequisites", []):
        if "url" in item:
            validate_download(item)
    return manifest


def validate_download(item):
    from urllib.parse import urlsplit

    if (set(item) != {"id", "type", "elevate", "url", "sha256", "args"}
            or item["id"] != "git"
            or item["type"] not in {"exe", "msi"}
            or not isinstance(item["elevate"], bool)
            or not isinstance(item["args"], list) or not item["args"]
            or any(not isinstance(arg, str) or "\x00" in arg for arg in item["args"])
            or not isinstance(item["sha256"], str) or not re.fullmatch(r"[a-f0-9]{64}", item["sha256"])):
        raise SetupError("在线依赖清单无效")
    url = urlsplit(item["url"])
    if url.scheme != "https" or not url.hostname or url.username or url.password or url.fragment:
        raise SetupError("在线依赖必须使用无凭据的 HTTPS 地址")


def prerequisite_file(payload, item):
    if "url" not in item:
        return payload_path(payload, item["file"])
    validate_download(item)
    cache = Path(os.environ["LOCALAPPDATA"]) / "Guthon/downloads"
    name = item["id"] + "-" + item["sha256"] + "." + item["type"]
    target = payload_path(cache, name)
    cache.mkdir(parents=True, exist_ok=True)
    try:
        with file_lock(cache / ".download.lock", timeout=1):
            fetch(item["url"], item["sha256"], target, limit=512 * 1024 * 1024)
    except ValueError as error:
        raise SetupError(item["id"] + " 下载或校验失败；检查网络后重新运行安装器：" + str(error)) from None
    return target


def merge_managed(current, desired, previous, location=""):
    """Only replace leaves still matching the last successful setup's values."""
    merged = copy.deepcopy(current)
    for key, value in desired.items():
        old = current.get(key, MISSING)
        owned = previous.get(key, MISSING)
        if isinstance(value, dict):
            if old is not MISSING and not isinstance(old, dict):
                raise SetupError("保留已有配置，冲突项：" + location + key)
            merged[key] = merge_managed({} if old is MISSING else old, value,
                                        owned if isinstance(owned, dict) else {}, location + key + ".")
        elif old is MISSING or old == value or (owned is not MISSING and old == owned):
            merged[key] = value
        else:
            raise SetupError("保留已有配置，冲突项：" + location + key)
    return merged


def run(command, label, *, env=None, data=None):
    if Path(command[0]).name.lower() == "python.exe":
        command = [command[0], "-X", "utf8", "-B", *command[1:]]
    try:
        completed = subprocess.run(command, input=data, capture_output=True, text=True,
                                   encoding="utf-8", errors="replace", env=env, timeout=1800)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise SetupError(f"{label}失败（{type(error).__name__}），请检查对应工具后重试") from error
    if completed.returncode:
        # Do not persist external command output: it may contain local configuration.
        raise SetupError(f"{label}失败（退出码 {completed.returncode}），请在对应工具中检查后重试")
    return completed.stdout


def install_package(command, label, elevate):
    """Use the Windows installer elevation boundary, without cmd.exe or shell text."""
    if os.name != "nt":
        raise SetupError("依赖安装仅支持 Windows")
    import ctypes
    from ctypes import wintypes

    class ShellExecuteInfo(ctypes.Structure):
        _fields_ = [("cbSize", wintypes.DWORD), ("fMask", wintypes.ULONG),
                    ("hwnd", wintypes.HWND), ("lpVerb", wintypes.LPCWSTR),
                    ("lpFile", wintypes.LPCWSTR), ("lpParameters", wintypes.LPCWSTR),
                    ("lpDirectory", wintypes.LPCWSTR), ("nShow", ctypes.c_int),
                    ("hInstApp", wintypes.HINSTANCE), ("lpIDList", ctypes.c_void_p),
                    ("lpClass", wintypes.LPCWSTR), ("hkeyClass", wintypes.HKEY),
                    ("dwHotKey", wintypes.DWORD), ("hIcon", wintypes.HANDLE),
                    ("hProcess", wintypes.HANDLE)]

    shell = ctypes.WinDLL("shell32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    shell.ShellExecuteExW.argtypes = [ctypes.POINTER(ShellExecuteInfo)]
    shell.ShellExecuteExW.restype = wintypes.BOOL
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.WaitForSingleObject.restype = wintypes.DWORD
    kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel.GetExitCodeProcess.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    info = ShellExecuteInfo()
    info.cbSize = ctypes.sizeof(info)
    info.fMask = 0x40  # SEE_MASK_NOCLOSEPROCESS
    info.lpVerb = "runas" if elevate else "open"
    info.lpFile = str(command[0])
    info.lpParameters = subprocess.list2cmdline([str(p) for p in command[1:]])
    info.nShow = 1
    if not shell.ShellExecuteExW(ctypes.byref(info)) or not info.hProcess:
        raise SetupError(label + "未启动，请检查或确认系统安装授权")
    try:
        if kernel.WaitForSingleObject(info.hProcess, 1800000) != 0:
            raise SetupError(label + "等待超时，请等待第三方安装结束后再重试")
        code = wintypes.DWORD()
        if not kernel.GetExitCodeProcess(info.hProcess, ctypes.byref(code)):
            raise SetupError(label + "未取得安装结果")
        if code.value in (1641, 3010):
            raise SetupError(label + "需要重启，请重启后重新运行本安装包")
        if code.value:
            raise SetupError(f"{label}失败（退出码 {code.value}），请检查后重试")
    finally:
        kernel.CloseHandle(info.hProcess)


def program_candidates(name):
    folders = {"git": ("Git/cmd/git.exe",)}
    candidates = []
    found = shutil.which(name)
    if found:
        candidates.append(Path(found))
    for key in ("LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)"):
        if base := os.environ.get(key):
            for prefix in ("", "Programs"):
                candidates.extend(Path(base) / prefix / suffix for suffix in folders[name])
    return candidates


def find_program(name):
    return next((p for p in program_candidates(name) if p.is_file()), None)


def private_runtime(root, manifest):
    destination = Path(os.environ["LOCALAPPDATA"]) / "Guthon/runtimes" / manifest["bundleId"]
    for relative, checksum in manifest["files"].items():
        if not relative.startswith("runtime/"):
            continue
        target = destination / relative.removeprefix("runtime/")
        if target.exists():
            if target.is_symlink() or target.is_junction() or digest(target) != checksum:
                raise SetupError("已有私有 Python 内容不一致，请检查后重试")
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(payload_path(root, relative), target)
    return destination / "python.exe"


class Installer:
    def __init__(self, payload, home, ide=None, runner=run, marketplace=None, *, selected_ides=None):
        self.payload = Path(payload).resolve()
        self.home = Path(home).resolve()
        self.ide_root = ide
        self.selected_ides = selected_ides
        self.marketplace = marketplace
        self.runner = runner
        self.report_path = self.home / "var/nexus/setup-result.json"
        self.lock_path = self.home / "var/nexus/setup-managed.json"
        self.report = {"schemaVersion": 1, "state": "installing", "completed": [], "actions": []}
        self.report["programs"] = {}
        self.env = {**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}

    def step(self, name):
        self.report["phase"] = name
        write_json(self.report_path, self.report)
        if sys.stdout:
            print("GUTHON_STEP " + name, flush=True)

    def complete(self):
        self.report["completed"].append(self.report["phase"])
        write_json(self.report_path, self.report)

    def execute(self, command, label, **kwargs):
        return self.runner([str(p) for p in command], label, env=self.env, **kwargs)

    def configuration(self, manifest, source):
        workspace = {
            "folders": [{"path": "var"}],
            "settings": {"gushenCompletion.executionMode": "packaged",
                         "gushenCompletion.toolPath": str(self.payload / "tool/GuthonCodeTool.exe"),
                         "gushenCompletion.toolHome": str(self.home),
                         "gushenCompletion.onboarding": True,
                         "gushenCompletion.autoStartBridge": False},
        }
        settings = {
            "env": {"GUTHON_PYTHON": str(Path(os.environ['LOCALAPPDATA']) / 'Guthon/runtimes' / manifest['bundleId'] / 'python.exe'),
                    "PATH": os.pathsep.join(dict.fromkeys(self.env.get('PATH', '').split(os.pathsep)))},
        }
        if source:
            settings.update(
                extraKnownMarketplaces={"guthon-team": {"source": {"source": "git", "url": source}}},
                enabledPlugins={"guthon-guard@guthon-team": True},
            )
        desired = {"Guthon.code-workspace": workspace, "var/.codebuddy/settings.json": settings}
        previous = read_json(self.lock_path) if self.lock_path.exists() else {}
        plans = {}
        for relative, value in desired.items():
            target = self.home / relative
            if target.is_symlink() or target.is_junction():
                raise SetupError("受管配置不允许符号链接：" + relative)
            current = read_json(target) if target.exists() else {}
            plans[relative] = merge_managed(current, value, previous.get(relative, {}))
        return desired, plans

    def install(self):
        manifest = verify_payload(self.payload)
        if self.home == Path(self.home.anchor) or self.home.is_relative_to(self.payload):
            raise SetupError("请选择独立的用户数据目录")
        for relative in ("config", "var", "var/nexus", "var/.guthon", "var/tools", "var/docs", "var/.codebuddy", "var/rules"):
            directory = self.home / relative
            if directory.is_symlink() or directory.is_junction() or (directory.exists() and not directory.is_dir()):
                raise SetupError("受管目录不允许符号链接或非目录：" + relative)
            # Only inspect installer/governance destinations, never checkout sources.
            if relative in ("config", "var/nexus", "var/.guthon", "var/tools", "var/docs", "var/.codebuddy") and directory.exists():
                if any(p.is_symlink() or p.is_junction() for p in directory.rglob("*")):
                    raise SetupError("受管目录内存在符号链接：" + relative)
        self.report["version"] = manifest["version"]
        self.report["bundleId"] = manifest["bundleId"]
        self.report["nexusVersion"] = manifest["nexusVersion"]
        with file_lock(self.home / "var/nexus/.setup.lock", timeout=1):
            try:
                self.step("检查已有配置")
                ides = find_ides(self.ide_root)
                if not ides:
                    raise SetupError(NO_IDE)
                selected = self.selected_ides if self.selected_ides is not None else [next(iter(ides))]
                if not selected or any(product not in ides for product in selected):
                    raise SetupError("所选 IDE 已不可用，请重新运行安装器并检查选择")
                source = (self.marketplace or manifest.get("marketplaceUrl", "")).strip()
                if source:
                    source = marketplace_url(source)
                self.configuration(manifest, source)
                python = self.payload / "runtime/python.exe"
                self.execute([python, "-c", "import sys; assert sys.version_info >= (3, 12)"], "Python 自检")
                self.env["GUTHON_PYTHON"] = str(python)
                self.complete()
                self.step("准备 Git")
                git = find_program("git")
                if not git:
                    prerequisite = next((p for p in manifest["prerequisites"] if p["id"] == "git"), None)
                    if not prerequisite:
                        raise SetupError("本包未包含 Git，请先安装 Git 后重试")
                    self.step("下载并校验 Git" if "url" in prerequisite else "安装 Git")
                    package = prerequisite_file(self.payload, prerequisite)
                    command = ["msiexec.exe", "/i", package] if package.suffix.lower() == ".msi" else [package]
                    install_package([*command, *prerequisite["args"]], "Git 安装", prerequisite["elevate"])
                    git = find_program("git")
                if not git:
                    raise SetupError("Git 安装后未找到入口，请检查安装位置并重试")
                self.report["programs"]["git"] = str(git.resolve())
                self.execute([git, "--version"], "Git 自检")
                git_folders = [str(git.parent)]
                if (tools := git.parent.parent / "usr/bin").is_dir():
                    git_folders.insert(0, str(tools))
                self.env["PATH"] = os.pathsep.join([*git_folders, self.env.get("PATH", "")])
                self.complete()
                tool = self.payload / "tool/GuthonCodeTool.exe"
                self.step("初始化 GuthonCodeTool")
                version = self.execute([tool, "version"], "后端版本检查")
                if json.loads(version).get("version") != manifest["version"]:
                    raise SetupError("后端版本与安装包不一致")
                self.execute([tool, "setup", "--home", self.home, "--no-team-sync"], "准备开发目录")
                self.complete()
                cli_env = {**self.env, "ELECTRON_RUN_AS_NODE": "1"}
                cli_env.pop("VSCODE_DEV", None)
                expected = f"{NEXUS_ID}@{manifest['nexusVersion']}"
                self.report["ides"] = []
                failures = []
                for product in dict.fromkeys(selected):
                    name = PRODUCTS[product].name
                    self.step(f"在 {name} 安装 Nexus")
                    executable, cli_script = ides[product]
                    cli = [str(executable), str(cli_script)]
                    try:
                        self.runner([*cli, "--install-extension", str(self.payload / "nexus.vsix"), "--force"],
                                    f"{name} Nexus 安装", env=cli_env)
                        listing = self.runner([*cli, "--list-extensions", "--show-versions"],
                                              f"{name} Nexus 安装验证", env=cli_env)
                        if expected.lower() not in {line.strip().lower() for line in listing.splitlines()}:
                            raise SetupError(f"{name} 尚未确认目标 Nexus 版本已安装")
                    except SetupError as error:
                        failures.append(str(error))
                        continue
                    self.report["ides"].append({"id": product, "name": name, "executable": str(executable)})
                    self.complete()
                if failures:
                    raise SetupError("；".join(failures))
                self.step("配置 Guthon 工作区")
                self.install_bridge()
                # Re-read to catch manual changes made while component installation ran.
                desired, plans = self.configuration(manifest, source)
                for relative, value in plans.items():
                    write_json(self.home / relative, value)
                write_json(self.lock_path, desired)
                installed_python = private_runtime(self.payload, manifest)
                self.execute([installed_python, "-c", "import sys; assert sys.version_info >= (3, 12)"], "私有 Python 自检")
                runtime_registry = Path(os.environ["LOCALAPPDATA"]) / "Guthon/python-version.txt"
                with file_lock(runtime_registry.with_suffix(".lock")):
                    atomic_text(runtime_registry, manifest["bundleId"] + "\n")
                self.complete()
                self.report["state"] = "environment-ready"
                from datetime import datetime, timezone
                self.report["installedAt"] = datetime.now(timezone.utc).isoformat()
                self.report["tutorialPath"] = str(self.payload / "docs/GuthonCodeTool_Windows安装步骤.html")
                self.report["actions"].append(
                    f"在已安装 Nexus 的 IDE 中，从文件菜单打开工作区 {self.home / 'Guthon.code-workspace'}。"
                    "按提示信任工作区，再从活动栏进入 Guthon Nexus，完成一次性配置。"
                )
                if source:
                    self.report["marketplaceUrl"] = source
                    self.report["guardMinimumVersion"] = "0.5.0"
                    self.report["actions"].extend([
                        "按向导授权内网仓库并同步团队规范和开发门禁。",
                        "如需 Agent 生命周期检查，再从市场安装 guthon-guard 并确认 Hook 运行。",
                    ])
                else:
                    self.report["actions"].append("可以先完成安装确认，再将部门提供的规则放入开发目录。")
                self.report["actions"].append("需要网页增强时，可在安装配置助手中配对 Chrome Bridge。")
                write_json(self.report_path, self.report)
                self.write_result_page()
            except Exception as error:
                self.report["state"] = "failed"
                self.report["error"] = str(error) if isinstance(error, SetupError) else type(error).__name__
                write_json(self.report_path, self.report)
                self.write_result_page()
                raise

    def install_bridge(self):
        """Provision the same stable Chrome path used by Nexus updates."""
        import uuid
        source = self.payload / "chrome/extension"
        target = self.home / "var/nexus/updates/chrome/extension"
        marker_path = target / "managed-install.json"
        if not (source / "manifest.json").is_file():
            raise SetupError("安装包缺少 GuthonBridge 扩展")
        manifest = read_json(source / "manifest.json")
        if manifest.get("name") != "Guthon Bridge" or manifest.get("manifest_version") != 3:
            raise SetupError("GuthonBridge 扩展身份无效")
        if target.exists():
            marker = read_json(marker_path) if marker_path.is_file() else {}
            if marker.get("schemaVersion") != 1 or not marker.get("installId"):
                raise SetupError("已有浏览器扩展目录未托管，保留文件并停止")
            current = read_json(target / "manifest.json")
            if current.get("version") != marker.get("version"):
                raise SetupError("浏览器扩展版本与托管标识不一致")
            # Existing managed updates are kept. The Nexus updater handles upgrades.
            self.report["actions"].append("已复用托管 GuthonBridge；如有新版可在 Nexus 检查更新。")
            return
        target.parent.mkdir(parents=True, exist_ok=True)
        staging = target.parent / (".setup-" + uuid.uuid4().hex)
        try:
            shutil.copytree(source, staging)
            write_json(staging / "managed-install.json", {
                "schemaVersion": 1, "installId": str(uuid.uuid4()), "version": manifest["version"],
            })
            os.replace(staging, target)
        finally:
            if staging.exists():
                shutil.rmtree(staging)

    def write_result_page(self):
        import html
        body = "".join("<li>" + html.escape(a) + "</li>" for a in self.report["actions"])
        installed = "、".join(html.escape(ide["name"]) for ide in self.report.get("ides", []))
        if installed:
            body = f"<li>已验证 Nexus 的 IDE：{installed}。</li>" + body
        error = html.escape(self.report.get("error", ""))
        title = "基础组件已准备，请完成一次性安装确认" if self.report["state"] == "environment-ready" else "安装未完成，可修复后重新运行"
        tutorial = f'''<h2>需要手动安装时</h2><ol>
<li>没有可用 IDE 时，前往 <a href="{IDE_DOWNLOAD_URL}">CodeBuddy 国内版官网</a>下载并安装 Windows 版。</li>
<li>Git：从 <a href="https://gitforwindows.org/">Git for Windows 官网</a>安装，保留命令行工具选项。</li>
<li>若使用离线依赖安装包，可从安装载荷的 prerequisites 子目录找到已校验的 Git 安装文件。</li>
<li>完成手动安装后重新运行 GuthonCodeSetup.exe。</li></ol>'''
        page = f'<!doctype html><meta charset="utf-8"><title>Guthon 安装结果</title><style>body{{font:18px sans-serif;max-width:800px;margin:60px auto;line-height:1.8}}li{{margin:12px 0}}</style><h1>{title}</h1><p>{error}</p><ul>{body}</ul>{tutorial}<p>重新运行同一安装包会复查已安装组件；保留已有数据和人工修改。不会自动提交或发布源码。</p>'
        atomic_text(self.report_path.with_suffix(".html"), page)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--payload", required=True, type=Path)
    parser.add_argument("--home", required=True, type=Path)
    parser.add_argument("--ide-root", type=Path)
    parser.add_argument("--ides")
    parser.add_argument("--marketplace-url")
    args = parser.parse_args()
    try:
        installer = Installer(args.payload, args.home, args.ide_root, marketplace=args.marketplace_url,
                              selected_ides=args.ides.split(",") if args.ides is not None else None)
        installer.install()
        return 0
    except Exception as error:
        if sys.stderr:
            print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
