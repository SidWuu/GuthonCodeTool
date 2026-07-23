import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import export_system_script_sql as exporter  # noqa: E402


class FakeCursor:
    def __init__(self, connection):
        self.connection = connection
        self.rows = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, sql, params):
        self.connection.calls.append((sql, params))
        self.rows = self.connection.results.pop(0)

    def fetchall(self):
        return self.rows


class FakeConnection:
    def __init__(self, results):
        self.results = list(results)
        self.calls = []

    def cursor(self):
        return FakeCursor(self)


class ExportSystemScriptSqlTest(unittest.TestCase):
    def test_exports_standard_and_inherited_scripts(self):
        systems = [
            {
                "SYSTEM_ID": "SYS-1",
                "SYSTEM_NAME": "风险管理",
                "SYSTEM_ALIAS_ID": "gdrm",
                "DATA_SOURCE_ID": "0015",
            }
        ]
        scripts = [
            {
                "SCRIPT_TYPE": 20,
                "SYSTEM_ID": "SYS-1",
                "SCRIPT": "const current = true;",
                "PROD_SCRIPT": "",
                "IS_PRODUCT": 0,
                "USE_REMARK": None,
            },
            {
                "SCRIPT_TYPE": 30,
                "SYSTEM_ID": "SYS-1",
                "SCRIPT": "@inherit();\n",
                "PROD_SCRIPT": ".root { color: red; }\n",
                "IS_PRODUCT": 1,
                "USE_REMARK": None,
            },
            {
                "SCRIPT_TYPE": 10000,
                "SYSTEM_ID": "SYS-1",
                "SCRIPT": "",
                "PROD_SCRIPT": ".custom {}",
                "IS_PRODUCT": 1,
                "USE_REMARK": "一键换肤样式",
            },
        ]
        conn = FakeConnection([systems, scripts])

        with tempfile.TemporaryDirectory() as tmp:
            summary = exporter.export_system_scripts(conn, Path(tmp), ["0015"])
            root = Path(tmp, "风险管理", "scripts")
            current = (root / "20-系统私有JAVASCRIPT/source.js").read_text(encoding="utf-8")
            inherited = (root / "30-系统私有CSS脚本/source.css").read_text(encoding="utf-8")
            custom = (root / "10000-系统私有CSS脚本-一键换肤样式/source.css").read_text(encoding="utf-8")
            meta = json.loads((root / "30-系统私有CSS脚本/meta.json").read_text(encoding="utf-8"))

        self.assertEqual("const current = true;", current)
        self.assertEqual(".root { color: red; }\n", inherited)
        self.assertEqual(".custom {}", custom)
        self.assertEqual("PRODUCT", meta["sourceOrigin"])
        self.assertEqual(3, summary["exported_system_script_count"])
        self.assertIn("DATA_SOURCE_ID IN (%s)", conn.calls[0][0])
        self.assertIn("SYSTEM_ID IN (%s)", conn.calls[1][0])

    def test_filters_selected_system_and_script_type(self):
        systems = [
            {
                "SYSTEM_ID": "SYS-1",
                "SYSTEM_NAME": "风险管理",
                "SYSTEM_ALIAS_ID": "gdrm",
                "DATA_SOURCE_ID": "0015",
            }
        ]
        scripts = [{"SCRIPT_TYPE": 11, "SYSTEM_ID": "SYS-1", "SCRIPT": "", "PROD_SCRIPT": "", "IS_PRODUCT": None}]
        conn = FakeConnection([systems, scripts])

        with tempfile.TemporaryDirectory() as tmp:
            exporter.export_system_scripts(conn, Path(tmp), ["0015"], ["SYS-1"], [11])
            source = Path(tmp, "风险管理/scripts/11-用户登录初始化脚本/source.js")
            self.assertTrue(source.exists())

        self.assertEqual(("0015", "SYS-1"), conn.calls[0][1])
        self.assertEqual(("SYS-1", 11), conn.calls[1][1])

    def test_selected_script_creates_workcopy_with_baseline(self):
        systems = [{"SYSTEM_ID": "SYS-1", "SYSTEM_NAME": "风险管理", "DATA_SOURCE_ID": "0015"}]
        scripts = [
            {
                "SCRIPT_TYPE": 20000,
                "SYSTEM_ID": "SYS-1",
                "SCRIPT": "const preview = true;",
                "PROD_SCRIPT": "",
                "IS_PRODUCT": 0,
                "USE_REMARK": "图片预览",
            }
        ]
        conn = FakeConnection([systems, scripts])

        with tempfile.TemporaryDirectory() as tmp:
            readonly = Path(tmp, "readonly")
            workcopy = Path(tmp, "workcopy")
            summary = exporter.export_system_scripts(
                conn,
                readonly,
                ["0015"],
                ["SYS-1"],
                [20000],
                workcopy,
                {"sync": {"rules": {}}},
            )
            target = workcopy / "风险管理/scripts/20000-系统私有JAVASCRIPT-图片预览"
            self.assertEqual("const preview = true;", (target / "source.js").read_text(encoding="utf-8"))
            self.assertTrue((target / ".guthon-baseline/source.js").exists())
            self.assertTrue((target / "source-meta.json").exists())
            self.assertTrue((target / "diff.md").exists())
            self.assertEqual("CREATED", summary["work_copy_actions"][0])

    def test_rejects_empty_data_source_scope(self):
        with self.assertRaisesRegex(ValueError, "data_source_ids is required"):
            exporter.export_system_scripts(FakeConnection([]), data_source_ids=[])

    def test_auto_git_add_stages_readonly_script(self):
        systems = [{"SYSTEM_ID": "SYS-1", "SYSTEM_NAME": "风险管理", "DATA_SOURCE_ID": "0015"}]
        scripts = [{"SCRIPT_TYPE": 20, "SYSTEM_ID": "SYS-1", "SCRIPT": "const ready = true;"}]
        conn = FakeConnection([systems, scripts])
        config = {"sync": {"rules": {"pull_auto_add_git": True}}}

        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            subprocess.run(["git", "init", "-q", str(repo)], check=True)
            summary = exporter.export_system_scripts(conn, repo / "readonly", ["0015"], config=config)
            staged = subprocess.run(
                ["git", "-C", str(repo), "-c", "core.quotePath=false", "diff", "--cached", "--name-only"],
                capture_output=True,
                text=True,
                check=True,
            ).stdout.splitlines()

        self.assertEqual(2, summary["git_added"])
        self.assertEqual(
            [
                "readonly/风险管理/scripts/20-系统私有JAVASCRIPT/meta.json",
                "readonly/风险管理/scripts/20-系统私有JAVASCRIPT/source.js",
            ],
            staged,
        )


if __name__ == "__main__":
    unittest.main()
