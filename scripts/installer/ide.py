"""Discover Windows editors with a local VSIX command-line entry."""
from dataclasses import dataclass
from pathlib import Path
import json
import os
import re
import shutil
import sys


@dataclass(frozen=True)
class IdeProduct:
    name: str
    folders: tuple[str, ...]
    executables: tuple[str, ...]
    commands: tuple[str, ...]


PRODUCTS = {
    "codebuddy-cn": IdeProduct("CodeBuddy 国内版", ("CodeBuddy CN", "CodeBuddyCN", "CodeBuddy-CN"),
                               ("CodeBuddy CN.exe", "CodeBuddyCN.exe", "CodeBuddy-CN.exe", "CodeBuddy.exe"),
                               ("codebuddy-cn", "codebuddy")),
    "codebuddy": IdeProduct("CodeBuddy 国际版", ("CodeBuddy",), ("CodeBuddy.exe",), ("codebuddy",)),
    "vscode": IdeProduct("Visual Studio Code", ("Microsoft VS Code", "Visual Studio Code", "VSCode"),
                         ("Code.exe",), ("code",)),
    "trae-cn": IdeProduct("Trae 国内版", ("Trae CN", "TraeCN"), ("Trae CN.exe", "Trae.exe"), ("trae-cn", "trae")),
    "trae": IdeProduct("Trae 国际版", ("Trae",), ("Trae.exe",), ("trae",)),
    "qoder": IdeProduct("Qoder", ("Qoder IDE", "Qoder"), ("Qoder IDE.exe", "Qoder.exe"), ("qoder", "qoder-ide")),
}
IDE_DOWNLOAD_URL = "https://www.codebuddy.cn/ide/"
NO_IDE = f"未检测到可安装 Nexus 的 IDE。请从 {IDE_DOWNLOAD_URL} 安装 CodeBuddy 国内版后，重新运行安装器。"
CURRENT_VERSION = re.compile(r"[\\/]([a-f0-9]{10}|_)[\\/]resources[\\/]app[\\/]out[\\/]cli\.js", re.I)
CLI_PATH = Path("resources/app/out/cli.js")
EXE_PRODUCTS = {}
for product, definition in PRODUCTS.items():
    for exe in definition.executables:
        EXE_PRODUCTS.setdefault(exe, []).append(product)
EXE_NAMES = {exe.lower() for exe in EXE_PRODUCTS}


def product_from_name(value):
    name = re.sub(r"\s*\((?:user|system)\)$", "", value.strip(), flags=re.I)
    normalized = re.sub(r"[^a-z\d]", "", name.lower())
    for product, definition in PRODUCTS.items():
        if any(normalized == re.sub(r"[^a-z\d]", "", folder.lower()) for folder in definition.folders):
            return product
    return None


def registered_roots():
    if os.name != "nt":
        return
    import winreg

    def read(key, name):
        try:
            value, kind = winreg.QueryValueEx(key, name)
            if kind in (winreg.REG_SZ, winreg.REG_EXPAND_SZ) and value:
                return winreg.ExpandEnvironmentStrings(value)
        except OSError:
            pass
        return ""

    base = r"Software\Microsoft\Windows\CurrentVersion"
    for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        for view in (winreg.KEY_WOW64_64KEY, winreg.KEY_WOW64_32KEY):
            access = winreg.KEY_READ | view
            try:
                with winreg.OpenKey(hive, base + r"\Uninstall", 0, access) as uninstall:
                    for index in range(winreg.QueryInfoKey(uninstall)[0]):
                        try:
                            with winreg.OpenKey(uninstall, winreg.EnumKey(uninstall, index), 0, access) as entry:
                                product = product_from_name(read(entry, "DisplayName"))
                                icon = re.fullmatch(r'"?(.+?\.exe)"?(?:\s*,\s*-?\d+)?', read(entry, "DisplayIcon").strip(), re.I)
                                if product and (location := read(entry, "InstallLocation").strip().strip('"')):
                                    yield Path(location), product
                                if icon and Path(icon[1]).name.lower() in EXE_NAMES:
                                    yield Path(icon[1]).parent, product
                        except OSError:
                            continue
            except OSError:
                pass

            for exe in EXE_PRODUCTS:
                try:
                    with winreg.OpenKey(hive, f"{base}\\App Paths\\{exe}", 0, access) as entry:
                        if location := read(entry, "").strip().strip('"'):
                            yield Path(location).parent, None
                except OSError:
                    continue


def ide_roots(explicit):
    if explicit:
        yield Path(explicit), None
    yield from registered_roots()
    for key in ("LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)"):
        if directory := os.environ.get(key):
            base = Path(directory)
            locations = (base / "Programs", base) if key == "LOCALAPPDATA" else (base,)
            for location in locations:
                for product, definition in PRODUCTS.items():
                    for folder in definition.folders:
                        yield location / folder, product
    for name in EXE_PRODUCTS:
        if path := shutil.which(name):
            yield Path(path).parent, None
    commands = dict.fromkeys(command for definition in PRODUCTS.values() for command in definition.commands)
    for command in commands:
        if path := shutil.which(command + ".cmd"):
            parent = Path(path).parent
            if parent.name.lower() == "bin":
                yield parent.parent, None


def ide_cli(root, products):
    # Newer IDE builds keep resources in a versioned subdirectory. Read the
    # vendor launcher's active path without executing a command shell.
    commands = dict.fromkeys(name for product in products for name in PRODUCTS[product].commands)
    for name in commands:
        try:
            with (root / "bin" / (name + ".cmd")).open("rb") as launcher:
                script = launcher.read(8192).decode("utf-8", errors="replace")
        except OSError:
            continue
        if active := CURRENT_VERSION.search(script):
            cli = root / active[1] / CLI_PATH
            return cli if cli.is_file() else None
    for cli in (root / CLI_PATH, root / "_" / CLI_PATH):
        if cli.is_file():
            return cli
    try:
        versioned = [child / CLI_PATH for child in root.iterdir()
                     if re.fullmatch(r"[a-f0-9]{10}", child.name, re.I) and (child / CLI_PATH).is_file()]
    except OSError:
        return None
    return versioned[0] if len(versioned) == 1 else None


def find_ides(explicit=None):
    explicit = Path(explicit).absolute() if explicit else None
    found = {}
    roots = {}
    for root, hint in ide_roots(explicit):
        if root.is_absolute() and not roots.get(root):
            roots[root] = hint
    preferred = None
    for root, hint in roots.items():
        for exe_name, products in EXE_PRODUCTS.items():
            exe = root / exe_name
            if not exe.is_file() or not (cli := ide_cli(root, products)):
                continue
            try:
                metadata = json.loads(cli.parent.parent.joinpath("product.json").read_text(encoding="utf-8-sig"))
            except (OSError, ValueError):
                metadata = {}
            names = (metadata.get(key) for key in ("nameLong", "nameShort", "applicationName", "win32DirName")
                     ) if isinstance(metadata, dict) else ()
            candidates = [hint, product_from_name(root.name),
                          *(product_from_name(name) for name in names if isinstance(name, str))]
            # Prefer edition-specific evidence when both editions share an EXE name.
            product = next((key for key in products if key in candidates), products[-1])
            found.setdefault(product, (exe, cli))
            if root == explicit:
                preferred = product
            break
    order = dict.fromkeys([preferred, *PRODUCTS])
    return {product: found[product] for product in order if product in found}


if __name__ == "__main__":
    output = Path(sys.argv[1])
    detected = find_ides(sys.argv[2] if len(sys.argv) > 2 else None)
    output.write_text("".join(f"{key}|{PRODUCTS[key].name}\n" for key in detected), encoding="utf-8-sig")
