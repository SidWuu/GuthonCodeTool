from pathlib import Path
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import gusen_hub  # noqa: E402


class PageModulePathTest(unittest.TestCase):
    def test_export_product_docs_writes_source_and_invoke_indexes(self):
        conn = gusen_hub.connect_index(Path(":memory:"))
        conn.execute(
            """
            INSERT INTO gusen_source_record(
                source_layer, product_id, project_id, source_table, source_id, source_alias_id, fun_id,
                source_name, change_key, local_path, status, indexed_time
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
                "PRODUCT",
                "demo-product",
                "",
                "procedure",
                "PROC-001",
                "demo.proc",
                "save",
                "保存",
                "ck",
                "var/readonly-source/products/示例子系统/procedure/demo.proc/save",
                "OK",
                "2026-07-04 09:00:00",
            ),
        )
        conn.execute(
            """
            INSERT INTO gusen_invoke_call(
                source_layer, product_id, project_id, source_table, source_id, source_alias_id, fun_id,
                source_name, script_type, json_path, line_no, target_alias_id, target_fun_id,
                invoke_expr, invoke_type, confidence, update_time, indexed_time
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
                "PRODUCT",
                "demo-product",
                "",
                "procedure",
                "PROC-001",
                "demo.proc",
                "save",
                "保存",
                "procedure_script",
                "var/a.vm",
                1,
                "demo.target",
                "run",
                "$vs.proc.invoke('demo.target','run',{})",
                "proc_invoke",
                "HIGH",
                "",
                "2026-07-04 09:00:00",
            ),
        )

        with tempfile.TemporaryDirectory() as tmp:
            old_var_dir = gusen_hub.VAR_DIR
            gusen_hub.VAR_DIR = Path(tmp)
            try:
                gusen_hub.export_product_docs(conn, "demo-product")
                out = Path(tmp) / "knowledge/products/demo-product"
                self.assertTrue((out / "source-index.md").exists())
                self.assertTrue((out / "invoke-index.md").exists())
                self.assertIn("demo.proc", (out / "source-index.md").read_text(encoding="utf-8"))
            finally:
                gusen_hub.VAR_DIR = old_var_dir

    def test_product_work_copy_source_reads_product_record(self):
        conn = gusen_hub.connect_index(Path(":memory:"))
        conn.execute(
            """
            INSERT INTO gusen_source_record(
                source_layer, product_id, project_id, source_table, source_id, source_alias_id, fun_id,
                source_name, change_key, local_path, status, indexed_time
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
                "PRODUCT",
                "demo-product",
                "",
                "procedure",
                "PROC-001",
                "demo.proc",
                "save",
                "保存",
                "ck",
                "var/readonly-source/products/示例子系统/procedure/demo.proc/save",
                "OK",
                "2026-07-04 09:00:00",
            ),
        )
        cfg = {"products": {"products": {"demo-product": {"name": "示例产品"}}}}

        row, owner = gusen_hub.find_work_copy_source(
            conn,
            cfg,
            product_id="demo-product",
            project_id=None,
            source_type="procedure",
            alias="demo.proc",
            fun="save",
        )

        self.assertEqual("var/readonly-source/products/示例子系统/procedure/demo.proc/save", row["local_path"])
        self.assertEqual(Path("products/示例产品"), owner)

    def test_page_comp_script_is_extracted_as_vm(self):
        raw = '{"name":"deleteService","compScript":"#set($ok = true)"}'
        with tempfile.TemporaryDirectory() as tmp:
            scripts = gusen_hub.parse_page_scripts(Path(tmp), raw)

        self.assertEqual(1, len(scripts))
        self.assertEqual("compScript", scripts[0][0])
        self.assertEqual("deleteService.compScript.vm", scripts[0][1].name)

    def test_duplicate_data_source_uses_first_configured_system_name(self):
        old_config_dir = gusen_hub.CONFIG_DIR
        with tempfile.TemporaryDirectory() as tmp:
            gusen_hub.CONFIG_DIR = Path(tmp)
            (Path(tmp) / "system-data.json").write_text(
                """
                [
                  {"SYSTEM_CODE": "demo_a", "SYSTEM_ID": "S1", "SYSTEM_NAME": "示例子系统A", "DATA_SOURCE_IDS": ["DS_SHARED"]},
                  {"SYSTEM_CODE": "demo_b", "SYSTEM_ID": "S2", "SYSTEM_NAME": "示例子系统B", "DATA_SOURCE_IDS": ["DS_SHARED"]}
                ]
                """,
                encoding="utf-8",
            )
            try:
                scope = gusen_hub.load_system_scope(
                    {"systems": {"data_file": "system-data.json", "include": {"system_codes": ["demo_a", "demo_b"]}}}
                )
            finally:
                gusen_hub.CONFIG_DIR = old_config_dir

        self.assertEqual("示例子系统A", scope["system_name_by_data_source_id"]["DS_SHARED"])
        self.assertEqual(["示例子系统B"], scope["system_link_names_by_data_source_id"]["DS_SHARED"])

    def test_duplicate_data_source_procedure_creates_link(self):
        row = {
            "source_table": "procedure",
            "source_id": "PROC-001",
            "source_alias_id": "demo.shared",
            "fun_id": "save",
            "source_name": "保存",
            "source_content": "#set($a = 1)",
            "data_source_id": "DS_SHARED",
        }

        with tempfile.TemporaryDirectory() as tmp:
            old_var_dir = gusen_hub.VAR_DIR
            gusen_hub.VAR_DIR = Path(tmp)
            try:
                local_path, _status, _scripts = gusen_hub.write_source(
                    row,
                    "PRODUCT",
                    "product-a",
                    "",
                    {},
                    {
                        "system_name_by_data_source_id": {"DS_SHARED": "示例子系统A"},
                        "system_link_names_by_data_source_id": {"DS_SHARED": ["示例子系统B"]},
                    },
                    "CHECK_IN:2026-07-03",
                )
                link = Path(tmp) / "readonly-source/products/示例子系统B/procedure"
                self.assertEqual(
                    Path("readonly-source/products/示例子系统A/procedure/demo.shared/save"),
                    local_path.relative_to(Path(tmp)),
                )
                self.assertTrue(link.is_symlink())
                self.assertEqual(Path("../示例子系统A/procedure"), Path(link.readlink()))
            finally:
                gusen_hub.VAR_DIR = old_var_dir

    def test_active_product_selects_only_that_product(self):
        cfg = {
            "sync": {"sync": {"ACTIVE": "products.demo-product"}},
            "products": {"products": {"demo-product": {"name": "示例产品"}}},
            "projects": {"projects": {"demo-project": {"name": "示例项目"}}},
        }

        self.assertEqual(
            ("products.demo-product", [("demo-product", {"name": "示例产品"})], [], []),
            gusen_hub.resolve_active(cfg),
        )

    def test_active_project_selects_only_that_project(self):
        cfg = {
            "sync": {"sync": {"active": "projects.demo-project"}},
            "products": {"products": {"demo-product": {"name": "示例产品"}}},
            "projects": {"projects": {"demo-project": {"name": "示例项目"}}},
        }

        self.assertEqual(
            ("projects.demo-project", [], [("demo-project", {"name": "示例项目"})], ["demo-project"]),
            gusen_hub.resolve_active(cfg),
        )

    def test_active_requires_existing_config_entry(self):
        cfg = {
            "sync": {"sync": {"ACTIVE": "projects.missing"}},
            "products": {"products": {}},
            "projects": {"projects": {}},
        }

        with self.assertRaises(SystemExit):
            gusen_hub.resolve_active(cfg)

    def test_page_sql_loads_module_name_from_config(self):
        sql = gusen_hub.page_sql(
            {
                "source_tables": {
                    "page": {
                        "source_table_name": "PAGE_TABLE",
                        "id_field": "ID_COL",
                        "alias_field": "ALIAS_COL",
                        "name_field": "NAME_COL",
                        "content_field": "CONTENT_COL",
                        "update_time_field": "UPDATED_COL",
                        "check_in_date_field": "CHECK_IN_COL",
                        "error_field": "ERROR_COL",
                        "system_id_field": "SYSTEM_COL",
                        "module_table_name": "MODULE_TABLE",
                        "module_join_field": "MODULE_COL",
                        "module_name_field": "MODULE_NAME_COL",
                    }
                }
            }
        )

        self.assertIn("FROM PAGE_TABLE p", sql)
        self.assertIn("LEFT JOIN MODULE_TABLE m", sql)
        self.assertIn("m.MODULE_NAME_COL AS mk_name", sql)

    def test_page_source_path_includes_module_name(self):
        row = {
            "source_table": "page",
            "source_id": "P001",
            "source_alias_id": "demo.page",
            "source_name": "示例页面",
            "source_content": "",
            "system_id": "RM",
            "mk_id": "M001",
            "mk_name": "示例模块",
        }

        with tempfile.TemporaryDirectory() as tmp:
            old_var_dir = gusen_hub.VAR_DIR
            gusen_hub.VAR_DIR = Path(tmp)
            try:
                local_path, _status, _scripts = gusen_hub.write_source(
                    row,
                    "PRODUCT",
                    "product-a",
                    "",
                    {},
                    {"system_name_by_id": {"RM": "示例子系统"}},
                    "CHECK_IN:2026-07-03",
                )
            finally:
                gusen_hub.VAR_DIR = old_var_dir

        self.assertEqual(
            Path("readonly-source/products/示例子系统/page/示例模块/示例页面 P001"),
            local_path.relative_to(Path(tmp)),
        )

    def test_page_without_alias_uses_source_id_for_index(self):
        conn = gusen_hub.connect_index(Path(":memory:"))
        row = {
            "source_table": "page",
            "source_id": "PG-001",
            "source_alias_id": None,
            "fun_id": "",
            "source_name": "主页面",
            "source_content": "",
            "system_id": "RM",
            "mk_id": "M001",
            "mk_name": "示例模块",
        }

        with tempfile.TemporaryDirectory() as tmp:
            old_root = gusen_hub.ROOT
            old_var_dir = gusen_hub.VAR_DIR
            gusen_hub.ROOT = Path(tmp)
            gusen_hub.VAR_DIR = Path(tmp) / "var"
            try:
                changed = gusen_hub.upsert_source(
                    conn,
                    row,
                    "PRODUCT",
                    "product-a",
                    "",
                    {},
                    {"system_name_by_id": {"RM": "示例子系统"}},
                )
            finally:
                gusen_hub.ROOT = old_root
                gusen_hub.VAR_DIR = old_var_dir

        indexed = conn.execute("SELECT source_alias_id FROM gusen_source_record").fetchone()
        self.assertTrue(changed)
        self.assertEqual("PG-001", indexed["source_alias_id"])


if __name__ == "__main__":
    unittest.main()
