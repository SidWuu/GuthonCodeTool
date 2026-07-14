#!/usr/bin/env python3
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import gusen_hub
from gusen_hub import (
    WORK_COPY_BASELINE_DIR,
    _initialize_work_copy,
    _prepare_work_copy,
    _resolve_inherited_script,
    parse_page_scripts,
    proc_sql,
)


ROW = {
    "source_layer": "PRODUCT",
    "product_id": "demo",
    "project_id": "",
    "source_table": "procedure",
    "source_id": "PR-DEMO",
    "source_alias_id": "demo.proc",
    "fun_id": "save",
    "source_name": "保存",
    "change_key": "VERSION:1",
}


class WorkCopyTest(unittest.TestCase):
    def make_paths(self):
        temp = tempfile.TemporaryDirectory()
        root = Path(temp.name)
        source = root / "readonly"
        target = root / "workcopy"
        source.mkdir()
        (source / "source.vm").write_text("old\n", encoding="utf-8")
        (source / "raw.json").write_text('{"page":{"name":"old"}}\n', encoding="utf-8")
        return temp, source, target

    def test_local_and_upstream_changes_refuse_overwrite(self):
        temp, source, target = self.make_paths()
        self.addCleanup(temp.cleanup)
        _initialize_work_copy(source, target, ROW, "VERSION:1", "mirror")
        (target / "source.vm").write_text("local\n", encoding="utf-8")
        (source / "source.vm").write_text("upstream\n", encoding="utf-8")

        with self.assertRaises(SystemExit):
            _prepare_work_copy(source, target, {**ROW, "change_key": "VERSION:2"}, "VERSION:2")

        self.assertEqual((target / "source.vm").read_text(encoding="utf-8"), "local\n")
        self.assertIn("`CONFLICT`", (target / "diff.md").read_text(encoding="utf-8"))

    def test_clean_work_copy_updates_source_and_baseline(self):
        temp, source, target = self.make_paths()
        self.addCleanup(temp.cleanup)
        _initialize_work_copy(source, target, ROW, "VERSION:1", "mirror")
        (source / "source.vm").write_text("upstream\n", encoding="utf-8")

        status = _prepare_work_copy(source, target, {**ROW, "change_key": "VERSION:2"}, "VERSION:2")

        self.assertEqual(status["action"], "UPDATED")
        self.assertEqual(status["state"], "CLEAN")
        self.assertEqual((target / "source.vm").read_text(encoding="utf-8"), "upstream\n")
        self.assertEqual((target / WORK_COPY_BASELINE_DIR / "source.vm").read_text(encoding="utf-8"), "upstream\n")

    def test_local_json_change_generates_path_diff(self):
        temp, source, target = self.make_paths()
        self.addCleanup(temp.cleanup)
        _initialize_work_copy(source, target, ROW, "VERSION:1", "mirror")
        (target / "diff.md").write_text("# 修改说明\n\n保留这条人工说明\n\n# Diff\n", encoding="utf-8")
        (target / "raw.json").write_text('{"page":{"name":"new"}}\n', encoding="utf-8")

        status = _prepare_work_copy(source, target, ROW, "VERSION:1")

        self.assertEqual(status["action"], "PRESERVED")
        diff = (target / "diff.md").read_text(encoding="utf-8")
        self.assertIn("保留这条人工说明", diff)
        self.assertIn("M $.page.name", diff)
        metadata = json.loads((target / "source-meta.json").read_text(encoding="utf-8"))
        self.assertEqual(metadata["_workcopy"]["baselineChangeKey"], "VERSION:1")

    def test_changed_baseline_is_rejected(self):
        temp, source, target = self.make_paths()
        self.addCleanup(temp.cleanup)
        _initialize_work_copy(source, target, ROW, "VERSION:1", "mirror")
        (target / WORK_COPY_BASELINE_DIR / "source.vm").write_text("tampered\n", encoding="utf-8")

        with self.assertRaises(SystemExit):
            _prepare_work_copy(source, target, ROW, "VERSION:1")

    def test_inherited_page_backend_script_uses_super_script(self):
        with tempfile.TemporaryDirectory() as temp:
            raw = json.dumps(
                {
                    "dataSource": {
                        "name": "queryData",
                        "script": "before\n@inherit();  \nafter",
                        "superScript": "product\\path\nreturn true;\n",
                    }
                }
            )
            scripts = parse_page_scripts(Path(temp), raw)

            self.assertEqual(len(scripts), 1)
            self.assertEqual(scripts[0][0], "script")
            self.assertEqual(scripts[0][2], "before\nproduct\\path\nreturn true;\nafter")
            self.assertEqual(scripts[0][1].suffix, ".vm")

    def test_procedure_inherit_marker_uses_product_script(self):
        self.assertEqual(
            _resolve_inherited_script("@inherit();\n", "product\\script\n"),
            "product\\script\n",
        )
        self.assertEqual(_resolve_inherited_script("// @inherit();\n", "product\n"), "// @inherit();\n")

    def test_procedure_sql_reads_configured_product_script(self):
        table_config = gusen_hub.load_yaml(gusen_hub.ROOT / "config/example/source-tables.example.yaml")

        self.assertIn("s.PRODUCT_FUNCTION_SCRIPT_FIELD AS product_source_content", proc_sql(table_config))

    def test_project_work_copy_uses_project_readonly_snapshot(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            old_root, old_var = gusen_hub.ROOT, gusen_hub.VAR_DIR
            gusen_hub.ROOT, gusen_hub.VAR_DIR = root, root / "var"
            self.addCleanup(setattr, gusen_hub, "ROOT", old_root)
            self.addCleanup(setattr, gusen_hub, "VAR_DIR", old_var)
            product_path = root / "var/source/readonly/products/系统/procedure/demo.proc/save"
            project_path = root / "var/source/readonly/project/项目A/系统/procedure/demo.proc/save"
            product_path.mkdir(parents=True)
            project_path.mkdir(parents=True)
            (product_path / "source.vm").write_text("new product\n", encoding="utf-8")
            (project_path / "source.vm").write_text("project snapshot\n", encoding="utf-8")
            conn = gusen_hub.connect_index(root / "hub.db")
            insert = """
                INSERT INTO gusen_source_record(
                    source_layer, product_id, project_id, source_table, source_id, source_alias_id,
                    fun_id, source_name, change_key, local_path, status, indexed_time
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
            """
            conn.execute(insert, ("PRODUCT", "product-a", "", "procedure", "PRODUCT-ID", "demo.proc", "save", "产品", "VERSION:product", str(product_path.relative_to(root)), "OK", "now"))
            conn.execute(insert, ("PROJECT", "product-a", "project-a", "procedure", "PROJECT-ID", "demo.proc", "save", "项目", "VERSION:project", str(project_path.relative_to(root)), "OK", "now"))
            cfg = {"projects": {"projects": {"project-a": {"name": "项目A", "product_id": "product-a"}}}}

            row, owner = gusen_hub.find_work_copy_source(conn, cfg, None, "project-a", "procedure", "demo.proc", "save")

            self.assertEqual(row["source_id"], "PROJECT-ID")
            self.assertEqual(owner, Path("项目A"))
            self.assertEqual((root / row["local_path"] / "source.vm").read_text(encoding="utf-8"), "project snapshot\n")


if __name__ == "__main__":
    unittest.main()
