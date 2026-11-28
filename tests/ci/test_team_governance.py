import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from common import config_store, team_governance
from common.command_errors import CommandError


class WindowsTeamGovernanceTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.local = self.root / "AppData" / "Local"
        self.alias = self.local / "Microsoft" / "WindowsApps"
        self.env = {"LOCALAPPDATA": str(self.local), "SystemRoot": str(self.root / "Windows")}

    def write_file(self, path, content=""):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return path

    def test_packaged_setup_skips_store_aliases_and_uses_working_path_python(self):
        self.write_file(self.alias / "python.exe")
        self.write_file(self.alias / "python3.exe")
        broken = self.write_file(self.root / "stale" / "python.exe")
        installed = self.write_file(self.root / "Python 安装目录" / "python.exe")
        team = self.root / "team"
        self.write_file(team / "plugins/guthon-guard/scripts/guthon_workspace.py", """
import argparse
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('action')
parser.add_argument('--workspace', type=Path, required=True)
parser.add_argument('--dry-run', action='store_true')
args = parser.parse_args()
if args.action == 'status':
    raise SystemExit(1)
if not args.dry_run:
    (args.workspace / 'AGENTS.md').write_text('fixture rules', encoding='utf-8')
    subprocess.run(['git', '-C', str(args.workspace), 'config', 'core.hooksPath', '.githooks'], check=True)
""")
        env = {
            "LOCALAPPDATA": str(self.local),
            "GUTHON_PYTHON": "",
            "PATH": os.pathsep.join([str(self.alias), str(broken.parent), str(installed.parent),
                                    os.environ.get("PATH", "")]),
            "GIT_CONFIG_GLOBAL": str(self.write_file(self.root / "global.gitconfig")),
            "GIT_CONFIG_NOSYSTEM": "1",
        }
        actual_run = subprocess.run
        probes = []

        def run(command, **kwargs):
            if command[0] == "git" or command[0] == sys.executable:
                return actual_run(command, **kwargs)
            self.assertIn(command[0], {str(broken), str(installed)})
            probes.append(command[0])
            if command[0] == str(broken):
                return subprocess.CompletedProcess(command, 9009, "", "")
            return actual_run([sys.executable, *command[1:]], **kwargs)

        home = self.root / "data home"
        home.mkdir()
        with patch.dict(os.environ, env):
            actual_run(["git", "init", "-q", "-b", "main", str(team)], check=True)
            actual_run(["git", "-C", str(team), "add", "plugins"], check=True)
            actual_run(["git", "-C", str(team), "-c", "user.name=Fixture", "-c",
                        "user.email=fixture@example.invalid", "commit", "-qm", "fixture"], check=True)
            with (
                patch.object(sys, "frozen", True, create=True),
                patch.object(sys, "platform", "win32"),
                patch.object(team_governance.subprocess, "run", side_effect=run),
            ):
                config_store.initialize(home, workspace_name="开发目录", team_source=str(team))
            self.assertEqual(probes, [str(broken), str(installed)])
            self.assertEqual((home / "开发目录" / "AGENTS.md").read_text(encoding="utf-8"), "fixture rules")
            self.assertTrue((home / "config" / "guthon.json").is_file())
            hooks = subprocess.check_output(
                ["git", "-C", str(home / "开发目录"), "config", "--local", "--get", "core.hooksPath"], text=True,
            )
            self.assertEqual(hooks.strip(), ".githooks")

    def test_registered_installer_runtime_works_without_path_or_environment_override(self):
        managed = self.local / "Guthon"
        bundle_id = "a" * 20
        self.write_file(managed / "python-version.txt", bundle_id + "\n")
        python = self.write_file(managed / "runtimes" / bundle_id / "python.exe")
        with (
            patch.dict(os.environ, {**self.env, "PATH": str(self.alias)}, clear=True),
            patch.object(team_governance.subprocess, "run", return_value=subprocess.CompletedProcess(
                [], 0, str(python) + "\n", "",
            )) as run,
        ):
            self.assertEqual(team_governance._windows_governance_python(), str(python))
            self.assertEqual(run.call_args.args[0][0], str(python))

    def test_launcher_resolves_python_without_triggering_an_install(self):
        launcher = self.write_file(self.alias / "py.exe")
        python = self.write_file(self.root / "Python" / "python.exe")
        with (
            patch.dict(os.environ, {**self.env, "PATH": str(self.alias), "PYLAUNCHER_ALLOW_INSTALL": "1"}, clear=True),
            patch.object(team_governance.subprocess, "run", return_value=subprocess.CompletedProcess(
                [], 0, str(python) + "\n", "",
            )) as run,
        ):
            self.assertEqual(team_governance._windows_governance_python(), str(python))
            self.assertEqual(run.call_args.args[0][:2], [str(launcher), "-3"])
            self.assertNotIn("PYLAUNCHER_ALLOW_INSTALL", run.call_args.kwargs["env"])
            self.assertEqual(run.call_args.kwargs["env"]["PYTHON_MANAGER_AUTOMATIC_INSTALL"], "false")

    def test_alias_only_yields_actionable_missing_python_error(self):
        alias = self.write_file(self.alias / "python3.exe")
        with (
            patch.dict(os.environ, {**self.env, "PATH": str(self.alias), "GUTHON_PYTHON": str(alias)}, clear=True),
            patch.object(sys, "frozen", True, create=True),
            patch.object(sys, "platform", "win32"),
            patch.object(team_governance.subprocess, "run") as run,
        ):
            with self.assertRaises(CommandError) as failure:
                team_governance.sync_team_governance(self.root, str(self.root))
            self.assertEqual(failure.exception.error_code, "TEAM_PYTHON_MISSING")
            self.assertIn("请安装 Python 3.10 或更新版本，重新打开 IDE 后重试", str(failure.exception))
            self.assertIn("GuthonCodeSetup", str(failure.exception))
            run.assert_not_called()
