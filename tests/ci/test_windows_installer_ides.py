import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from installer import engine, ide


def editor(root, executable, version=""):
    cli = root / version / ide.CLI_PATH
    cli.parent.mkdir(parents=True)
    cli.touch()
    (root / executable).touch()
    return root / executable, cli


class IdeDiscoveryTest(unittest.TestCase):
    def test_detects_supported_layouts_and_ignores_uninstalled_entries(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            local = root / "Local" / "Programs"
            codebuddy = editor(local / "CodeBuddy CN", "CodeBuddy CN.exe")
            vscode_root = root / "程序文件" / "Microsoft VS Code"
            vscode = editor(vscode_root, "Code.exe", "a123456789")
            editor(vscode_root, "Code.exe", "b123456789")
            launcher = vscode_root / "bin/code.cmd"
            launcher.parent.mkdir()
            launcher.write_text(r'"%~dp0..\Code.exe" "%~dp0..\a123456789\resources\app\out\cli.js" %*')
            trae_root = root / "自定义安装位置" / "TRAE"
            trae = editor(trae_root, "Trae CN.exe")
            qoder = editor(root / "程序文件" / "Qoder IDE", "Qoder IDE.exe")
            stale = local / "CodeBuddy"
            stale.mkdir()
            (stale / "CodeBuddy.exe").touch()
            with (
                patch.dict(os.environ, {"LOCALAPPDATA": str(local.parent), "ProgramFiles": str(root / "程序文件")}, clear=True),
                patch.object(ide, "registered_roots", return_value=[(stale, "codebuddy"), (trae_root, "trae-cn")]),
                patch.object(ide.shutil, "which", return_value=None),
            ):
                self.assertEqual(ide.find_ides(), {
                    "codebuddy-cn": codebuddy, "vscode": vscode, "trae-cn": trae, "qoder": qoder,
                })
                self.assertEqual(next(iter(ide.find_ides(vscode_root))), "vscode")

    def test_shared_executable_name_can_identify_cn_edition_by_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cn = editor(root / "应用", "CodeBuddy.exe")
            cn[1].parent.parent.joinpath("product.json").write_text('{"applicationName":"codebuddy-cn"}')
            international = editor(root / "CodeBuddy", "CodeBuddy.exe")
            with patch.object(ide, "ide_roots", return_value=[(cn[0].parent, None), (international[0].parent, None)]):
                self.assertEqual(ide.find_ides(), {"codebuddy-cn": cn, "codebuddy": international})


class InstallSelectedIdesTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.home = self.root / "工作数据"
        self.payload = self.root / "payload"
        self.editors = {
            "codebuddy-cn": (self.root / "CodeBuddy CN.exe", self.root / "codebuddy.js"),
            "vscode": (self.root / "Code.exe", self.root / "code.js"),
            "qoder": (self.root / "Qoder IDE.exe", self.root / "qoder.js"),
        }
        for name in ("tool/GuthonCodeTool.exe", "runtime/python.exe", "nexus.vsix"):
            file = self.payload / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.touch()
        engine.write_json(self.payload / "chrome/extension/manifest.json", {
            "name": "Guthon Bridge", "version": "0.4.2", "manifest_version": 3,
        })
        self.manifest = {
            "schemaVersion": 1, "version": "0.4.2", "nexusVersion": "2.9.2", "marketplaceUrl": "",
            "prerequisites": [], "files": {file.relative_to(self.payload).as_posix(): engine.digest(file)
                                           for file in self.payload.rglob("*") if file.is_file()},
        }
        self.seal_payload()
        self.calls = []
        self.bad_listing = None
        for mock in (
            patch.dict(os.environ, {"LOCALAPPDATA": str(self.root / "appdata")}),
            patch.object(engine, "find_ides", return_value=self.editors),
            patch.object(engine, "find_program", return_value=self.root / "Git/cmd/git.exe"),
        ):
            mock.start()
            self.addCleanup(mock.stop)

    def seal_payload(self):
        self.manifest.pop("bundleId", None)
        data = json.dumps(self.manifest, sort_keys=True, ensure_ascii=False)
        self.manifest["bundleId"] = hashlib.sha256(data.encode()).hexdigest()[:20]
        engine.write_json(self.payload / "bundle.json", self.manifest)

    def run_command(self, command, label, *, env):
        self.calls.append(command)
        if label == "后端版本检查":
            return json.dumps({"version": self.manifest["version"]})
        if "--install-extension" in command or "--list-extensions" in command:
            self.assertEqual(env.get("ELECTRON_RUN_AS_NODE"), "1")
        if "--show-versions" in command and command[0] != self.bad_listing:
            return engine.NEXUS_ID.upper() + "@" + self.manifest["nexusVersion"] + "\n"
        return ""

    def installer(self, selection=None, **options):
        return engine.Installer(self.payload, self.home, runner=self.run_command, selected_ides=selection, **options)

    def test_installs_only_selected_ides_and_prepares_workspace_without_launching(self):
        installer = self.installer(["vscode", "qoder"])
        with patch.object(engine.subprocess, "Popen") as launch:
            installer.install()
        launch.assert_not_called()
        expected = [str(self.editors[product][0]) for product in ("vscode", "qoder")]
        self.assertEqual([command[0] for command in self.calls if "--install-extension" in command], expected)
        self.assertEqual([command[0] for command in self.calls if "--show-versions" in command], expected)
        report = engine.read_json(installer.report_path)
        self.assertEqual([entry["id"] for entry in report["ides"]], ["vscode", "qoder"])
        workspace = self.home / "Guthon.code-workspace"
        settings = engine.read_json(workspace)["settings"]
        self.assertEqual(settings["gushenCompletion.toolHome"], str(self.home))
        self.assertEqual(settings["gushenCompletion.toolPath"], str(self.payload / "tool/GuthonCodeTool.exe"))
        instructions = installer.report_path.with_suffix(".html").read_text(encoding="utf-8")
        self.assertIn(str(workspace), instructions)
        self.assertIn("从活动栏进入 Guthon Nexus", instructions)

    def test_distinguishes_verified_ides_from_failed_ones(self):
        self.bad_listing = str(self.editors["vscode"][0])
        installer = self.installer(["vscode", "qoder"])
        with self.assertRaisesRegex(engine.SetupError, "Visual Studio Code.*Nexus"):
            installer.install()
        report = engine.read_json(installer.report_path)
        self.assertEqual(report["state"], "failed")
        self.assertEqual([entry["id"] for entry in report["ides"]], ["qoder"])
        self.bad_listing = None
        self.installer(["vscode", "qoder"]).install()
        self.assertEqual(engine.read_json(installer.report_path)["state"], "environment-ready")

    def test_missing_editor_provides_domestic_download_before_running_dependencies(self):
        self.editors.clear()
        installer = self.installer()
        with self.assertRaisesRegex(engine.SetupError, r"https://www\.codebuddy\.cn/ide/"):
            installer.install()
        self.assertEqual(self.calls, [])
        self.assertIn(engine.IDE_DOWNLOAD_URL, installer.report_path.with_suffix(".html").read_text())

    def test_missing_selected_ide_does_not_install_into_another_editor(self):
        with self.assertRaisesRegex(engine.SetupError, "所选 IDE 已不可用"):
            self.installer(["trae-cn"]).install()
        self.assertEqual(self.calls, [])

    def test_reinstall_after_switching_from_international_to_domestic_codebuddy(self):
        installer = self.installer(["codebuddy-cn"])
        engine.write_json(installer.report_path, {
            "schemaVersion": 1, "state": "environment-ready", "programs": {"git": "git.exe"},
        })
        installer.install()
        report = engine.read_json(installer.report_path)
        self.assertEqual([entry["id"] for entry in report["ides"]], ["codebuddy-cn"])
        installed = [command[0] for command in self.calls if "--install-extension" in command]
        self.assertEqual(installed, [str(self.editors["codebuddy-cn"][0])])

    def test_git_install_keeps_configured_marketplace_address(self):
        prerequisite = {"id": "git", "file": "prerequisites/git.exe", "args": ["/VERYSILENT"], "elevate": False}
        package = self.payload / prerequisite["file"]
        package.parent.mkdir()
        package.touch()
        self.manifest["files"][prerequisite["file"]] = engine.digest(package)
        self.manifest["prerequisites"] = [prerequisite]
        self.seal_payload()
        source = "https://example.invalid/team.git"
        with (
            patch.object(engine, "find_program", side_effect=[None, self.root / "Git/cmd/git.exe"]),
            patch.object(engine, "install_package") as install_package,
        ):
            installer = self.installer(["codebuddy-cn"], marketplace=source)
            installer.install()
        self.assertEqual(install_package.call_args.args[0], [package, "/VERYSILENT"])
        self.assertEqual(engine.read_json(installer.report_path)["marketplaceUrl"], source)


if __name__ == "__main__":
    unittest.main()
