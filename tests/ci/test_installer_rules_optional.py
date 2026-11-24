import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from common import config_store
from installer import engine


class InstallerRulesTest(unittest.TestCase):
    def test_public_installer_allows_blank_address_and_preserves_department_rules(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            home = root / "部门开发"
            space = home / "var"
            rules = space / "rules"
            rules.mkdir(parents=True)
            manual = {
                space / "AGENTS.md": "# 部门入口\n",
                rules / "department.md": "# 部门开发规范\n",
            }
            for file, content in manual.items():
                file.write_text(content, encoding="utf-8")
            custom = {"other-team": {"source": {"source": "git", "url": "https://example.invalid/other-team.git"}}}
            engine.write_json(space / ".codebuddy/settings.json", {"extraKnownMarketplaces": custom})

            payload = root / "payload"
            for name in ("tool/GuthonCodeTool.exe", "runtime/python.exe", "nexus.vsix"):
                file = payload / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text("fixture", encoding="utf-8")
            engine.write_json(payload / "chrome/extension/manifest.json", {
                "name": "Guthon Bridge", "version": "0.4.2", "manifest_version": 3,
            })
            manifest = {
                "schemaVersion": 1, "version": "0.4.2", "nexusVersion": "2.9.2", "marketplaceUrl": "",
                "prerequisites": [], "files": {file.relative_to(payload).as_posix(): engine.digest(file)
                                               for file in payload.rglob("*") if file.is_file()},
            }
            manifest["bundleId"] = hashlib.sha256(
                json.dumps(manifest, sort_keys=True, ensure_ascii=False).encode()
            ).hexdigest()[:20]
            engine.write_json(payload / "bundle.json", manifest)

            def run(command, label, **_):
                if label == "准备开发目录":
                    self.assertEqual(command[1:], ["setup", "--home", str(home.resolve()), "--no-team-sync"])
                    config_store.initialize(home)
                if label == "后端版本检查":
                    return json.dumps({"version": manifest["version"]})
                if "--show-versions" in command:
                    return engine.NEXUS_ID + "@" + manifest["nexusVersion"]
                return ""

            with (
                patch.dict(os.environ, {"LOCALAPPDATA": str(root / "appdata")}),
                patch.object(engine, "find_program", return_value=Path("/fixture/git")),
                patch.object(engine, "find_ides", return_value={
                    "codebuddy-cn": (Path("/fixture/CodeBuddy CN.exe"), Path("/fixture/cli.js")),
                }),
            ):
                engine.Installer(payload, home, runner=run, marketplace="").install()

            report = engine.read_json(space / "nexus/setup-result.json")
            self.assertEqual(report["state"], "environment-ready")
            self.assertNotIn("marketplaceUrl", report)
            settings = engine.read_json(space / ".codebuddy/settings.json")
            self.assertEqual(settings["extraKnownMarketplaces"], custom)
            self.assertNotIn("enabledPlugins", settings)
            self.assertEqual(config_store.read(home)["workspaces"], {})
            for file, content in manual.items():
                self.assertEqual(file.read_text(encoding="utf-8"), content)
