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
from common.workspace_selection import select_workspace
from providers.api import sync as api_sync
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


class WorkspaceSelectionTest(WorkspaceCase):
    def test_prompt_requires_a_bounded_project_mention(self):
        current = self.register("database")
        self.tool("workspace-create", payload={"id": "shipping", "name": "北川项目", "aliases": ["航运"], "sourceMode": "api"})
        config = gusen_hub.load_config()
        for prompt in ("仅整理跨境航运费率说明和设计稿", "修改航运中心的费率说明", "调整航运查询服务的规则说明",
                       "目标是完成资料整理，背景涉及跨境航运费率"):
            with self.subTest(prompt=prompt):
                routed = select_workspace(config, path=current["root"], prompt=prompt)
                self.assertEqual(current["workspaceKey"], routed.get("workspaceKey"), routed)
                unbound = select_workspace(config, path=self.home / "var", prompt=prompt)
                self.assertEqual("WORKSPACE_AMBIGUOUS", unbound["error"]["code"])
        for prompt in ("修改航运的配置", "在航运项目中修复配置", "修改【航运】的配置", "修改北川项目的配置",
                       "/guthon-use 航运", "切换到航运", "目标工作区为航运"):
            with self.subTest(prompt=prompt):
                routed = select_workspace(config, prompt=prompt)
                self.assertEqual("shipping", routed.get("workspaceKey"), routed)
        for prompt in ("修改航运的配置和验收 database 的策略", "参考航运的配置"):
            self.assertFalse(select_workspace(config, prompt=prompt)["ok"])

    def test_postposed_reference_keeps_the_registered_project_target(self):
        current = self.register("api")
        reference = self.register("database")
        config = gusen_hub.load_config()
        name = reference["name"]
        for prompt in (
            f"这种方式已经在【{name}】中开发过且经过验证，可以参考进行开发。先生成开发计划文档。",
            f"【{name}】仅供参考，先写开发计划。",
            f"开发{current['name']}。这种方式已在【{name}】中实现，可直接借鉴。",
        ):
            with self.subTest(prompt=prompt):
                from_project = select_workspace(config, prompt=prompt, path=current["root"])
                self.assertEqual(current["workspaceKey"], from_project.get("workspaceKey"), from_project)
                followup = select_workspace(config, prompt="按计划开始实现", path=current["root"],
                                            current_workspace=from_project["workspaceKey"])
                self.assertEqual(current["workspaceKey"], followup["workspaceKey"])
        no_project = select_workspace(config, prompt=f"这个做法在【{name}】中实现过，可以参考。", path=self.home / "var")
        self.assertFalse(no_project["ok"])
        explicit_target = select_workspace(config, prompt=f"在【{name}】中修改验证过的逻辑，可以参考既有规则。",
                                           path=current["root"])
        self.assertEqual(reference["workspaceKey"], explicit_target["workspaceKey"])
        new_work = select_workspace(config, prompt=f"在【{name}】中实现，可以参考{current['name']}。",
                                    path=current["root"])
        self.assertEqual(reference["workspaceKey"], new_work["workspaceKey"])


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

    def test_upload_remark_is_recorded_by_the_confirmed_operation(self):
        workspace = self.register("api")
        key = workspace["workspaceKey"]
        self.tool("api", key=key, args=["configure"], payload={"serverUrl": "https://fixture.invalid/guthon/",
            "systemIds": ["S1"], "dataSourceIds": ["D1"], "allSystems": False})
        path = "datasources/D1/procedures/audit/hello.gss"
        ApiStore(workspace).publish([SourceFile(path, "#return('baseline')\n", "procedure", {
            "dataSourceId": "D1", "procedureId": "P1", "procedureAliasId": "audit", "funId": "hello",
        })])
        with self.assertRaisesRegex(ApiError, "备注必须为文本"):
            api_sync.upload(workspace, object(), {"paths": [path], "confirm": True, "remark": ["invalid"]})
        result = api_sync.upload(workspace, object(), {
            "paths": [path], "confirm": True, "remark": "  核对回执\n第二行  ",
        })
        self.assertTrue(result["complete"])
        self.assertEqual("UNCHANGED", result["results"][0]["stage"])
        receipt = self.tool("api", key=key, args=["operation"], payload={"operationId": result["operationId"]})
        self.assertEqual("核对回执\n第二行", receipt["remark"])

class SourceSearchTypeTest(WorkspaceCase):
    def test_api_filters_before_paging_and_keeps_metadata_and_body_matches(self):
        workspace = self.register("api")
        key = workspace["workspaceKey"]
        self.tool("api", key=key, args=["configure"], payload={"serverUrl": "https://fixture.invalid/guthon/",
            "systemIds": ["S1"], "dataSourceIds": ["D1"], "allSystems": False})
        ApiStore(workspace).publish([
            SourceFile("datasources/D1/procedures/audit/check.gss", "#return('needle')", "procedure",
                       {"dataSourceId": "D1", "procedureId": "P1", "procedureAliasId": "audit", "funId": "check"}),
            SourceFile("datasources/D1/tables/only_name.json", '{"tableId":"only_name"}', "table",
                       {"dataSourceId": "D1", "tableId": "only_name", "tableName": "needle table"}),
            SourceFile("datasources/D1/tables/raw_content.json", '{"tableId":"raw_content","remark":"needle"}', "table",
                       {"dataSourceId": "D1", "tableId": "raw_content"}),
        ])
        self.tool("api", key=key, args=["index"])
        query = {"query": "needle", "limit": 1}
        unfiltered = self.tool("api", key=key, args=["search"], payload=query)
        self.assertEqual("procedure", unfiltered["hits"][0]["sourceType"])
        table_query = {**query, "sourceType": "table"}
        first = self.tool("api", key=key, args=["search"], payload=table_query)
        self.assertEqual(["only_name"], [hit["sourceId"] for hit in first["hits"]])
        self.assertEqual(1, first["nextOffset"])
        last = self.tool("api", key=key, args=["search"], payload={**table_query, "offset": first["nextOffset"]})
        self.assertEqual(["raw_content"], [hit["sourceId"] for hit in last["hits"]])
        self.assertIsNone(last["nextOffset"])

    def test_svn_filters_both_candidates_and_the_truncation_count(self):
        workspace = self.register("svn")
        key = workspace["workspaceKey"]
        with closing(legacy_source.connect_index_for_workspace(workspace)) as conn, conn:
            conn.executemany(
                """INSERT INTO gusen_source_record (
                    source_layer,scope_id,provider,source_table,source_id,source_alias_id,source_name,change_key,status,indexed_time
                ) VALUES ('project',?,'svn',?,?,?,?,'','OK','')""",
                [(workspace["scopeId"], "procedure", f"P{i}", f"alias{i}", f"needle {i:02}") for i in range(11)]
                + [(workspace["scopeId"], "table", "needle_table", "needle_table", "needle table")],
            )
        args = ["find", "--keyword=needle", "--limit", "10"]
        unfiltered = self.tool("svn", key=key, args=args)
        self.assertTrue(unfiltered["truncated"])
        filtered = self.tool("svn", key=key, args=[*args, "--source-type", "table"])
        self.assertEqual(["needle_table"], [hit["source_id"] for hit in filtered["candidates"]])
        self.assertEqual(1, filtered["totalCandidates"])
        self.assertFalse(filtered["truncated"])

    def test_database_filters_source_records_fragments_and_exports(self):
        workspace = self.register("database")
        key = workspace["workspaceKey"]
        table = workspace["databaseDir"] / "schema" / "fixture" / "needle_table.json"
        view = workspace["databaseDir"] / "views" / "fixture" / "needle_view.sql"
        for target, raw in (
            (table, '{"tableId":"needle_table","tableName":"needle table"}'), (view, "SELECT 'needle';"),
        ):
            target.parent.mkdir(parents=True)
            target.write_text(raw, encoding="utf-8")
        with closing(legacy_source.connect_index_for_workspace(workspace)) as conn, conn:
            for source_id, name, script in (
                ("PG-NAME", "needle page", "return true;"), ("PG-BODY", "other page", "return 'needle';"),
            ):
                row = {"source_table": "page", "source_id": source_id, "fun_id": "", "source_alias_id": source_id,
                       "source_name": name, "source_content": json.dumps({"pageId": source_id, "compScript": script}),
                       "system_id": "SYS-FIXTURE"}
                legacy_source.upsert_source(conn, row, "project", workspace["scopeId"],
                                            workspace["projectId"], {}, {}, workspace=workspace)
            self.assertEqual([], database_source_exports.rebuild(conn, workspace))
        args = ["search", "--keyword=needle"]
        all_hits = self.tool("legacy-source", key=key, args=args)["items"]
        self.assertEqual({"page", "table", "view"}, {hit["sourceType"] for hit in all_hits})
        pages = self.tool("legacy-source", key=key, args=[*args, "--type", "page"])["items"]
        self.assertEqual({("page", "PG-NAME", ""), ("page", "PG-BODY", "/compScript")},
                         {(hit["sourceType"], hit["sourceId"], hit["pointer"]) for hit in pages})
        tables = self.tool("legacy-source", key=key, args=[*args, "--type", "table"])["items"]
        self.assertEqual([("table", "needle_table")], [(hit["sourceType"], hit["sourceId"]) for hit in tables])


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
        self.assertIn('"width": 88', local["readableWorkingContent"])
        remote = self.home / "second-checkout"
        subprocess.run(["svn", "checkout", url, remote], check=True, capture_output=True)
        (remote / relative).write_text(original.replace("true;", "null;"), encoding="utf-8")
        subprocess.run(["svn", "commit", remote / relative, "-m", "fixture edit"], check=True, capture_output=True)
        compared = diff(workspace, logical_path=relative.as_posix(), remote=True)
        self.assertEqual(modified, compared["localContent"])
        self.assertIn("return null;", compared["readableRemoteContent"])
        self.assertEqual(modified, page.read_text(encoding="utf-8"))


class DatabaseWorkcopyBaselineTest(WorkspaceCase):
    def test_controlled_saves_keep_original_baseline_and_untracked_changes_do_not_gain_one(self):
        workspace = self.register("database")
        key = workspace["workspaceKey"]
        row = {"source_table": "procedure", "source_id": "FN-ROW", "fun_id": "sample",
               "source_alias_id": "com.golden.sample", "source_name": "sample",
               "source_content": "#return('original')", "version_mac": "db-v1",
               "system_id": "SYS-FIXTURE", "data_source_id": "DS-1"}

        def sync():
            with closing(legacy_source.connect_index_for_workspace(workspace)) as conn, conn:
                legacy_source.upsert_source(conn, row, "project", workspace["scopeId"],
                                            workspace["projectId"], {}, {}, workspace=workspace)
            item, = self.tool("legacy-source", key=key, args=["catalog", "--type", "procedure"])["items"]
            return {field: item[field] for field in ("recordId", "sourceId", "sourcePath")}

        def edit(action, **payload):
            return self.tool("legacy-source", key=key, args=[action], payload={**identity, **payload})

        identity = sync()
        readonly = workspace["readonlyDir"] / identity["sourcePath"]
        copy = workspace["workcopyDir"] / identity["sourcePath"]
        opened = edit("edit-read")
        saved = edit("edit-save", sourceHash=opened["sourceHash"], content="#return('first')")
        row.update(source_content="#return('remote')", version_mac="db-v2")
        identity = sync()
        edit("edit-save", sourceHash=saved["sourceHash"], content="#return('second')")
        diff = edit("edit-comparison")
        self.assertTrue(diff["trustedBaseline"])
        self.assertEqual("#return('original')", diff["baseContent"])
        self.assertEqual("#return('second')", diff["content"])
        item, = self.tool("legacy-source", key=key, args=["review-workcopies"])["items"]
        self.assertEqual(identity["sourcePath"], item["sourcePath"])
        self.assertTrue(item["trustedBaseline"])
        preview = edit("publish-preview")
        self.assertEqual("db-v1", preview["databaseBaseVersion"])
        confirmed = edit("publish-confirm", sourceHash=preview["sourceHash"], reviewId=preview["reviewId"])
        self.assertEqual(preview["content"], confirmed["content"])
        from common.database_workcopy_edit import run as edit_workcopy
        config = gusen_hub.load_config()
        self.assertEqual("SYS-FIXTURE", preview["databaseIdentity"]["system_id"])
        remapped = {**workspace, "systemMappings": {"other": {"system_id": "SYS-OTHER", "data_source_id": "DS-1"}}}
        with self.assertRaisesRegex(ValueError, "基线或候选已变化"):
            edit_workcopy(remapped, config, "publish-confirm", {
                **identity, "sourceHash": preview["sourceHash"], "reviewId": preview["reviewId"],
            })
        edit("edit-save", sourceHash=confirmed["sourceHash"], content="#return('third')")
        with self.assertRaisesRegex(ValueError, "源码已发生变化"):
            edit_workcopy(workspace, gusen_hub.load_config(), "publish-confirm", {
                **identity, "sourceHash": preview["sourceHash"], "reviewId": preview["reviewId"],
            })
        self.assertEqual("#return('remote')", readonly.read_text(encoding="utf-8"))
        copy.write_text("#return('legacy')", encoding="utf-8")
        opened = edit("edit-read")
        edit("edit-save", sourceHash=opened["sourceHash"], content="#return('still unknown')")
        diff = edit("edit-comparison")
        self.assertFalse(diff["trustedBaseline"])
        self.assertEqual("#return('remote')", diff["baseContent"])
        self.assertEqual("#return('still unknown')", diff["content"])
        from common.command_errors import CommandError
        from common.workspace_config import change_source_mode, delete_workspace_config
        for operation, payload in ((change_source_mode, {"expectedMode": "database", "sourceMode": "api"}),
                                   (delete_workspace_config, {})):
            with self.assertRaises(CommandError) as blocked:
                operation(self.home, {"workspaceKey": key, "checkOnly": True, **payload}, gusen_hub)
            self.assertEqual("DATABASE_WORKCOPY_DRAFTS_PENDING", blocked.exception.error_code)
        copy.write_bytes(readonly.read_bytes())
        self.assertTrue(delete_workspace_config(self.home, {"workspaceKey": key, "checkOnly": True}, gusen_hub)["ok"])
        copy.write_text("#return('orphaned draft')", encoding="utf-8")
        with closing(legacy_source.connect_index_for_workspace(workspace)) as conn, conn:
            conn.execute("DELETE FROM gusen_source_record WHERE source_id=?", (identity["sourceId"],))
        self.assertEqual([], self.tool("legacy-source", key=key, args=["review-workcopies"])["items"])
        with self.assertRaises(CommandError) as blocked:
            delete_workspace_config(self.home, {"workspaceKey": key, "checkOnly": True}, gusen_hub)
        self.assertEqual("DATABASE_WORKCOPY_DRAFTS_PENDING", blocked.exception.error_code)

    def test_verified_refresh_waits_for_database_without_replacing_workcopy(self):
        from unittest.mock import MagicMock
        from common.database_node_sync import sync_verified_procedure

        workspace = self.register("database")
        row = {"source_table": "procedure", "source_id": "FN-ROW", "fun_id": "sample",
               "source_alias_id": "com.golden.sample", "source_name": "sample", "data_source_id": "DS-1",
               "source_content": "#return('old')", "version_mac": "v1"}
        with closing(legacy_source.connect_index_for_workspace(workspace)) as conn, conn:
            legacy_source.upsert_source(conn, row, workspace["layer"], workspace["scopeId"],
                                        workspace["projectId"], {}, {}, workspace=workspace)
            conn.execute("INSERT OR REPLACE INTO gusen_sync_state(state_key,state_value) VALUES('last_success_time','unchanged')")
        item, = self.tool("legacy-source", key=workspace["workspaceKey"], args=["catalog", "--type", "procedure"])["items"]
        mirror = workspace["readonlyDir"] / item["sourcePath"]
        draft = workspace["workcopyDir"] / item["sourcePath"]
        draft.parent.mkdir(parents=True)
        draft.write_text("#return('newer local draft')", encoding="utf-8")
        identity = {"workspaceKey": workspace["workspaceKey"], **{name: row[name] for name in
                    ("source_table", "source_id", "fun_id", "source_alias_id", "data_source_id")}}
        config = gusen_hub.load_config()
        remote = MagicMock()
        cursor = remote.cursor.return_value.__enter__.return_value
        saved = "#return('published')"
        with (patch.object(legacy_source, "resolve_datasource", return_value=("fixture", {})),
              patch.object(legacy_source, "db_connect", return_value=nullcontext(remote)),
              patch.object(legacy_source, "resolve_system_scope", return_value={"data_source_ids": ["DS-1"]}),
              patch.object(legacy_source, "_included", return_value=True)):
            cursor.fetchall.return_value = [row]
            self.assertEqual({"verified": False}, sync_verified_procedure(workspace, config, identity,
                                                                         base_version="v1", database_version="v2", content=saved))
            self.assertEqual("#return('old')", mirror.read_text(encoding="utf-8"))
            cursor.fetchall.return_value = [{**row, "version_mac": "v2", "source_content": saved}]
            self.assertEqual({"verified": False, "reason": "MIRROR_VERSION_CHANGED"},
                             sync_verified_procedure(workspace, config, identity,
                                                     base_version="different", database_version="v2", content=saved))
            with patch.object(legacy_source, "resolve_system_scope", return_value={
                    "data_source_ids": ["DS-1"], "system_name_by_data_source_id": {"DS-1": "Renamed"}}):
                self.assertEqual({"verified": False, "reason": "MIRROR_PATH_CHANGED"},
                                 sync_verified_procedure(workspace, config, identity,
                                                         base_version="v1", database_version="v2", content=saved))
            self.assertEqual({"verified": True, "workcopyState": "CONFLICT"},
                             sync_verified_procedure(workspace, config, identity, base_version="v1",
                                                     database_version="v2", content=saved, advance_workcopy=True))
            sql, params = cursor.execute.call_args.args
            self.assertIn("LIMIT 2", sql)
            self.assertIn("VERSION_MAC", sql.split("WHERE", 1)[1].split("ORDER BY", 1)[0])
            self.assertNotIn("CHECK_IN_DATE", sql.split("WHERE", 1)[1].split("ORDER BY", 1)[0])
            self.assertEqual(["v2", "FN-ROW", "sample", "com.golden.sample", "DS-1"], params)
            cursor.execute.assert_any_call("SET TRANSACTION READ ONLY")
            ordinary_sql, ordinary_params = legacy_source.single_source_sql(
                config["source_tables"], "procedure", {"sourceId": "FN-ROW", "funId": "sample"})
            self.assertIn("CHECK_IN_DATE", ordinary_sql.split("WHERE", 1)[1].split("ORDER BY", 1)[0])
            self.assertEqual(["FN-ROW", "sample"], ordinary_params)
        self.assertEqual(saved, mirror.read_text(encoding="utf-8"))
        self.assertEqual("#return('newer local draft')", draft.read_text(encoding="utf-8"))
        with closing(legacy_source.connect_index_for_workspace(workspace)) as conn:
            self.assertEqual("unchanged", conn.execute("SELECT state_value FROM gusen_sync_state WHERE state_key='last_success_time'").fetchone()[0])


class DatabasePageEditorTest(WorkspaceCase):
    def test_default_editor_uses_page_type_and_saves_service_script_to_workcopy(self):
        workspace = self.register("database")
        key = workspace["workspaceKey"]
        service = {"pageId": "PG-SERVICE", "pageType": "0", "compScript": "#return('old')", "runInTran": 1}
        page = {"pageId": "PG-FORM", "pageType": 1, "compScript": "#return('ordinary page')", "views": []}
        legacy_page = {"pageId": "PG-LEGACY", "views": []}
        with closing(legacy_source.connect_index_for_workspace(workspace)) as conn, conn:
            for source in (service, page, legacy_page):
                raw = json.dumps(source)
                if source is service:
                    raw = json.dumps(raw)
                row = {"source_table": "page", "source_id": source["pageId"], "fun_id": "",
                       "source_alias_id": source["pageId"], "source_name": source["pageId"],
                       "source_content": raw, "system_id": "SYS-FIXTURE"}
                legacy_source.upsert_source(conn, row, "project", workspace["scopeId"],
                                            workspace["projectId"], {}, {}, workspace=workspace)
        catalog = self.tool("legacy-source", key=key, args=["catalog", "--type", "page"])
        identities = {item["sourceId"]: {field: item[field] for field in ("recordId", "sourceId", "sourcePath")}
                      for item in catalog["items"]}
        for source in (service, page, legacy_page):
            identity = identities[source["pageId"]]
            target = self.tool("legacy-source", key=key, args=["edit-read"],
                               payload={**identity, "resolveDefaultFragment": True})
            if source is service:
                self.assertEqual({"pointer": "/compScript", "language": "guthon-gss"}, target["defaultFragment"])
            else:
                self.assertIsNone(target["defaultFragment"])
                design = self.tool("legacy-source", key=key, args=["edit-read"], payload={**identity, "design": True})
                self.assertEqual(source["pageId"], design["model"]["pageId"])

        identity = identities[service["pageId"]]
        readonly = workspace["readonlyDir"] / identity["sourcePath"]
        original = readonly.read_bytes()
        fragment = {**identity, "pointer": "/compScript"}
        opened = self.tool("legacy-source", key=key, args=["edit-read"], payload=fragment)
        self.assertEqual(service["compScript"], opened["content"])
        changed = "#return('new')"
        self.tool("legacy-source", key=key, args=["edit-save"],
                  payload={**fragment, "sourceHash": opened["sourceHash"], "content": changed})
        self.assertEqual(changed, self.tool("legacy-source", key=key, args=["edit-read"], payload=fragment)["content"])
        saved = workspace["workcopyDir"] / identity["sourcePath"]
        self.assertEqual({**service, "compScript": changed}, json.loads(json.loads(saved.read_text(encoding="utf-8"))))
        self.assertEqual(original, readonly.read_bytes())


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
