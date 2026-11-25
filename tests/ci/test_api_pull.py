"""Full API pull through the CLI with a local, paged platform fixture."""

from contextlib import closing
import os
import sqlite3
from unittest.mock import patch

from providers.api import editor_state, index
from providers.api.client import ApiError
from providers.api.download import BASE
from providers.api.progress import output_to
from providers.api.store import ApiStore
from test_provider_regressions import WorkspaceCase


class PullPlatform:
    root_url = "https://fixture.invalid/guthon"

    def __init__(self):
        self.system_name = "Fixture"
        self.functions = {
            "first": {"funId": "first", "funScript": "#return('alpha')\n"},
            "second": {"funId": "second", "funScript": "#return('beta')\n"},
        }
        self.requests = []
        self.repeat_page = False
        self.first_page = None

    def ensure_login(self):
        pass

    @staticmethod
    def _page(functions, guid=None):
        return {"list": [{"dataSourceId": "D1", "procedureId": "P1", "subPath": "fixture",
                          "funs": functions}], "guid": guid}

    def request(self, path, params=None, *, form=None):
        self.requests.append((path, params))
        if path == "/develop/systems/apps/developSystemList.htm":
            return [{"systemId": "S1", "systemName": self.system_name, "dataSourceId": "D1"}]
        if path == "/develop/systems/datasource/list.htm":
            return [{"dataSourceId": "D1"}]
        if path == BASE + "getProcedures.htm":
            self.first_page = self._page(list(self.functions.values())[:1], "fixture-next")
            return self.first_page
        if path == BASE + "getNextPage.htm" and params == {"guid": "fixture-next"}:
            return self.first_page if self.repeat_page else self._page(list(self.functions.values())[1:])
        if path == BASE + "getProcFun.htm" and params["procedureId"] == "P1":
            return {"item": self.functions[params["funId"]]}
        if path == "/develop/dev/models/config/getConfigs.htm" and form == {
            "systemId": "S1", "tempId": "", "flName": "",
        }:
            return []
        if path in {BASE + endpoint for endpoint in ("getModulePages.htm", "getSystemScripts.htm",
                                                      "getTables.htm", "getViews.htm")}:
            return []
        raise AssertionError(f"Unexpected platform request {path}")


class ApiFullPullTest(WorkspaceCase):
    def setUp(self):
        super().setUp()
        self.workspace = self.register("api")
        self.key = self.workspace["workspaceKey"]
        self.platform = PullPlatform()
        self.tool("api", key=self.key, args=["configure"], payload={
            "serverUrl": self.platform.root_url, "systemIds": ["S1"], "dataSourceIds": ["D1"],
            "allSystems": False, "includeProjectFiles": False,
        })
        self.store = ApiStore(self.workspace)

    def api(self, action, payload=None):
        with patch("providers.api.cli.client_for", return_value=self.platform):
            return self.tool("api", key=self.key, args=[action], payload=payload)

    @staticmethod
    def path(name):
        return f"datasources/D1/procedures/fixture/{name}.gss"

    def test_unchanged_pull_keeps_index_and_receipt_after_fetching_all_pages(self):
        initial = self.api("pull")
        initial_receipt = self.store.operation(initial["operationId"])
        self.assertTrue(initial["complete"])
        requests = self.platform.requests[:]
        self.platform.requests.clear()
        statements = []
        logs = []
        connect = sqlite3.connect

        def trace_baseline(path, *args, **kwargs):
            conn = connect(path, *args, **kwargs)
            if path == self.store.path:
                conn.set_trace_callback(statements.append)
            return conn

        with (
            patch.object(ApiStore, "_receipt", autospec=True, side_effect=ApiStore._receipt) as receipt,
            patch.object(index, "_index_item", side_effect=AssertionError("unchanged source was reindexed")),
            patch("providers.api.store.sqlite3.connect", side_effect=trace_baseline),
            output_to(logs.append),
        ):
            result = self.api("pull")
        self.assertEqual(requests, self.platform.requests)
        self.assertIn((BASE + "getNextPage.htm", {"guid": "fixture-next"}), requests)
        self.assertEqual([], result["updated"])
        self.assertEqual(initial["updated"], result["preserved"])
        self.assertEqual(initial["index"]["indexGeneration"], result["index"]["indexGeneration"])
        self.assertEqual(2, receipt.call_count)
        self.assertTrue(statements)
        self.assertFalse(any(sql.startswith("INSERT OR REPLACE INTO source") for sql in statements))
        for phase in ("远端源码下载", "源码发布", "索引核对与更新"):
            self.assertTrue(any(f"{phase}结束 · 耗时" in line for line in logs))
        final_receipt = self.store.operation(result["operationId"])
        for field in ("paths", "applied", "stage", "current", "conflicts"):
            self.assertEqual(initial_receipt[field], final_receipt[field])

    def test_incremental_index_matches_full_rebuild_after_metadata_edit_and_deletion(self):
        self.api("pull")
        first, second, third = map(self.path, ("first", "second", "third"))
        (self.store.root / first).write_bytes(b"#return('unindexed local edit')\n")
        self.platform.functions["first"]["funName"] = "New label"
        del self.platform.functions["second"]
        self.platform.functions["third"] = {"funId": "third", "funScript": "#return('new remote file')\n"}
        self.platform.functions["fourth"] = {"funId": "fourth", "funScript": "#return('other remote file')\n"}
        result = self.api("pull")
        self.assertTrue(result["complete"])
        self.assertIn(first, result["preserved"])
        self.assertNotIn(first, result["updated"])
        self.assertIn(second, result["deleted"])
        self.assertEqual(sorted([first, second, third, self.path("fourth")]), result["index"]["updatedPaths"])
        self.assertNotIn(second, self.store.paths())
        self.assertEqual("#return('unindexed local edit')\n", self.store.read(first)["content"])
        before = index.catalog(self.workspace)["objects"]
        hit = index.search(self.workspace, "unindexed local edit")["hits"]
        self.assertEqual([first], [row["path"] for row in hit])
        rebuilt = index.rebuild(self.workspace)
        self.assertEqual(before, index.catalog(self.workspace)["objects"])
        self.assertEqual(result["index"]["diagnostics"], rebuilt["diagnostics"])

    def test_a_later_pull_reconciles_a_publication_whose_index_update_failed(self):
        initial = self.api("pull")
        self.platform.functions["first"]["funScript"] = "#return('changed remote text')\n"
        with patch.object(index, "update", side_effect=RuntimeError("fixture index failure")):
            with self.assertRaisesRegex(RuntimeError, "fixture index failure"):
                self.api("pull")
        self.assertEqual(initial["index"]["indexGeneration"], index.catalog(self.workspace)["indexGeneration"])
        self.assertEqual("#return('changed remote text')\n", self.store.read(self.path("first"))["content"])
        result = self.api("pull")
        self.assertEqual([], result["updated"])
        self.assertEqual([self.path("first")], result["index"]["updatedPaths"])
        self.assertTrue(result["complete"])

    def test_pagination_failure_dirty_draft_and_conflict_protect_checkout(self):
        initial = self.api("pull")
        first = self.path("first")
        self.platform.functions["first"]["funScript"] = "#return('edited on platform')\n"
        self.platform.repeat_page = True
        with self.assertRaises(ApiError) as error:
            self.api("pull")
        self.assertEqual("API_PAGINATION_INVALID", error.exception.code)
        self.assertEqual("#return('alpha')\n", self.store.read(first)["content"])
        self.platform.repeat_page = False
        token = editor_state.update(self.workspace, {"pid": os.getpid(),
                                    "documents": [{"path": first, "dirty": True}]})["editorToken"]
        with self.assertRaises(ApiError) as error:
            self.api("pull")
        self.assertEqual("API_EDITOR_DIRTY", error.exception.code)
        self.assertEqual(initial["index"]["indexGeneration"], index.catalog(self.workspace)["indexGeneration"])
        editor_state.update(self.workspace, {"editorToken": token, "close": True})
        (self.store.root / first).write_bytes(b"#return('edited locally')\n")
        result = self.api("pull")
        self.assertFalse(result["downloadComplete"])
        self.assertFalse(result["complete"])
        self.assertEqual([first], [row["path"] for row in result["conflicts"]])
        self.assertEqual("#return('edited locally')\n", self.store.read(first)["content"])
        self.assertEqual("#return('alpha')\n", self.store.baseline(first))

    def test_older_index_and_changed_catalog_are_rebuilt(self):
        original = self.api("pull")
        with closing(sqlite3.connect(self.workspace["indexPath"])) as conn, conn:
            conn.execute("DELETE FROM gusen_sync_state WHERE state_key='pullCatalogFingerprint'")
        updated = self.api("pull")
        self.assertNotEqual(original["index"]["indexGeneration"], updated["index"]["indexGeneration"])
        self.assertNotIn("updatedPaths", updated["index"])
        self.platform.system_name = "Renamed fixture"
        renamed = self.api("pull")
        self.assertNotEqual(updated["index"]["indexGeneration"], renamed["index"]["indexGeneration"])
        self.assertNotIn("updatedPaths", renamed["index"])

    def test_remote_deletion_preserves_local_work_and_drops_stale_index_entry(self):
        self.api("pull")
        first = self.path("first")
        (self.store.root / first).write_bytes(b"#return('keep my changes')\n")
        del self.platform.functions["first"]
        result = self.api("pull")
        self.assertFalse(result["complete"])
        self.assertEqual([first], [row["path"] for row in result["conflicts"]])
        self.assertEqual("#return('keep my changes')\n", self.store.read(first)["content"])
        self.assertTrue(self.store.read(first)["metadata"]["remoteDeleted"])
        self.assertNotIn(first, [obj["path"] for obj in index.catalog(self.workspace)["objects"]])

    def test_explicit_scope_apply_and_exact_refresh_use_their_original_index_routes(self):
        initial = self.api("pull")
        self.api("scope-save", {"systemIds": ["S1"], "dataSourceIds": [], "allSystems": False})
        with patch.object(index, "reconcile_pull", side_effect=AssertionError("wrong index route")):
            scope = self.api("pull")
            self.assertEqual("scope-apply", scope["kind"])
            self.assertTrue(scope["complete"])
            self.assertNotEqual(initial["index"]["indexGeneration"], scope["index"]["indexGeneration"])
            self.platform.requests.clear()
            self.platform.functions["first"]["funScript"] = "#return('exact refresh')\n"
            first = self.path("first")
            refreshed = self.api("refresh", {"path": first})
        self.assertEqual([(BASE + "getProcFun.htm", {"procedureId": "P1", "funId": "first"})],
                         self.platform.requests)
        self.assertEqual([first], refreshed["updated"])
        self.assertEqual([first], refreshed["index"]["updatedPaths"])
