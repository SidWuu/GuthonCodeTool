#!/usr/bin/env python3
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

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

    def test_saved_local_changes_refresh_changed_upstream_version(self):
        temp, source, target = self.make_paths()
        self.addCleanup(temp.cleanup)
        _initialize_work_copy(source, target, ROW, "VERSION:1", "mirror")
        (target / "source.vm").write_text("saved\n", encoding="utf-8")
        (source / "source.vm").write_text("saved\n", encoding="utf-8")
        (source / "raw.json").write_text('{"versionMac":"VERSION:2"}\n', encoding="utf-8")

        status = _prepare_work_copy(source, target, {**ROW, "change_key": "VERSION:2"}, "VERSION:2")

        self.assertEqual(status["action"], "UPDATED")
        self.assertEqual(status["state"], "CLEAN")
        self.assertEqual((target / WORK_COPY_BASELINE_DIR / "source.vm").read_text(encoding="utf-8"), "saved\n")

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

    def test_create_work_copy_uses_source_mirror_path(self):
        conn = MagicMock()
        cfg = {"sync": {"ACTIVE": "demo"}}
        result = {"path": "/tmp/workcopy/风险管理/procedure/demo.proc/save"}
        create_mock = MagicMock(return_value=result)
        with patch.multiple(
            gusen_hub,
            load_config=MagicMock(return_value=cfg),
            resolve_pull_scope=MagicMock(return_value=("PRODUCT", "demo", "", {})),
            active_index_path=MagicMock(return_value=Path(":memory:")),
            connect_index=MagicMock(return_value=conn),
            find_work_copy_source=MagicMock(return_value=(ROW, Path("期现产品"))),
            create_work_copy_from_row=create_mock,
        ), patch("builtins.print") as print_mock:
            gusen_hub.create_work_copy(
                ["--product", "demo", "--type", "procedure", "--alias", "demo.proc", "--fun", "save"]
            )

        create_mock.assert_called_once_with(conn, cfg, ROW, "demo", "")
        print_mock.assert_called_once_with(result["path"])

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

    def test_missing_inherited_page_event_does_not_generate_script(self):
        with tempfile.TemporaryDirectory() as temp:
            raw = json.dumps(
                {
                    "button": {
                        "aliasName": "saveBtn",
                        "serviceEvents": {
                            "beforeSaveScript": "@inherit();\n",
                            "afterSaveScript": "@inherit();\n",
                        },
                        "superServiceEvents": {"afterSaveScript": "productAfterSave();\n"},
                        "pageEvents": {
                            "onClickScript": "inherit();\n",
                            "formaterScript": "return inherit();\n",
                        },
                        "superPageEvents": {"formaterScript": "return productValue;\n"},
                    }
                }
            )

            scripts = parse_page_scripts(Path(temp), raw)

            self.assertEqual(
                [(key, value) for key, _path, value in scripts],
                [("afterSaveScript", "productAfterSave();\n"), ("formaterScript", "return productValue;\n")],
            )

    def test_page_script_extension_uses_event_layer_without_breaking_inheritance(self):
        with tempfile.TemporaryDirectory() as temp:
            raw = json.dumps(
                {
                    "button": {
                        "serviceEvents": {"beforeQueryScript": "@inherit();\n"},
                        "superServiceEvents": {"beforeQueryScript": "$vs.log.info('product');\n"},
                        "pageEvents": {"afterSaveScript": "self.refresh();\n"},
                    }
                }
            )

            scripts = parse_page_scripts(Path(temp), raw)

            self.assertEqual(
                [(key, path.suffix, value) for key, path, value in scripts],
                [
                    ("beforeQueryScript", ".vm", "$vs.log.info('product');\n"),
                    ("afterSaveScript", ".js", "self.refresh();\n"),
                ],
            )

    def test_procedure_inherit_marker_uses_product_script(self):
        self.assertEqual(
            _resolve_inherited_script("@inherit();\n", "product\\script\n"),
            "product\\script\n",
        )
        self.assertEqual(_resolve_inherited_script("@inherit();\n", ""), "\n")
        self.assertEqual(_resolve_inherited_script("// @inherit();\n", "product\n"), "// @inherit();\n")

    def test_procedure_sql_reads_configured_product_script(self):
        table_config = gusen_hub.load_yaml(gusen_hub.ROOT / "config/example/source-tables.example.yaml")

        self.assertIn("s.PRODUCT_FUNCTION_SCRIPT_FIELD AS product_source_content", proc_sql(table_config))

    def test_manual_page_pull_fetches_every_page_in_module(self):
        current = {"source_table": "page", "source_id": "PG-001", "source_alias_id": "demo.main", "fun_id": "", "source_name": "主页面", "mk_id": "MK-001", "model_id": "MD-001"}
        sibling = {**current, "source_id": "PG-002", "source_alias_id": "demo.edit", "source_name": "编辑页面"}
        cursor = MagicMock()
        cursor.fetchone.return_value = current
        cursor.fetchall.return_value = [current, sibling]
        remote = MagicMock()
        remote.cursor.return_value.__enter__.return_value = cursor
        remote_context = MagicMock()
        remote_context.__enter__.return_value = remote
        work_result = {"path": "/tmp/module/page", "state": "CLEAN", "action": "UPDATED", "localChanged": False}
        cfg = {"sync": {"rules": {}}, "source_tables": {}, "datasource": {"datasource": {"demo": {}}}}

        with patch.multiple(
            gusen_hub,
            load_config=MagicMock(return_value=cfg),
            resolve_pull_scope=MagicMock(return_value=("PRODUCT", "demo-product", "", {"datasource": "demo", "include": {"all": True}})),
            active_index_path=MagicMock(return_value=Path(":memory:")),
            connect_index=MagicMock(return_value=MagicMock()),
            single_source_sql=MagicMock(return_value=("single", ["PG-001"])),
            module_page_sql=MagicMock(return_value=("module", ["MK-001"])),
            db_connect=MagicMock(return_value=remote_context),
            resolve_system_scope=MagicMock(return_value={}),
            load_model_paths=MagicMock(return_value={"MD-001": []}),
            upsert_source=MagicMock(return_value=True),
            create_work_copy_from_row=MagicMock(return_value=work_result),
        ):
            result = gusen_hub.pull_source_to_work_copy({"sourceType": "page", "sourceId": "PG-001"})

        self.assertEqual(2, result["pulled"])
        self.assertEqual(["single", "module"], [call.args[0] for call in cursor.execute.call_args_list])

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
