"""DATABASE PAGE creation through the public Source Helper contract."""

from contextlib import closing
import hashlib
import json
from pathlib import Path
import shutil
from unittest.mock import patch

from common import legacy_source
from providers.source_helper import SourceHelperMcpServer
from test_provider_regressions import WorkspaceCase


class DatabaseWorkcopyReceiptTest(WorkspaceCase):
    def setUp(self):
        super().setUp()
        self.workspace = self.register("database")
        self.key = self.workspace["workspaceKey"]
        with closing(legacy_source.connect_index_for_workspace(self.workspace)) as conn, conn:
            for page in ("PG-ONE", "PG-TWO"):
                source = {"pageId": page, "compScript": "#return(1)"}
                if page == "PG-TWO":
                    source["buttons"] = [
                        {"id": name, "pageEvents": {"onClickScript": text}}
                        for name, text in (("a", "first();\nold();\nlast();"), ("b", "other();"))
                    ]
                    source["views"] = {"rows": [{"cols": [{"component": {"type": "input-box",
                        "name": "mainForm", "fields": [
                            {"fieldId": "A", "id": "form-a", "type": "text", "width": 100,
                             "pageEvents": {"onChangeScript": "old();"}},
                            {"fieldId": "B", "id": "form-b", "type": "text", "label": "Old label"},
                        ]}}]}]}
                row = {"source_table": "page", "source_id": page, "source_alias_id": page, "fun_id": "",
                       "source_name": page, "source_content": json.dumps(source),
                       "system_id": "SYS-FIXTURE"}
                legacy_source.upsert_source(conn, row, "PRODUCT", self.workspace["scopeId"],
                                            self.workspace["projectId"], {}, {}, workspace=self.workspace)
        self.server = self.initialize()
        catalog = self.call(self.server, "list_sources", {"workspaceKey": self.key, "sourceType": "page"})["data"]
        self.pages = {item["sourceId"]: {key: item[key] for key in ("recordId", "sourceId", "sourcePath")}
                      for item in catalog["items"]}

    def initialize(self, *, enable_writes=True):
        server = SourceHelperMcpServer(self.home, "fixture", enable_writes=enable_writes)
        server.handle({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}})
        server.handle({"jsonrpc": "2.0", "method": "notifications/initialized"})
        return server

    def call(self, server, tool, args):
        response = server.handle({"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                                  "params": {"name": f"database_{tool}", "arguments": args}})
        return response["result"]["structuredContent"]

    def request(self, page):
        identity = {"workspaceKey": self.key, **self.pages[page]}
        initial = self.call(self.server, "read_workcopy", identity)["data"]
        self.assertFalse(initial["workcopy"])
        return {**identity, "baselineSourceHash": initial["sourceHash"]}

    def test_create_receipts_bind_exact_files_and_retry_preserves_user_content(self):
        for page in self.pages:
            request = self.request(page)
            result = self.call(self.server, "create_workcopy", request)["data"]
            readonly = (self.workspace["readonlyDir"] / request["sourcePath"]).parent
            target = Path(result["workcopyPath"]).parent
            self.assertEqual(("CREATED", "CLEAN", True), (result["action"], result["state"], result["matchesAfter"]))
            self.assertEqual({target / name for name in ("raw.json", "meta.json", "source-meta.json")},
                             {Path(item["path"]) for item in result["writeArtifacts"]})
            for item in result["writeArtifacts"]:
                path = Path(item["path"])
                self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), item["sourceHash"])
                if path.name != "source-meta.json":
                    self.assertEqual((readonly / path.name).read_bytes(), path.read_bytes())
            script = next((target / "scripts").iterdir())
            script.write_bytes(b"#return(2)")
            snapshot = {file: file.read_bytes() for file in target.rglob("*") if file.is_file()}
            retry = self.call(self.server, "create_workcopy", request)["data"]
            self.assertEqual(("EXISTS", []), (retry["action"], retry["writeArtifacts"]))
            self.assertEqual(snapshot, {file: file.read_bytes() for file in target.rglob("*") if file.is_file()})
        readonly_server = self.initialize(enable_writes=False)
        self.assertNotIn("database_create_workcopy", readonly_server.routes)
        self.assertIn("database_read_workcopy", readonly_server.routes)

    def test_creation_rejects_mismatches_and_never_publishes_partial_copy(self):
        request = self.request("PG-ONE")
        source = self.workspace["readonlyDir"] / request["sourcePath"]
        target = self.workspace["workcopyDir"] / request["sourcePath"]
        for changed in ({"sourceId": "PG-TWO"}, {"sourcePath": self.pages["PG-TWO"]["sourcePath"]},
                        {"baselineSourceHash": "0" * 64}, {"workspaceKey": "missing-workspace"}):
            self.assertFalse(self.call(self.server, "create_workcopy", {**request, **changed})["ok"])
            self.assertFalse(target.parent.exists())

        with patch.object(legacy_source, "_write_work_copy_metadata", side_effect=OSError("fixture write failed")):
            self.assertFalse(self.call(self.server, "create_workcopy", request)["ok"])
        self.assertFalse(target.parent.exists())
        self.assertFalse(list(target.parent.parent.glob(".workcopy-create-*")))

        write_metadata = legacy_source._write_work_copy_metadata

        def refresh_during_copy(*args):
            write_metadata(*args)
            source.write_bytes(source.read_bytes() + b"\n")

        with patch.object(legacy_source, "_write_work_copy_metadata", side_effect=refresh_during_copy):
            self.assertFalse(self.call(self.server, "create_workcopy", request)["ok"])
        self.assertFalse(target.parent.exists())

        source.write_bytes(source.read_bytes().rstrip(b"\n"))
        target.parent.symlink_to(source.parent, target_is_directory=True)
        self.assertFalse(self.call(self.server, "create_workcopy", request)["ok"])
        self.assertEqual(["meta.json", "raw.json", "scripts"], sorted(p.name for p in source.parent.iterdir()))

    def test_create_then_save_page_json_without_physical_projections(self):
        request = self.request("PG-ONE")
        readonly = self.workspace["readonlyDir"] / request["sourcePath"]
        original = readonly.read_bytes()
        shutil.rmtree(readonly.parent / "scripts")
        created = self.call(self.server, "create_workcopy", request)["data"]
        revision = {field: request[field] for field in ("workspaceKey", "recordId", "sourceId", "sourcePath")}
        draft = {**revision, "pointer": "/compScript", "sourceHash": request["baselineSourceHash"],
                 "content": "#return(3)"}
        preview = self.call(self.server, "preview_workcopy", draft)["data"]
        save = self.call(self.server, "save_workcopy", {**draft, "candidateSourceHash": preview["candidateSourceHash"]})["data"]
        target = Path(created["workcopyPath"])
        self.assertEqual("#return(3)", json.loads(target.read_bytes())["compScript"])
        self.assertEqual((True, preview["candidateSourceHash"], []),
                         (save["matchesAfter"], save["sourceHash"], save["writeArtifacts"]))
        self.assertEqual(original, readonly.read_bytes())
        self.assertFalse((target.parent / "scripts").exists())

    def test_cli_create_keeps_its_contract_and_cannot_gain_a_receipt_on_retry(self):
        request = self.request("PG-ONE")
        result = self.tool("create-workcopy", key=self.key, args=["--type", "page", "--source-id", "PG-ONE", "--json"])
        self.assertEqual((self.key, "CREATED", "CLEAN"), (result["workspaceKey"], result["action"], result["state"]))
        self.assertNotIn("writeArtifacts", result)
        metadata = Path(result["path"]) / "source-meta.json"
        before = metadata.read_bytes()
        retry = self.call(self.server, "create_workcopy", request)["data"]
        self.assertEqual(("EXISTS", []), (retry["action"], retry["writeArtifacts"]))
        self.assertEqual(before, metadata.read_bytes())

    def test_local_changes_follow_saved_page_fragments_across_array_reorder(self):
        request = self.request("PG-TWO")
        self.call(self.server, "create_workcopy", request)
        identity = self.pages["PG-TWO"]
        tree_args = ["fragments", "--record-id", str(identity["recordId"]), "--source-id", identity["sourceId"]]
        self.assertEqual([], self.tool("legacy-source", key=self.key, args=["local-changes"])["items"])
        self.assertEqual([], self.tool("legacy-source", key=self.key, args=tree_args)["modifiedPointers"])

        draft = {**identity, "sourceHash": request["baselineSourceHash"]}
        baseline = self.workspace["readonlyDir"] / identity["sourcePath"]
        readonly = json.loads(baseline.read_bytes())
        current = json.loads(baseline.read_bytes())
        current["buttons"].reverse()
        current["buttons"][1]["pageEvents"]["onClickScript"] = "first();\nchanged();\nlast();"
        saved = self.tool("legacy-source", key=self.key, args=["edit-save"], payload={**draft, "content": json.dumps(current)})
        self.assertEqual([{"sourceType": "page", "sourcePath": identity["sourcePath"]}],
                         self.tool("legacy-source", key=self.key, args=["local-changes"])["items"])
        changed = "/buttons/1/pageEvents/onClickScript"
        unchanged = "/buttons/0/pageEvents/onClickScript"
        fragments = self.tool("legacy-source", key=self.key, args=tree_args)["modifiedPointers"]
        self.assertIn(changed, fragments)
        self.assertNotIn(unchanged, fragments)
        for pointer, expected in ((changed, [{"kind": "replace", "start": 1, "end": 2}]), (unchanged, [])):
            result = self.tool("legacy-source", key=self.key, args=["edit-read"],
                               payload={**identity, "pointer": pointer, "includeLineChanges": True})
            self.assertEqual(expected, result["lineChanges"])

        self.tool("legacy-source", key=self.key, args=["edit-save"],
                  payload={**draft, "sourceHash": saved["sourceHash"], "content": json.dumps(readonly)})
        self.assertEqual([], self.tool("legacy-source", key=self.key, args=["local-changes"])["items"])

    def test_local_changes_mark_saved_procedure_without_git(self):
        row = {"source_table": "procedure", "source_id": "PROC-ONE", "source_alias_id": "demo.proc", "fun_id": "run",
               "source_name": "run", "system_id": "SYS-FIXTURE", "source_content": "first\nremoved\nlast"}
        with closing(legacy_source.connect_index_for_workspace(self.workspace)) as conn, conn:
            legacy_source.upsert_source(conn, row, "PRODUCT", self.workspace["scopeId"],
                                        self.workspace["projectId"], {}, {}, workspace=self.workspace)
        record, = self.tool("legacy-source", key=self.key, args=["catalog", "--type", "procedure"])["items"]
        identity = {field: record[field] for field in ("recordId", "sourceId", "sourcePath")}
        initial = self.tool("legacy-source", key=self.key, args=["edit-read"], payload=identity)
        self.tool("legacy-source", key=self.key, args=["edit-save"],
                  payload={**identity, "sourceHash": initial["sourceHash"], "content": "first\nlast\nadded"})
        self.assertEqual([{"sourceType": "procedure", "sourcePath": identity["sourcePath"]}],
                         self.tool("legacy-source", key=self.key, args=["local-changes"])["items"])
        result = self.tool("legacy-source", key=self.key, args=["edit-read"],
                           payload={**identity, "includeLineChanges": True})
        self.assertEqual([{"kind": "delete", "start": 1, "end": 1}, {"kind": "insert", "start": 2, "end": 3}],
                         result["lineChanges"])

    def test_copy_field_batch_from_saved_comparison_requires_both_current_revisions(self):
        identity = self.pages["PG-TWO"]
        source = self.workspace["readonlyDir"] / identity["sourcePath"]
        original = source.read_bytes()
        current = json.loads(original)
        component = current["views"]["rows"][0]["cols"][0]["component"]
        field, other = component["fields"]
        field.update(width=120, pageEvents={"onChangeScript": "changed();"})
        other["label"] = "New label"
        component["fields"].append({"fieldId": "C", "id": "form-c", "type": "text"})
        component["fields"].reverse()
        current["buttons"][0]["pageEvents"]["onClickScript"] = "unrelated();"
        read = self.tool("legacy-source", key=self.key, args=["edit-read"], payload=identity)
        saved = self.tool("legacy-source", key=self.key, args=["edit-save"],
                          payload={**identity, "sourceHash": read["sourceHash"], "content": json.dumps(current)})
        review = {**identity, "design": True, "sourceHash": saved["sourceHash"]}
        comparison = self.tool("legacy-source", key=self.key, args=["edit-comparison"], payload=review)
        summary, = comparison["fieldBatches"]
        self.assertEqual(("mainForm", 2, 1), (summary["label"], summary["updated"], summary["added"]))
        copy = {**review, "fieldBatchPointer": summary["pointer"], "baseRevision": comparison["fieldBaseHash"]}
        result = self.tool("legacy-source", key=self.key, args=["edit-comparison"], payload=copy)
        batch = json.loads(result["clipboard"])
        self.assertEqual(("PG-TWO", "input-box"), (batch["pageId"], batch["componentType"]))
        self.assertEqual("C", batch["additions"][0]["field"]["fieldId"])
        self.assertEqual({"A": {("width",): (100, 120), ("pageEvents", "onChangeScript"): ("old();", "changed();")},
                          "B": {("label",): ("Old label", "New label")}}, {
            update["identity"]["fieldId"]: {tuple(item["path"]): (item["before"], item["after"])
                                           for item in update["changes"]}
            for update in batch["updates"]
        })
        self.assertNotIn("unrelated", result["clipboard"])
        with self.assertRaisesRegex(ValueError, "PAGE 已变化"):
            self.tool("legacy-source", key=self.key, args=["edit-comparison"],
                      payload={**copy, "sourceHash": read["sourceHash"]})
        source.write_bytes(original + b"\n")
        with self.assertRaisesRegex(ValueError, "只读基线已变化"):
            self.tool("legacy-source", key=self.key, args=["edit-comparison"], payload=copy)
