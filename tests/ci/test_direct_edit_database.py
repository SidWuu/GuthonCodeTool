"""DATABASE direct-edit registration, provenance and local search."""

from contextlib import closing
import hashlib
import json
import shutil
import sqlite3
from unittest.mock import patch

from common import database_source_exports, legacy_source, legacy_source_read
from common.database_source_publish import reviewable_workcopies
from providers.database.direct_edit import inspect_file
from providers.database import export_system_script_sql as system_export
from test_provider_regressions import WorkspaceCase


class DatabaseDirectEditTest(WorkspaceCase):
    def setUp(self):
        super().setUp()
        self.workspace = self.register("database")
        self.row = {"source_table": "procedure", "source_id": "P1", "fun_id": "run",
                    "source_alias_id": "fixture.test", "source_name": "run",
                    "source_content": "#return('baseline')", "version_mac": "v1",
                    "system_id": "S1", "data_source_id": "D1"}
        self.sync()

    def sync(self):
        with closing(legacy_source.connect_index_for_workspace(self.workspace)) as conn, conn:
            legacy_source.upsert_source(conn, self.row, self.workspace["layer"], self.workspace["scopeId"],
                                        self.workspace["projectId"], {}, {}, force=True, workspace=self.workspace)
        item, = legacy_source_read.catalog(self.workspace, source_type="procedure")["items"]
        self.item = item
        self.mirror = self.workspace["readonlyDir"] / item["sourcePath"]
        self.copy = self.workspace["workcopyDir"] / item["sourcePath"]
        self.copy.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(self.mirror, self.copy)

    def assert_refresh_idempotent(self, path):
        first = inspect_file(self.workspace, path, refresh=True)
        index = self.workspace["indexPath"]
        before = index.read_bytes()
        modified_time = index.stat().st_mtime_ns
        second = inspect_file(self.workspace, path, refresh=True)
        self.assertEqual(first, second)
        self.assertEqual(before, index.read_bytes())
        self.assertEqual(modified_time, index.stat().st_mtime_ns)

    def test_refresh_keeps_mirror_and_publishes_only_current_workcopy_search(self):
        mirror = self.mirror.read_bytes()
        with closing(legacy_source.connect_index_for_workspace(self.workspace)) as conn:
            facts = [tuple(row) for row in conn.execute("SELECT * FROM gusen_source_record")]
            bodies = [tuple(row) for row in conn.execute("SELECT * FROM source_body_content")]
        clean = inspect_file(self.workspace, self.copy, refresh=True)
        self.assertEqual(hashlib.sha256(mirror).hexdigest(), clean["indexedHash"])
        self.assertFalse(clean["modified"])
        self.copy.write_bytes(b"#return('local-search-marker')\n")
        candidates = reviewable_workcopies(self.workspace, include_unindexed=True)
        result = inspect_file(self.workspace, self.copy, refresh=False)
        self.assertTrue(result["modified"])
        self.assertEqual([], legacy_source_read.search(self.workspace, "local-search-marker")["items"])
        refreshed = inspect_file(self.workspace, self.copy, refresh=True)
        self.assert_refresh_idempotent(self.copy)
        self.assertEqual(candidates, reviewable_workcopies(self.workspace, include_unindexed=True))
        self.assertEqual(refreshed["sourceHash"], refreshed["indexedHash"])
        hit, = legacy_source_read.search(self.workspace, "local-search-marker")["items"]
        self.assertEqual("workcopy", hit["sourceLayer"])
        self.assertEqual(self.item["recordId"], hit["recordId"])
        identity = {key: self.item[key] for key in ("recordId", "sourceId", "sourcePath")}
        read = self.tool("legacy-source", key=self.workspace["workspaceKey"], args=["edit-read"], payload=identity)
        self.assertIn("local-search-marker", read["content"])
        self.assertEqual(mirror, self.mirror.read_bytes())
        with closing(legacy_source.connect_index_for_workspace(self.workspace)) as conn:
            self.assertEqual(facts, [tuple(row) for row in conn.execute("SELECT * FROM gusen_source_record")])
            self.assertEqual(bodies, [tuple(row) for row in conn.execute("SELECT * FROM source_body_content")])
        self.copy.write_text("newer contents", encoding="utf-8")
        self.assertEqual([], legacy_source_read.search(self.workspace, "local-search-marker")["items"])

    def test_rejects_unregistered_structured_and_unsafe_inheritance(self):
        arbitrary = self.copy.with_name("unregistered.vm")
        arbitrary.write_text("hello", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "可写源码"):
            inspect_file(self.workspace, arbitrary, refresh=False)
        other = self.workspace["workcopyDir"] / "other" / "source.vm"
        other.parent.mkdir(parents=True)
        other.write_text("hello", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "基线"):
            inspect_file(self.workspace, other, refresh=False)
        page = self.copy.parent / "scripts" / "compScript.vm"
        page.parent.mkdir()
        page.write_text("hello", encoding="utf-8")
        with self.assertRaises(ValueError):
            inspect_file(self.workspace, page, refresh=False)
        with self.assertRaises(ValueError):
            inspect_file(self.workspace, self.mirror, refresh=False)
        self.copy.write_text("inherit();", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "继承"):
            inspect_file(self.workspace, self.copy, refresh=True)

    def test_repeat_refresh_does_not_append_wal_frames(self):
        index = self.workspace["indexPath"]
        with closing(sqlite3.connect(index)) as anchor:
            self.assertEqual("wal", anchor.execute("PRAGMA journal_mode=WAL").fetchone()[0])
            self.copy.write_text("#return('wal')", encoding="utf-8")
            inspect_file(self.workspace, self.copy, refresh=True)
            wal = index.with_name(index.name + "-wal")
            before = (index.read_bytes(), wal.read_bytes(), wal.stat().st_mtime_ns)
            inspect_file(self.workspace, self.copy, refresh=True)
            self.assertEqual(before, (index.read_bytes(), wal.read_bytes(), wal.stat().st_mtime_ns))

    def test_refresh_rejects_and_rolls_back_incorrect_index_readback(self):
        original = inspect_file(self.workspace, self.copy, refresh=True)["indexedHash"]
        with closing(sqlite3.connect(self.workspace["indexPath"])) as conn, conn:
            conn.execute("""CREATE TRIGGER corrupt_direct_body AFTER UPDATE ON database_direct_edit_body
                BEGIN UPDATE database_direct_edit_body SET source_hash='incorrect' WHERE relative_path=NEW.relative_path; END""")
        self.copy.write_text("#return('modified')", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "索引回读"):
            inspect_file(self.workspace, self.copy, refresh=True)
        with closing(sqlite3.connect(self.workspace["indexPath"])) as conn:
            self.assertEqual(original, conn.execute("SELECT source_hash FROM database_direct_edit_body").fetchone()[0])

    def test_resolved_inheritance_and_old_mirrors_are_not_mistaken_for_plain_source(self):
        self.row.update(source_content="inherit();", product_source_content="#return('parent')", version_mac="v2")
        self.sync()
        self.assertNotIn("inherit", self.mirror.read_text(encoding="utf-8"))
        with self.assertRaisesRegex(ValueError, "继承"):
            inspect_file(self.workspace, self.copy, refresh=False)
        self.row.update(source_content="#return('plain')", version_mac="v3")
        self.sync()
        meta = self.mirror.parent / "meta.json"
        data = json.loads(meta.read_text(encoding="utf-8"))
        data.pop("source_inheritance")
        data.pop("source_content_hash")
        meta.write_text(json.dumps(data), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "继承来源"):
            inspect_file(self.workspace, self.copy, refresh=False)
        data["source_content"] = "#return('plain')"
        meta.write_text(json.dumps(data), encoding="utf-8")
        self.assertFalse(inspect_file(self.workspace, self.copy, refresh=False)["modified"])

    def test_page_projections_use_registered_pointer_and_reject_inherited_or_changed_structure(self):
        page = {"pageId": "PG-1", "compScript": "#return(1)",
                "sql": "select 1", "pageEvents": {"onClickScript": "click();"},
                "pageSetup": {"pageEvents": {"onOpenScript": "inherit();"},
                              "superPageEvents": {"onOpenScript": "parent();"}}}
        row = {"source_table": "page", "source_id": "PG-1", "source_alias_id": "PG-1",
               "fun_id": "", "source_name": "Page", "source_content": json.dumps(page),
               "system_id": "S1"}
        with closing(legacy_source.connect_index_for_workspace(self.workspace)) as conn, conn:
            legacy_source.upsert_source(conn, row, self.workspace["layer"], self.workspace["scopeId"],
                                        self.workspace["projectId"], {}, {}, workspace=self.workspace)
        item, = legacy_source_read.catalog(self.workspace, source_type="page")["items"]
        mirror = self.workspace["readonlyDir"] / item["sourcePath"]
        copy = self.workspace["workcopyDir"] / item["sourcePath"]
        shutil.copytree(mirror.parent, copy.parent)
        fragments = list((copy.parent / "scripts").iterdir())
        self.assertGreaterEqual(len(fragments), 4)
        with closing(legacy_source.connect_index_for_workspace(self.workspace)) as conn:
            record = conn.execute("SELECT source_table, local_path FROM gusen_source_record WHERE record_id=?",
                                  (item["recordId"],)).fetchone()
            pointers = {row["json_pointer"] for row in conn.execute(
                "SELECT json_pointer FROM gusen_source_fragment WHERE source_record_id=?", (item["recordId"],))}
            self.assertEqual("page", record["source_table"])
            self.assertEqual(mirror.parent, (legacy_source.ROOT / record["local_path"]).resolve())
            self.assertIn("/compScript", pointers)
            self.assertIn("/pageSetup/pageEvents/onOpenScript", pointers)
        plain = next(fragment for fragment in fragments if fragment.name == "compScript.vm")
        clean = inspect_file(self.workspace, plain, refresh=True)
        self.assertFalse(clean["modified"])
        self.assertEqual(clean["sourceHash"], clean["indexedHash"])
        self.assertEqual("#return(1)", legacy_source_read.read(
            self.workspace, item["recordId"], pointer="/compScript")["content"])
        plain.write_text("#return('projection-only')", encoding="utf-8")
        candidates = reviewable_workcopies(self.workspace, include_unindexed=True)
        updated = inspect_file(self.workspace, plain, refresh=True)
        self.assert_refresh_idempotent(plain)
        self.assertTrue(updated["modified"])
        self.assertEqual(candidates, reviewable_workcopies(self.workspace, include_unindexed=True))
        hit, = legacy_source_read.search(self.workspace, "projection-only")["items"]
        self.assertEqual(("workcopy", "/compScript", plain.relative_to(self.workspace["workcopyDir"]).as_posix()),
                         (hit["sourceLayer"], hit["pointer"], hit["workcopyPath"]))
        for name in ("sql.sql", "onClickScript.js"):
            fragment = next(fragment for fragment in fragments if fragment.name == name)
            self.assertFalse(inspect_file(self.workspace, fragment, refresh=True)["modified"])
            fragment.write_text("projection-marker-" + name, encoding="utf-8")
            inspect_file(self.workspace, fragment, refresh=True)
            found, = legacy_source_read.search(self.workspace, "projection-marker-" + name)["items"]
            self.assertEqual(fragment.relative_to(self.workspace["workcopyDir"]).as_posix(), found["workcopyPath"])
        inherited = next(fragment for fragment in fragments if fragment.name == "onOpenScript.js")
        with self.assertRaisesRegex(ValueError, "继承"):
            inspect_file(self.workspace, inherited, refresh=True)
        changed = dict(page, compScript="#return('changed raw')")
        copy.write_text(json.dumps(changed), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "身份或结构"):
            inspect_file(self.workspace, plain, refresh=True)
        self.assertEqual([], legacy_source_read.search(self.workspace, "projection-only")["items"])
        copy.write_bytes(mirror.read_bytes())
        self.assertEqual(mirror.read_bytes(), copy.read_bytes())

    def test_page_projection_filename_collision_is_rejected(self):
        page = {"pageId": "PG-C", "buttons": [
            {"id": "one", "name": "same", "pageEvents": {"onClickScript": "one();"}},
            {"id": "two", "name": "same", "pageEvents": {"onClickScript": "two();"}},
        ]}
        row = {"source_table": "page", "source_id": "PG-C", "source_alias_id": "PG-C",
               "fun_id": "", "source_name": "Page", "source_content": json.dumps(page), "system_id": "S1"}
        with closing(legacy_source.connect_index_for_workspace(self.workspace)) as conn, conn:
            legacy_source.upsert_source(conn, row, self.workspace["layer"], self.workspace["scopeId"],
                                        self.workspace["projectId"], {}, {}, workspace=self.workspace)
        item, = legacy_source_read.catalog(self.workspace, source_type="page")["items"]
        mirror = self.workspace["readonlyDir"] / item["sourcePath"]
        copy = self.workspace["workcopyDir"] / item["sourcePath"]
        shutil.copytree(mirror.parent, copy.parent)
        fragment, = (copy.parent / "scripts").iterdir()
        with self.assertRaisesRegex(ValueError, "多个片段"):
            inspect_file(self.workspace, fragment, refresh=True)

    def test_page_projection_rejects_changed_native_node_identity(self):
        page = {"pageId": "PG-I", "buttons": [
            {"id": "one", "name": "action", "pageEvents": {"onClickScript": "one();"}},
        ]}
        row = {"source_table": "page", "source_id": "PG-I", "source_alias_id": "PG-I",
               "fun_id": "", "source_name": "Page", "source_content": json.dumps(page), "system_id": "S1"}
        with closing(legacy_source.connect_index_for_workspace(self.workspace)) as conn, conn:
            legacy_source.upsert_source(conn, row, self.workspace["layer"], self.workspace["scopeId"],
                                        self.workspace["projectId"], {}, {}, workspace=self.workspace)
        item, = legacy_source_read.catalog(self.workspace, source_type="page")["items"]
        mirror = self.workspace["readonlyDir"] / item["sourcePath"]
        copy = self.workspace["workcopyDir"] / item["sourcePath"]
        shutil.copytree(mirror.parent, copy.parent)
        fragment, = (copy.parent / "scripts").iterdir()
        inspect_file(self.workspace, fragment, refresh=True)
        page["buttons"][0]["id"] = "replacement"
        copy.write_text(json.dumps(page), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "身份或结构"):
            inspect_file(self.workspace, fragment, refresh=True)

    def test_registered_system_css_workcopy_is_searchable_and_product_source_rejected(self):
        relative = "System/scripts/30-style"
        source_dir = self.workspace["readonlyDir"] / relative
        target_dir = self.workspace["workcopyDir"] / relative
        source_dir.mkdir(parents=True)
        source = source_dir / "source.css"
        source.write_text("body { color: red; }", encoding="utf-8")
        meta = {"systemId": "S1", "scriptType": 30, "sourceFile": "source.css",
                "scriptTypeName": "CSS", "sourceOrigin": "CURRENT", "status": "OK", "changeKey": "v1"}
        (source_dir / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
        row = {**meta, "workspaceKey": self.workspace["workspaceKey"], "source_table": "system-script",
               "source_id": "S1", "source_alias_id": "S1", "fun_id": "30", "change_key": "v1"}
        legacy_source._prepare_work_copy(source_dir, target_dir, row, "v1")
        with closing(legacy_source.connect_index_for_workspace(self.workspace)) as conn, conn:
            self.assertEqual([], database_source_exports.rebuild(conn, self.workspace, source_type="system-script"))
        copy = target_dir / "source.css"
        self.assertFalse(inspect_file(self.workspace, copy, refresh=True)["modified"])
        copy.write_text("body { color: cssworkcopy; }", encoding="utf-8")
        result = inspect_file(self.workspace, copy, refresh=True)
        self.assert_refresh_idempotent(copy)
        self.assertTrue(result["modified"])
        hit, = legacy_source_read.search(self.workspace, "cssworkcopy", source_type="system-script")["items"]
        self.assertEqual(("workcopy", "system-script", copy.relative_to(self.workspace["workcopyDir"]).as_posix()),
                         (hit["sourceLayer"], hit["sourceType"], hit["workcopyPath"]))
        with closing(sqlite3.connect(self.workspace["indexPath"])) as conn, conn:
            conn.execute("""CREATE TRIGGER corrupt_direct_export AFTER UPDATE ON database_direct_edit_export_body
                BEGIN UPDATE database_direct_edit_export_body SET source_hash='incorrect' WHERE relative_path=NEW.relative_path; END""")
        copy.write_text("body { color: changed; }", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "索引回读"):
            inspect_file(self.workspace, copy, refresh=True)
        with closing(sqlite3.connect(self.workspace["indexPath"])) as conn:
            self.assertEqual(result["sourceHash"], conn.execute(
                "SELECT source_hash FROM database_direct_edit_export_body").fetchone()[0])
        meta["sourceOrigin"] = "PRODUCT"
        (source_dir / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "继承"):
            inspect_file(self.workspace, copy, refresh=True)
        self.assertEqual([], legacy_source_read.search(self.workspace, "cssworkcopy")["items"])

    def test_real_system_js_exports_distinguish_standalone_and_mixed_sources(self):
        system = {"system_id": "S1", "system_name": "System", "data_source_id": "D1"}
        scripts = [
            {"script_type": 20, "system_id": "S1", "source": "const standalone = 1;", "product_source": ""},
            {"script_type": 20001, "system_id": "S1", "source": "const current = 1;",
             "product_source": "const product = 1;"},
        ]
        config = {"sync": {"rules": {}}}
        with (patch.object(system_export, "system_script_mapping", return_value={"source_table_name": "scripts"}),
              patch.object(system_export, "fetch_systems", return_value=[system]),
              patch.object(system_export, "fetch_scripts", side_effect=lambda _conn, _mapping, _ids, types, _db:
                           [row for row in scripts if row["script_type"] in types]),
              patch.object(system_export.gusen_hub, "resolve_workspace", return_value=self.workspace)):
            for row in scripts:
                result = system_export.export_system_scripts(
                    None, self.workspace["readonlyDir"], ["D1"], ["S1"], [row["script_type"]],
                    self.workspace["workcopyDir"], config)
                self.assertEqual(["CREATED"], result["work_copy_actions"])
        with closing(legacy_source.connect_index_for_workspace(self.workspace)) as conn, conn:
            self.assertEqual([], database_source_exports.rebuild(conn, self.workspace, source_type="system-script"))
        directories = list((self.workspace["readonlyDir"] / "System" / "scripts").iterdir())
        plain_dir = next(directory for directory in directories if directory.name.startswith("20-"))
        mixed_dir = next(directory for directory in directories if directory.name.startswith("20001-"))
        plain_meta_file = plain_dir / "meta.json"
        plain_meta = json.loads(plain_meta_file.read_text(encoding="utf-8"))
        mixed_meta = json.loads((mixed_dir / "meta.json").read_text(encoding="utf-8"))
        self.assertEqual(("CURRENT", "CURRENT"), (plain_meta["sourceOrigin"], plain_meta["sourceComposition"]))
        self.assertEqual(("CURRENT", "MIXED"), (mixed_meta["sourceOrigin"], mixed_meta["sourceComposition"]))
        plain = self.workspace["workcopyDir"] / plain_dir.relative_to(self.workspace["readonlyDir"]) / "source.js"
        mixed = self.workspace["workcopyDir"] / mixed_dir.relative_to(self.workspace["readonlyDir"]) / "source.js"
        self.assertEqual("const standalone = 1;", plain.read_text(encoding="utf-8"))
        self.assertEqual("const product = 1;\nconst current = 1;", mixed.read_text(encoding="utf-8"))
        self.assertFalse(inspect_file(self.workspace, plain, refresh=True)["modified"])
        plain.write_text("const directExportMarker = 2;", encoding="utf-8")
        self.assertTrue(inspect_file(self.workspace, plain, refresh=True)["modified"])
        self.assert_refresh_idempotent(plain)
        hit, = legacy_source_read.search(self.workspace, "directExportMarker", source_type="system-script")["items"]
        self.assertEqual(plain.relative_to(self.workspace["workcopyDir"]).as_posix(), hit["workcopyPath"])
        with self.assertRaisesRegex(ValueError, "多层来源"):
            inspect_file(self.workspace, mixed, refresh=True)
        original_hash = plain_meta["sourceContentHash"]
        plain_meta["sourceContentHash"] = "0" * 64
        plain_meta_file.write_text(json.dumps(plain_meta), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "缺少可核验"):
            inspect_file(self.workspace, plain, refresh=True)
        plain_meta["sourceContentHash"] = original_hash
        plain_meta.pop("sourceComposition")
        plain_meta.pop("sourceContentHash")
        plain_meta_file.write_text(json.dumps(plain_meta), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "缺少可核验"):
            inspect_file(self.workspace, plain, refresh=True)
