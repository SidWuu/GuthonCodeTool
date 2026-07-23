import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import export_view_sql as exporter  # noqa: E402


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


class ExportViewSqlTest(unittest.TestCase):
    def test_exports_selected_view_source(self):
        views = [
            {
                "DATA_SOURCE_ID": "0015",
                "VIEW_ID": "V_RM_TEST",
                "VIEW_SQL": "SELECT *\nFROM RM_TEST",
            }
        ]
        systems = [{"DATA_SOURCE_ID": "0015", "SYSTEM_NAME": "风险管理"}]
        conn = FakeConnection([views, systems])

        with tempfile.TemporaryDirectory() as tmp:
            summary = exporter.export_views(
                conn,
                Path(tmp),
                data_source_ids=["0015"],
                view_ids=["V_RM_TEST"],
            )
            source = Path(tmp, "0015_风险管理", "V_RM_TEST.sql").read_text(encoding="utf-8")

        self.assertEqual("SELECT *\nFROM RM_TEST\n", source)
        self.assertEqual(1, summary["exported_view_count"])
        self.assertIn("VIEW_ID IN (%s)", conn.calls[0][0])
        self.assertEqual(("0015", "V_RM_TEST"), conn.calls[0][1])

    def test_rejects_missing_selected_view(self):
        conn = FakeConnection([[], []])
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(ValueError, "missing_view_ids=V_MISSING"):
                exporter.export_views(conn, Path(tmp), ["0015"], ["V_MISSING"])

    def test_auto_git_add_stages_only_exported_view(self):
        views = [{"DATA_SOURCE_ID": "0015", "VIEW_ID": "V_TEST", "VIEW_SQL": "SELECT 1"}]
        systems = [{"DATA_SOURCE_ID": "0015", "SYSTEM_NAME": "风险管理"}]
        conn = FakeConnection([views, systems])
        config = {"sync": {"rules": {"pull_auto_add_git": True}}}

        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            subprocess.run(["git", "init", "-q", str(repo)], check=True)
            (repo / "unrelated.sql").write_text("SELECT 2\n", encoding="utf-8")
            summary = exporter.export_views(conn, repo / "views", ["0015"], ["V_TEST"], config)
            staged = subprocess.run(
                ["git", "-C", str(repo), "-c", "core.quotePath=false", "diff", "--cached", "--name-only"],
                capture_output=True,
                text=True,
                check=True,
            ).stdout.splitlines()

        self.assertEqual(1, summary["git_added"])
        self.assertEqual(["views/0015_风险管理/V_TEST.sql"], staged)


if __name__ == "__main__":
    unittest.main()
