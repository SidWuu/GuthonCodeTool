"""Offline regressions through the production workspace and source entry points."""

from contextlib import closing, nullcontext, redirect_stderr, redirect_stdout
from io import StringIO
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import guthon_tool
from common import database_source_exports, gusen_hub, legacy_source
from common.database_exports._export_common import bill_type_output_dir, legacy_bill_type_dir
from common.database_exports import export_bill_type_sql as exporter
from common.runtime_paths import runtime_home_context
from providers.api.client import ApiError
from providers.api.download import SourceFile
from providers.api.store import ApiStore
from providers.svn.nexus.scm import diff


class WorkspaceCase(unittest.TestCase):
    def setUp(self):
        self.home = Path(self.enterContext(tempfile.TemporaryDirectory(prefix="guthon-ci-"))).resolve()
        self.enterContext(runtime_home_context(self.home))
        self.tool("setup", args=["--no-team-sync"])

    def tool(self, command, *, key=None, args=(), payload=None, json_output=True):
        argv = [command, "--home", str(self.home)]
        if key:
            argv.extend(["--workspace", key])
        if args:
            argv.extend(["--", *args])
        if command == "api" and payload is not None:
            argv.append("--stdin")
        stdout, stderr = StringIO(), StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr), patch.object(sys, "stdin", StringIO(json.dumps(payload))):
            result = guthon_tool.main(argv)
        self.assertEqual(result, 0, stderr.getvalue())
        return json.loads(stdout.getvalue()) if json_output else stdout.getvalue()

    def register(self, mode):
        key = "fixture-" + mode
        self.tool("workspace-create", payload={"id": key, "name": "验收 " + mode, "sourceMode": mode})
        return gusen_hub.resolve_workspace(gusen_hub.load_config(), key)


class ApiWorkspaceTest(WorkspaceCase):
    def test_three_modes_keep_distinct_roots_and_explicit_routing(self):
        workspaces = [self.register(mode) for mode in ("api", "svn", "database")]
        listing = self.tool("workspaces")["workspaces"]
        self.assertEqual({w["workspaceKey"]: w["sourceMode"] for w in workspaces},
                         {w["workspaceKey"]: w["sourceMode"] for w in listing})
        self.assertEqual(len({w["indexPath"] for w in workspaces}), 3)
        self.assertEqual(len({w["providerSourceRoot"] for w in workspaces}), 3)
        with self.assertRaisesRegex(SystemExit, "API_SOURCE_MODE_REQUIRED"):
            self.tool("api", key="fixture-database", args=["status"])

    def test_sync_baseline_index_search_local_edit_and_revert(self):
        workspace = self.register("api")
        key = workspace["workspaceKey"]
        self.tool("api", key=key, args=["configure"], payload={"serverUrl": "https://fixture.invalid/guthon/",
            "systemIds": ["S1"], "dataSourceIds": ["D1"], "allSystems": False})
        path = "datasources/D1/procedures/audit/hello.gss"
        base = "#return('audit-original')\n"
        ApiStore(workspace).publish([SourceFile(path, base, "procedure", {
            "dataSourceId": "D1", "procedureId": "P1", "procedureAliasId": "audit", "funId": "hello",
        })])
        self.tool("api", key=key, args=["index"])
        hits = self.tool("api", key=key, args=["search"], payload={"query": "audit-original"})["hits"]
        self.assertEqual([path], [hit["path"] for hit in hits])
        original = self.tool("api", key=key, args=["read"], payload={"path": path})
        self.assertEqual(base, original["content"])
        edited = base.replace("original", "updated")
        receipt = self.tool("api", key=key, args=["write"], payload={
            "path": path, "content": edited, "expectedHash": original["sourceHash"],
        })
        self.assertEqual(edited, receipt["content"])
        with self.assertRaisesRegex(ApiError, "源码已变化"):
            self.tool("api", key=key, args=["write"], payload={
                "path": path, "content": base, "expectedHash": original["sourceHash"],
            })
        self.assertEqual(edited, (workspace["providerSourceRoot"] / path).read_text(encoding="utf-8"))
        restored = self.tool("api", key=key, args=["revert"], payload={"path": path, "expectedHash": receipt["sourceHash"]})
        self.assertEqual(base, restored["content"])


class SvnWorkspaceTest(WorkspaceCase):
    def test_local_and_remote_page_diffs_keep_working_copy_intact(self):
        workspace = self.register("svn")
        repository = self.home / "repository"
        seed = self.home / "seed"
        checkout = workspace["checkoutPath"]
        relative = Path("systems/SYS/pages/PG.json")
        original = '{"pageId":"PG","buttons":[{"aliasName":"save","width":80,"serviceEvents":{"beforeSaveScript":"return true;"}}]}'
        modified = original.replace("true;", "false;").replace('"width":80', '"width":88')
        sample = seed / relative
        sample.parent.mkdir(parents=True)
        sample.write_text(original, encoding="utf-8")
        subprocess.run(["svnadmin", "create", repository], check=True, capture_output=True)
        url = repository.as_uri()
        subprocess.run(["svn", "import", seed, url, "-m", "fixture seed"], check=True, capture_output=True)
        subprocess.run(["svn", "checkout", url, checkout], check=True, capture_output=True)
        # Use an authorized mount and real SVN working copies with no remote service.
        manifest = workspace["contextDir"] / "scope-fixture.json"
        manifest.write_text(json.dumps({"schemaVersion": 1, "workspaceKey": workspace["workspaceKey"],
            "entries": [{"id": "root", "url": url, "category": "root", "localSubdir": "."}]}), encoding="utf-8")
        workspace["svn"].update(checkoutLayout="manifest-working-copies", scopeManifestPath=manifest, username="fixture")
        workspace["capabilities"]["svn.status"] = True
        page = checkout / relative
        page.write_text(modified, encoding="utf-8")
        local = diff(workspace, logical_path=relative.as_posix())
        self.assertEqual(original, local["baseContent"])
        self.assertIn("return false;", local["readableWorkingContent"])
        self.assertEqual(88, json.loads(local["workingContent"])["buttons"][0]["width"])
        remote = self.home / "second-checkout"
        subprocess.run(["svn", "checkout", url, remote], check=True, capture_output=True)
        (remote / relative).write_text(original.replace("true;", "null;"), encoding="utf-8")
        subprocess.run(["svn", "commit", remote / relative, "-m", "fixture edit"], check=True, capture_output=True)
        compared = diff(workspace, logical_path=relative.as_posix(), remote=True)
        self.assertEqual(modified, compared["localContent"])
        self.assertIn("return null;", compared["readableRemoteContent"])
        self.assertEqual(modified, page.read_text(encoding="utf-8"))


class BillExportTests(WorkspaceCase):
    data_source = "0015"

    def setUp(self):
        super().setUp()
        self.workspace = self.register("database")
        self.key = self.workspace["workspaceKey"]
        self.legacy = legacy_bill_type_dir(self.workspace) / "0015 旧系统名.json"
        self.current = bill_type_output_dir(self.workspace) / self.legacy.name
        self.legacy.parent.mkdir(parents=True)
        self.old_export = {"dataSourceId": self.data_source, "systemName": "旧系统名", "billTypes": [
            {"billTypeCode": "BT_A", "billTypeName": "旧甲", "tableId": "T_A"},
            {"billTypeCode": "BT_B", "billTypeName": "乙", "tableId": "T_B"},
        ]}
        self.legacy.write_text(json.dumps(self.old_export, ensure_ascii=False), encoding="utf-8")
        self.old_bytes = self.legacy.read_bytes()
        self.index()

    def index(self):
        with closing(legacy_source.connect_index_for_workspace(self.workspace)) as conn, conn:
            self.assertEqual([], database_source_exports.rebuild(conn, self.workspace))

    def catalog(self):
        result = self.tool("legacy-source", key=self.key, args=["catalog", "--type", "bill-type"])
        return {item["sourceId"]: item for item in result["items"]}

    def detail(self, export_key):
        row = self.tool("legacy-source", key=self.key, args=["read", "--export-key", export_key])
        return json.loads(row["content"])

    def mock_query(self, _conn, table, ids, bill_type_codes=None):
        self.assertEqual([self.data_source], ids)
        if table == "gd_system":
            return [{"DATA_SOURCE_ID": self.data_source, "SYSTEM_NAME": "新系统名"}]
        return [{"DATA_SOURCE_ID": self.data_source, "BILL_TYPE_CODE": code,
                 "BILL_TYPE_NAME": "新甲" if code == "BT_A" else "乙", "TABLE_ID": "T_" + code[-1]}
                for code in ("BT_A", "BT_B") if not bill_type_codes or code in bill_type_codes]

    def test_previous_index_row_survives_upgrade_and_rebuild(self):
        with closing(legacy_source.connect_index_for_workspace(self.workspace)) as conn, conn:
            conn.execute("UPDATE database_source_export SET export_key='historic' WHERE source_id='BT_A'")
        self.assertEqual(self.old_export["billTypes"][0], self.detail("historic"))
        self.index()
        items = self.catalog()
        self.assertEqual({"BT_A", "BT_B"}, set(items))
        self.assertEqual(self.old_export["billTypes"][1], self.detail(items["BT_B"]["exportKey"]))
        self.assertEqual(self.old_bytes, self.legacy.read_bytes())
        self.assertFalse(self.current.exists())

    def test_filtered_command_preserves_other_bills_and_indexes_old_and_new_files(self):
        before = self.catalog()
        with (patch.object(gusen_hub, "resolve_datasource", return_value=("fixture", {})),
              patch.object(gusen_hub, "db_connect", return_value=nullcontext(object())),
              patch.object(exporter, "resolve_data_source_ids", return_value=[self.data_source]),
              patch.object(exporter, "fetch_rows", side_effect=self.mock_query)):
            result = self.tool("export-bill-type", key=self.key, args=["--bill-type-codes", "BT_A"])
        self.assertEqual(1, result["exported_bill_type_count"])
        self.assertEqual([], result["indexDiagnostics"])
        self.assertEqual(self.old_bytes, self.legacy.read_bytes())
        self.assertEqual({"BT_A", "BT_B"}, set(self.catalog()))
        self.assertEqual("新甲", self.detail(before["BT_A"]["exportKey"])["billTypeName"])
        self.assertEqual(self.old_export["billTypes"][1], self.detail(before["BT_B"]["exportKey"]))
        self.assertTrue(self.current.is_file())

    def test_exact_node_refresh_can_promote_an_old_export(self):
        items = self.catalog()
        with (patch.object(legacy_source, "resolve_datasource", return_value=("fixture", {})),
              patch.object(legacy_source, "db_connect", return_value=nullcontext(object())),
              patch.object(legacy_source, "resolve_system_scope", return_value={"data_source_ids": [self.data_source]}),
              patch.object(exporter, "fetch_rows", side_effect=self.mock_query)):
            result = self.tool("legacy-source", key=self.key, args=["sync-node"],
                               payload={"sourceType": "bill-type", "exportKey": items["BT_A"]["exportKey"]})
        self.assertEqual(1, result["changed"])
        self.assertEqual({"BT_A", "BT_B"}, set(self.catalog()))
        self.assertEqual("新甲", self.detail(items["BT_A"]["exportKey"])["billTypeName"])
        self.assertEqual(self.old_bytes, self.legacy.read_bytes())


class LegacyDatabaseUpgradeTest(WorkspaceCase):
    def test_yaml_upgrade_keeps_project_identity_and_the_old_export_catalog(self):
        directory = self.home / "config"
        unified = directory / "guthon.json"
        template = json.loads(unified.read_text(encoding="utf-8"))
        unified.unlink()
        legacy = {
            "projects.yaml": {"projects": {"old": {"name": "旧项目", "source_mode": "database"}}},
            "products.yaml": {"products": {}},
            "source-tables.yaml": {"source_tables": template["sourceTables"]},
            "sync.yaml": template["sync"],
            "datasource.yaml": {"datasource": {}},
        }
        for filename, payload in legacy.items():
            (directory / filename).write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        key = "projects.old"
        old = gusen_hub.resolve_workspace(gusen_hub.load_config(), key)
        archive = legacy_bill_type_dir(old) / "0015 历史系统.json"
        archive.parent.mkdir(parents=True)
        archive.write_text('{"dataSourceId":"0015","billTypes":[{"billTypeCode":"BT_OLD","tableId":"T_OLD"}]}', encoding="utf-8")
        with closing(legacy_source.connect_index_for_workspace(old)) as conn, conn:
            database_source_exports.rebuild(conn, old)
        before = self.tool("legacy-source", key=key, args=["catalog", "--type", "bill-type"])["items"]
        plan = self.tool("configuration-upgrade", args=["plan"])
        self.assertEqual(0, plan["fromSchema"])
        self.assertEqual(3, plan["toSchema"])
        self.assertEqual("PUBLISHED", self.tool("configuration-upgrade",
            args=["apply", "--offline", "--confirm", plan["planId"]])["phase"])
        upgraded = gusen_hub.resolve_workspace(gusen_hub.load_config(), key)
        self.assertEqual(old["root"], upgraded["root"])
        self.assertEqual(old["indexPath"], upgraded["indexPath"])
        with closing(legacy_source.connect_index_for_workspace(upgraded)) as conn, conn:
            self.assertEqual([], database_source_exports.rebuild(conn, upgraded))
        after = self.tool("legacy-source", key=key, args=["catalog", "--type", "bill-type"])["items"]
        self.assertEqual(before, after)
        self.assertEqual(["BT_OLD"], [item["sourceId"] for item in after])
