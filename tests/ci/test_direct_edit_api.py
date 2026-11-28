"""API direct-edit contract against registered checkout files and the real index."""

from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import unittest

from providers.api import direct_edit, documents, editor_state, index
from providers.api.client import ApiError
from providers.api.download import SourceFile
from providers.api.store import ApiStore
from test_provider_regressions import WorkspaceCase


class ApiDirectEditTest(WorkspaceCase):
    def setUp(self):
        super().setUp()
        self.workspace = self.register("api")
        self.tool("api", key=self.workspace["workspaceKey"], args=["configure"], payload={
            "serverUrl": "https://fixture.invalid/guthon/",
            "systemIds": ["S1"], "dataSourceIds": ["D1"], "allSystems": False,
        })
        self.store = ApiStore(self.workspace)
        self.procedure = "datasources/D1/procedures/audit/hello.gss"
        self.script = "systems/S1/system-script/1.js"
        self.css = "systems/S1/pages/main/CSS/style.css"
        self.service = "systems/S1/pages/main/SERVICE/service.gss"
        self.other_scripts = [f"systems/S1/pages/main/{suffix}/script.{suffix}" for suffix in ("vm", "java", "sql")]
        self.page = "systems/S1/pages/main/STRUCT/page.js"
        self.inherited = "datasources/D1/procedures/audit/hello.inherit.gss"
        self.store.publish([
            SourceFile(self.procedure, "#return('original')\n", "procedure", {
                "dataSourceId": "D1", "procedureId": "P1", "funId": "hello",
            }),
            SourceFile(self.script, "function original() {}\n", "system-script", {
                "systemId": "S1", "scriptType": "1",
            }),
            SourceFile(self.css, "body { color: red; }\n", "page", {
                "systemId": "S1", "pageId": "CSS", "pageType": "0",
            }),
            SourceFile(self.service, "#return('service')\n", "page", {
                "systemId": "S1", "pageId": "SERVICE", "pageType": "0",
            }),
            SourceFile(self.page, '{"pageId":"STRUCT"}', "page", {
                "systemId": "S1", "pageId": "STRUCT", "pageType": "1",
            }),
            SourceFile(self.inherited, "#return('parent')\n", "procedure-inherit", {
                "dataSourceId": "D1", "procedureId": "P1", "funId": "hello",
            }, True),
        ] + [
            SourceFile(path, "original\n", "page", {
                "systemId": "S1", "pageId": Path(path).parent.name, "pageType": "0",
            }) for path in self.other_scripts
        ])
        index.rebuild(self.workspace)

    def path(self, relative):
        return self.store.root / relative

    def test_real_disk_edits_refresh_index_and_baseline_diff(self):
        for relative in (self.procedure, self.script, self.css, self.service, *self.other_scripts):
            with self.subTest(path=relative):
                path = self.path(relative)
                self.assertFalse(direct_edit.inspect_file(self.workspace, path, refresh=False)["modified"])
                content = "\ufeff// direct-edit-unique-{} 中文\r\n".format(path.suffix[1:]).encode("utf-8")
                path.write_bytes(content)
                expected = hashlib.sha256(content).hexdigest()
                result = direct_edit.inspect_file(self.workspace, path, refresh=True)
                self.assertEqual(result, {"sourceHash": expected, "modified": True, "indexedHash": expected})
                self.assertEqual(content, path.read_bytes())
                self.assertEqual(expected, self.store.diff(relative)["sourceHash"])
                with closing(index._connection(self.workspace)) as conn:
                    row = conn.execute("SELECT source_hash FROM gusen_source_record WHERE source_path=?", (relative,)).fetchone()
                    self.assertEqual(expected, row[0])
                self.assertIn(relative, [hit["path"] for hit in index.search(self.workspace, "direct-edit-unique")["hits"]])
                self.assertEqual(result, direct_edit.inspect_file(self.workspace, path, refresh=True))
                path.write_text(self.store.baseline(relative), encoding="utf-8")
                reverted = direct_edit.inspect_file(self.workspace, path, refresh=True)
                self.assertFalse(reverted["modified"])
                self.assertEqual(reverted["sourceHash"], reverted["indexedHash"])

    def test_rejects_unregistered_structured_readonly_scope_and_encoding(self):
        unknown = self.path("systems/S1/pages/main/new.js")
        unknown.write_text("unregistered", encoding="utf-8")
        for path, code in ((unknown, "API_SOURCE_NOT_FOUND"), (self.path(self.page), "API_DIRECT_EDIT_UNSUPPORTED"),
                           (self.path(self.inherited), "API_SOURCE_READONLY")):
            with self.subTest(path=path), self.assertRaises(ApiError) as error:
                direct_edit.inspect_file(self.workspace, path, refresh=False)
            self.assertEqual(code, error.exception.code)
        path = self.path(self.procedure)
        path.write_bytes(b"\xff\xfe")
        with self.assertRaises(ApiError) as error:
            direct_edit.inspect_file(self.workspace, path, refresh=False)
        self.assertEqual("API_SOURCE_ENCODING", error.exception.code)
        path.write_text(self.store.baseline(self.procedure), encoding="utf-8")
        self.tool("api", key=self.workspace["workspaceKey"], args=["configure"], payload={
            "serverUrl": "https://fixture.invalid/guthon/", "systemIds": ["S1"],
            "dataSourceIds": [], "allSystems": False,
        })
        with self.assertRaises(ApiError) as error:
            direct_edit.inspect_file(self.workspace, path, refresh=False)
        self.assertEqual("API_SOURCE_OUT_OF_SCOPE", error.exception.code)

    def test_blocks_dirty_editor_active_lease_conflict_and_deleted(self):
        path = self.path(self.script)
        token = editor_state.update(self.workspace, {"pid": os.getpid(), "documents": [
            {"path": self.script, "dirty": True},
        ]})["editorToken"]
        with self.assertRaises(ApiError) as error:
            direct_edit.inspect_file(self.workspace, path, refresh=False)
        self.assertEqual("API_EDITOR_DIRTY", error.exception.code)
        editor_state.update(self.workspace, {"editorToken": token, "close": True})
        lease = documents.open_document(self.workspace, self.script)
        with self.assertRaises(ApiError) as error:
            direct_edit.inspect_file(self.workspace, path, refresh=False)
        self.assertEqual("API_DOCUMENT_LEASE_BUSY", error.exception.code)
        documents.close_document(self.workspace, lease["leaseId"])
        conflict = self.store._conflict_path(self.script)
        conflict.parent.mkdir(parents=True, exist_ok=True)
        conflict.write_text("{}", encoding="utf-8")
        with self.assertRaises(ApiError) as error:
            direct_edit.inspect_file(self.workspace, path, refresh=False)
        self.assertEqual("API_MERGE_CONFLICT", error.exception.code)
        conflict.unlink()
        with sqlite3.connect(self.store.path) as conn:
            meta = json.loads(conn.execute("SELECT metadata FROM source WHERE path=?", (self.script,)).fetchone()[0])
            meta["remoteDeleted"] = True
            conn.execute("UPDATE source SET metadata=? WHERE path=?", (json.dumps(meta), self.script))
        with self.assertRaises(ApiError) as error:
            direct_edit.inspect_file(self.workspace, path, refresh=False)
        self.assertEqual("API_REMOTE_DELETED", error.exception.code)

    def test_rejects_disabled_capability_and_mismatched_project_identity(self):
        path = self.path(self.script)
        disabled = {**self.workspace, "capabilities": {**self.workspace["capabilities"], "api.edit": False}}
        with self.assertRaises(ApiError) as error:
            direct_edit.inspect_file(disabled, path, refresh=False)
        self.assertEqual("API_CAPABILITY_REQUIRED", error.exception.code)
        identity = self.store.directory / "identity.json"
        identity.write_text(json.dumps({"workspaceKey": "different", "serverUrl": "https://fixture.invalid/guthon/"}))
        with self.assertRaises(ApiError) as error:
            direct_edit.inspect_file(self.workspace, path, refresh=False)
        self.assertEqual("API_PROJECT_IDENTITY_MISMATCH", error.exception.code)

    def test_inventory_detects_registered_changes_missing_and_unregistered_additions(self):
        self.assertEqual({}, direct_edit.changed_files(self.workspace))
        script = self.path(self.script)
        script.write_text("changed", encoding="utf-8")
        procedure = self.path(self.procedure)
        procedure.unlink()
        unknown = self.path("systems/S1/pages/main/unregistered.xml")
        unknown.write_text("<page/>", encoding="utf-8")
        changes = direct_edit.changed_files(self.workspace)
        self.assertEqual({str(script), str(procedure), str(unknown)}, set(changes))
        self.assertTrue(changes[str(script)].startswith("MODIFIED:"))
        self.assertTrue(changes[str(procedure)].startswith("MISSING:"))
        self.assertTrue(changes[str(unknown)].startswith("UNREGISTERED:"))
        self.assertEqual(changes, direct_edit.changed_files(self.workspace))
        conflict = self.store._conflict_path(self.script)
        conflict.parent.mkdir(parents=True, exist_ok=True)
        conflict.write_text("{}", encoding="utf-8")
        self.assertTrue(direct_edit.changed_files(self.workspace)[str(script)].startswith("CONFLICT:"))
        renamed = unknown.with_name("renamed.xml")
        unknown.rename(renamed)
        new_changes = direct_edit.changed_files(self.workspace)
        self.assertNotIn(str(unknown), new_changes)
        self.assertIn(str(renamed), new_changes)


if __name__ == "__main__":
    unittest.main()
