#!/usr/bin/env python3
"""Stage a verified offline suite, then compile GuthonCodeSetup.exe with Inno Setup."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import zipfile
from html.parser import HTMLParser

from installer.engine import digest, marketplace_url, payload_path, read_json, verify_payload, write_json

ROOT = Path(__file__).resolve().parents[1]


def package_windows_guide(stage):
    """Ship the canonical manuals and only their referenced local screenshots."""
    class Images(HTMLParser):
        def __init__(self):
            super().__init__()
            self.sources = set()

        def handle_starttag(self, tag, attributes):
            if tag == 'img':
                source = dict(attributes).get('src', '')
                if source and not source.startswith(('https://', 'http://', 'data:')):
                    self.sources.add(source)

    names = ('GuthonCodeTool_Windows安装步骤.html', 'GuthonCodeTool_使用手册.html',
             'GuthonCodeTool_全功能说明.html', 'GuthonCodeTool_QA.html')
    docs = stage / 'docs'
    docs.mkdir()
    for name in names:
        source = ROOT / 'docs' / name
        shutil.copy2(source, docs / name)
        parser = Images()
        parser.feed(source.read_text(encoding='utf-8'))
        for relative in parser.sources:
            source_image = payload_path(ROOT / 'docs', relative)
            destination = payload_path(docs, relative)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source_image, destination)


def unpack(source, destination):
    """Reject traversal, symlinks, duplicate names and oversized archive contents."""
    with zipfile.ZipFile(source) as archive:
        names = set()
        total = 0
        for item in archive.infolist():
            name = item.filename.rstrip("/")
            target = payload_path(destination, name)
            if name.casefold() in names or (item.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError("ZIP 包含重复路径或符号链接")
            names.add(name.casefold())
            total += item.file_size
            if total > 512 * 1024 * 1024:
                raise ValueError("ZIP 展开内容超过 512 MiB")
            if item.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(item) as src, target.open("wb") as dst:
                    shutil.copyfileobj(src, dst)


def prepare(args, stage):
    components = getattr(args, "components_dir", None)
    release = (components or args.release_dir).resolve()
    catalog = read_json(release / ("installer-components.json" if components else "GuthonCodeTool-release.json"))
    version = catalog["version"] if components else catalog["releaseVersion"]
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ValueError("发行版本无效")
    required = {"GuthonCodeTool-windows-x64.exe", "guthon-nexus-vscode.vsix", "GuthonCodeTool-chrome.zip", "guthon-testing.zip", "GuthonCodeTool-release.json"}
    if components:
        if catalog.get("schemaVersion") != 1 or set(catalog.get("files", {})) != required - {"GuthonCodeTool-release.json"}:
            raise ValueError("当前构建组件清单不完整")
        for name, checksum in catalog["files"].items():
            if digest(release / name) != checksum:
                raise ValueError("当前构建组件校验失败：" + name)
    else:
        # Downloaded releases always require independently provisioned trust.
        evidence = json.loads(subprocess.check_output([
            "node", str(ROOT / "scripts/verify_release.mjs"), "--release-dir", str(release),
            "--trust-file", str(ROOT / "plugins/GuthonNexus/gushen-vscode-completion/data/release-trust.json"),
            "--version", version,
        ], text=True))
        if not required <= set(evidence["verifiedFiles"]):
            raise ValueError("所需安装组件未全部被发行签名覆盖")
        for name in required - {"GuthonCodeTool-release.json"}:
            if name != "guthon-testing.zip" and catalog["assets"][name]["sha256"] != digest(release / name):
                raise ValueError("发行组件清单与实际附件不一致")
    (stage / "tool").mkdir()
    shutil.copy2(release / "GuthonCodeTool-windows-x64.exe", stage / "tool/GuthonCodeTool.exe")
    shutil.copy2(release / "guthon-nexus-vscode.vsix", stage / "nexus.vsix")
    unpack(release / "GuthonCodeTool-chrome.zip", stage / "chrome")
    unpack(release / "guthon-testing.zip", stage / "skills")
    if not (stage / "skills/guthon-testing/SKILL.md").is_file():
        raise ValueError("Testing Skill 附件结构无效")
    if not re.fullmatch(r"[a-f0-9]{64}", args.python_sha256) or digest(args.python_zip) != args.python_sha256:
        raise ValueError("私有 Python ZIP 与维护者核定哈希不一致")
    unpack(args.python_zip, stage / "runtime")
    pth_files = list((stage / "runtime").glob("python3*._pth"))
    if not all((stage / "runtime" / name).is_file() for name in ("python.exe", "pythonw.exe")) or len(pth_files) != 1:
        raise ValueError("需要 CPython 3.12+ Windows x64 embeddable ZIP")
    match = re.fullmatch(r"python3(\d+)\._pth", pth_files[0].name)
    if not match or int(match[1]) < 12 or not pth_files[0].with_suffix(".zip").is_file():
        raise ValueError("私有 Python 版本或标准库 ZIP 无效")
    import struct
    image = (stage / "runtime/python.exe").read_bytes()
    pe = struct.unpack_from("<I", image, 0x3c)[0]
    if image[:2] != b"MZ" or image[pe:pe + 4] != b"PE\0\0" or struct.unpack_from("<H", image, pe + 4)[0] != 0x8664:
        raise ValueError("私有 Python 不是 Windows x64 可执行文件")
    pth_files[0].write_text(pth_files[0].with_suffix('.zip').name + "\n.\n../installer\n", encoding="ascii")
    (stage / "installer/common").mkdir(parents=True)
    shutil.copy2(ROOT / "scripts/installer/engine.py", stage / "installer/engine.py")
    shutil.copy2(ROOT / "scripts/common/persistence.py", stage / "installer/common/persistence.py")
    package_windows_guide(stage)
    (stage / "installer/common/__init__.py").write_text("", encoding="utf-8")
    prerequisites = []
    if args.prerequisites:
        spec = read_json(args.prerequisites)
        if set(spec) != {"schemaVersion", "prerequisites"} or spec["schemaVersion"] != 1:
            raise ValueError("依赖安装包清单无效")
        for item in spec["prerequisites"]:
            if set(item) != {"id", "file", "sha256", "args", "elevate"} or item["id"] not in ("codebuddy", "git", "svn"):
                raise ValueError("依赖仅允许 codebuddy、git、svn")
            source = Path(item["file"])
            if not source.is_absolute():
                source = args.prerequisites.parent / source
            if (source.is_symlink() or source.suffix.lower() not in (".exe", ".msi")
                    or digest(source) != item["sha256"] or not isinstance(item["args"], list)
                    or not item["args"]
                    or any(not isinstance(a, str) or "\x00" in a for a in item["args"]) or not isinstance(item["elevate"], bool)):
                raise ValueError("依赖安装包或参数无效")
            name = "prerequisites/" + item["id"] + source.suffix.lower()
            (stage / "prerequisites").mkdir(exist_ok=True)
            shutil.copy2(source, stage / name)
            prerequisites.append({"id": item["id"], "file": name, "args": item["args"], "elevate": item["elevate"]})
    ids = [item["id"] for item in prerequisites]
    if len(set(ids)) != len(ids) or (not args.existing_tools and set(ids) != {"codebuddy", "git", "svn"}):
        raise ValueError("完整安装包必须包含 CodeBuddy、Git、SVN 三项；已有环境试用包需显式 --existing-tools")
    with zipfile.ZipFile(stage / "nexus.vsix") as archive:
        nexus = json.loads(archive.read("extension/package.json"))
        tool_version = json.loads(archive.read("extension/tool-version.json"))["version"]
        if nexus["publisher"] + "." + nexus["name"] != "gushen-local.guthon-nexus-vscode" or tool_version != version:
            raise ValueError("Nexus 身份或后端版本不一致")
        if not any(command.get("command") == "gushenCompletion.openOnboarding" for command in nexus.get("contributes", {}).get("commands", [])):
            raise ValueError("Nexus 不包含首次配置向导，必须构建本轮源码对应的 VSIX")
    manifest = {"schemaVersion": 1, "version": version, "nexusVersion": nexus["version"],
                "marketplaceUrl": marketplace_url(args.marketplace_url) if args.marketplace_url else "", "prerequisites": prerequisites,
                "files": {p.relative_to(stage).as_posix(): digest(p) for p in sorted(stage.rglob("*")) if p.is_file()}}
    manifest["bundleId"] = hashlib.sha256(json.dumps(manifest, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:20]
    write_json(stage / "bundle.json", manifest)
    verify_payload(stage)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--release-dir", type=Path)
    source.add_argument("--components-dir", type=Path, help="本机或同一 CI 作业刚构建的可信组件目录；不是下载发行")
    parser.add_argument("--marketplace-url", default="", help="仅内部定制包预置市场地址；公开包留空，由安装时填写")
    parser.add_argument("--python-zip", required=True, type=Path)
    parser.add_argument("--python-sha256", required=True)
    parser.add_argument("--prerequisites", type=Path)
    parser.add_argument("--existing-tools", action="store_true")
    parser.add_argument("--output", type=Path, default=ROOT / "dist/setup")
    parser.add_argument("--iscc", default="ISCC.exe")
    parser.add_argument("--stage-only", action="store_true")
    args = parser.parse_args()
    args.output = args.output.resolve()
    args.output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="guthon-setup-") as directory:
        stage = Path(directory)
        manifest = prepare(args, stage)
        target = args.output / manifest["bundleId"]
        if target.exists():
            verify_payload(target)
            if read_json(target / "bundle.json") != manifest:
                raise ValueError("同名安装载荷内容不一致")
        else:
            shutil.copytree(stage, target)
    if os.name == "nt":
        subprocess.run([os.sys.executable, str(ROOT / "scripts/check_installer_runtime.py"), "--payload", str(target)], check=True)
    if not args.stage_only:
        subprocess.run([args.iscc, "/DPayloadRoot=" + str(target), "/DOutputRoot=" + str(args.output),
                        "/DAppVersion=" + manifest["version"], "/DBundleId=" + manifest["bundleId"],
                        str(ROOT / "installer/windows/GuthonCodeSetup.iss")], check=True)
    print(json.dumps({"version": manifest["version"], "bundleId": manifest["bundleId"], "staged": str(target),
                      "compiled": not args.stage_only}, ensure_ascii=False))


if __name__ == "__main__":
    main()
