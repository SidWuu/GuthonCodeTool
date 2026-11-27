"""Full API pull through the CLI with a local, paged platform fixture."""

from contextlib import closing
from copy import deepcopy
import json
import os
import sqlite3
from unittest.mock import patch

from providers.api import editor_state, index, native_page, page_source
from providers.api.client import ApiError
from providers.api.download import BASE, SourceFile
from providers.api.progress import output_to
from providers.api.store import ApiStore, digest
from providers.api.workspace import project_metadata
from providers.source_helper import SourceHelperMcpServer
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
        self.pages = []
        self.native_pages = {}
        self.menu = []
        self.menu_error = None
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
        if path == BASE + "getModulePages.htm":
            return self.pages
        if path == BASE + "getModulePage.htm":
            return {"item": next(page for page in self.pages if page["pageId"] == params["pageId"])}
        if path == page_source.READ:
            return self.native_pages[form["pageId"]]
        if path == BASE + "getModuleTree.htm":
            if self.menu_error is not None:
                raise self.menu_error
            return {"list": self.menu}
        if path in {BASE + endpoint for endpoint in ("getSystemScripts.htm", "getTables.htm", "getViews.htm")}:
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

    def mcp_tool(self, server, name, **arguments):
        with patch("providers.api.cli.client_for", return_value=self.platform):
            return server.handle({
                "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": {"name": name, "arguments": {"workspaceKey": self.key, **arguments}},
            })["result"]["structuredContent"]

    def prepare_page_fixture(self):
        path = "systems/S1/pages/main/PG-EDIT/PG-EDIT.xml"
        model = {"pageId": "PG-EDIT", "pageType": 1, "title": "Native model"}
        self.platform.pages.append({
            "systemId": "S1", "pageSubId": "main", "pageId": "PG-EDIT",
            "fileName": "PG-EDIT.xml", "versionMac": "v1", "pageType": 1,
            "xml": native_page.encode({**model, "title": "Export"}),
        })
        self.platform.native_pages["PG-EDIT"] = {"bean": model, "version": "v1"}
        self.assertTrue(self.api("pull")["complete"])
        self.platform.requests.clear()
        server = SourceHelperMcpServer(self.home, "test", enable_writes=True, enable_platform_tools=False)
        server.handle({"jsonrpc": "2.0", "id": 0, "method": "initialize",
                       "params": {"protocolVersion": "2025-11-25"}})
        server.handle({"jsonrpc": "2.0", "method": "notifications/initialized"})
        return path, model, server

    def test_mcp_opens_and_edits_native_page_in_local_write_mode(self):
        path, model, server = self.prepare_page_fixture()
        self.assertTrue(self.store.read(path)["readonly"])
        original = self.mcp_tool(server, "api_open_document", path=path)
        self.assertTrue(original["ok"], original)
        lease = original["data"]
        self.assertEqual(lease["metadata"]["pageSource"], page_source.ORIGIN)
        self.assertEqual(page_source.model(lease["content"]), model)
        self.assertEqual(lease["sourceHash"], digest(self.store.baseline(path)))
        first_requests = [(BASE + "getModulePage.htm", {"pageId": "PG-EDIT"}), (page_source.READ, None)]
        self.assertEqual(first_requests, self.platform.requests)
        preview = self.mcp_tool(server, "api_preview_document", leaseId=lease["leaseId"],
                                content=native_page.encode({**model, "title": "Local edit"}))
        self.assertTrue(preview["ok"], preview)
        saved = self.mcp_tool(server, "api_write_document", leaseId=lease["leaseId"],
                              previewId=preview["data"]["previewId"], idempotencyKey="fixture-edit")
        self.assertTrue(saved["ok"], saved)
        self.assertEqual(page_source.model(self.store.read(path)["content"])["title"], "Local edit")
        self.assertEqual(self.store.read(path)["sourceHash"], saved["data"]["afterHash"])
        reopened = self.mcp_tool(server, "api_open_document", path=path)
        self.assertTrue(reopened["ok"], reopened)
        self.assertEqual(first_requests, self.platform.requests)

    def test_mcp_page_preparation_preserves_conflicts_and_local_edits(self):
        path, model, server = self.prepare_page_fixture()
        original = self.store.read(path)
        editor = editor_state.update(self.workspace, {
            "pid": os.getpid(), "documents": [{"path": path, "dirty": True}],
        })
        response = self.mcp_tool(server, "api_open_document", path=path)
        self.assertEqual("API_EDITOR_DIRTY", response["error"]["code"])
        self.assertEqual([], self.platform.requests)
        self.assertEqual(original, self.store.read(path))
        editor_state.update(self.workspace, {"editorToken": editor["editorToken"], "close": True})

        target = self.store.root / path
        target.chmod(0o600)
        local = native_page.encode({**model, "title": "Existing local edit"})
        target.write_bytes(local.encode())
        response = self.mcp_tool(server, "api_open_document", path=path)
        self.assertEqual("API_PAGE_EDIT_CONFLICT", response["error"]["code"])
        self.assertEqual([], self.platform.requests)
        self.assertEqual(local, self.store.read(path)["content"])
        self.assertEqual(original["baseHash"], self.store.read(path)["baseHash"])

        self.api("refresh", {"path": path})
        conflict = self.store.conflict(path)
        target.write_bytes(original["content"].encode())
        self.platform.requests.clear()
        response = self.mcp_tool(server, "api_open_document", path=path)
        self.assertEqual("API_PAGE_EDIT_CONFLICT", response["error"]["code"])
        self.assertEqual([], self.platform.requests)
        self.assertEqual(conflict["remoteHash"], self.store.conflict(path)["remoteHash"])
        self.assertEqual(original, self.store.read(path))

    def test_mcp_page_preparation_requires_editable_native_version_and_fresh_source(self):
        path, model, server = self.prepare_page_fixture()
        original = self.store.read(path)
        self.platform.native_pages["PG-EDIT"] = {"bean": {"pageId": "PG-EDIT"}, "version": None}
        response = self.mcp_tool(server, "api_open_document", path=path)
        self.assertEqual("API_PAGE_NATIVE_VERSION_REQUIRED", response["error"]["code"])
        self.assertEqual(original, self.store.read(path))

        self.platform.native_pages["PG-EDIT"] = {"bean": model, "version": "v1"}
        page = self.platform.pages[0]
        page["fileName"] = "moved.xml"
        response = self.mcp_tool(server, "api_open_document", path=path)
        self.assertEqual("API_REMOTE_PATH_CHANGED", response["error"]["code"])
        self.assertEqual(original, self.store.read(path))
        page["fileName"] = "PG-EDIT.xml"

        request = self.platform.request
        target = self.store.root / path
        local = native_page.encode({**model, "title": "Changed while loading"})

        def change_during_read(endpoint, params=None, *, form=None):
            if endpoint == page_source.READ:
                target.chmod(0o600)
                target.write_bytes(local.encode())
            return request(endpoint, params, form=form)

        with patch.object(self.platform, "request", side_effect=change_during_read):
            response = self.mcp_tool(server, "api_open_document", path=path)
        self.assertEqual("API_SOURCE_STALE", response["error"]["code"])
        self.assertEqual(local, self.store.read(path)["content"])
        self.assertEqual(original["baseHash"], self.store.read(path)["baseHash"])
        self.assertFalse(self.store._conflict_path(path).exists())

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
        for phase in ("远端源码下载", "本地源码更新", "索引核对与更新"):
            self.assertTrue(any(f"{phase}结束 · 耗时" in line for line in logs))
        progress = [line for line in logs if "本地源码更新 · 已处理" in line]
        total = result["downloadedFiles"]
        self.assertEqual([
            f"[谷神 API] 本地源码更新 · 已处理 0/{total} 个文件",
            f"[谷神 API] 本地源码更新 · 已处理 {total}/{total} 个文件",
        ], progress)
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

    def test_page_menu_sync_validates_only_selected_systems_and_preserves_cache_on_failure(self):
        old_page = {"pageId": "PG-OLD", "pageSubId": "0F"}
        added_page = {"pageId": "PG-NEW", "pageSubId": "5F"}
        menu_pages = [old_page]
        menu = {"id": "group", "name": "Fixture group", "isDir": 1, "childs": [
            {"id": "entry", "name": "Fixture entry", "isDir": 0, "pages": menu_pages},
        ]}
        selected_menu = [{"systemId": "S1", "menus": [menu]}]
        self.platform.menu = [{"systemId": "S2"}, *selected_menu, {"systemId": "S3", "menus": []}]

        for page, action, selector in (
            (old_page, "pull", None),
            (added_page, "refresh", {"prefix": "systems/S1/pages"}),
        ):
            page_id = page["pageId"]
            self.platform.pages.append({
                **page, "pageType": 1, "fileName": f"{page_id}.xml", "versionMac": "v1",
                "xml": native_page.encode({"pageId": page_id, "title": "Fixture"}),
            })
            if page == added_page:
                menu_pages.append(page)
            self.platform.requests.clear()
            result = self.api(action, selector)
            self.assertTrue(result["downloadComplete"])
            self.assertNotIn("menuError", result)
            self.assertEqual(self.platform.requests.count((BASE + "getModuleTree.htm", None)), 1)
            catalog = self.api("catalog")
            self.assertIn(f"systems/S1/pages/{page['pageSubId']}/{page_id}/{page_id}.xml",
                          [obj["path"] for obj in catalog["objects"]])
            self.assertEqual(catalog["project"]["menuTree"], selected_menu)
            self.assertEqual(project_metadata(self.workspace, include_menu=True)["menuTree"], selected_menu)

        menu["name"] = "Renamed fixture group"
        result = self.api("pull")
        self.assertTrue(result["downloadComplete"])
        self.assertEqual(self.api("catalog")["project"]["menuTree"], selected_menu)

        self.api("scope-save", {"systemIds": ["S1"], "dataSourceIds": [], "allSystems": False})
        menu["name"] = "Menu after applying scope"
        result = self.api("pull")
        self.assertEqual(result["kind"], "scope-apply")
        self.assertTrue(result["downloadComplete"])
        self.assertNotIn("menuError", result)
        cached = self.api("catalog")["project"]["menuTree"]
        self.assertEqual(cached, selected_menu)

        self.assertEqual(self.api("system-menu")["menu"], {"list": self.platform.menu})
        self.assertEqual(project_metadata(self.workspace, include_menu=True)["menuTree"], cached)

        with patch.object(self.platform, "menu", [{"systemId": "S1"}]):
            result = self.api("pull")
            self.assertTrue(result["downloadComplete"])
            self.assertEqual(result["menuError"]["code"], "API_RESPONSE_INVALID")
            self.assertEqual(self.api("catalog")["project"]["menuTree"], cached)

        self.platform.menu_error = ApiError("API_HTTP_ERROR", "fixture menu unavailable")
        result = self.api("pull")
        self.assertTrue(result["downloadComplete"])
        self.assertEqual(result["menuError"]["code"], "API_HTTP_ERROR")
        self.assertEqual(self.api("catalog")["project"]["menuTree"], cached)

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

    def test_update_source_recovers_the_accepted_page_without_replaying_upload(self):
        page_id = "PG-RECOVER"
        path = f"systems/S1/pages/main/{page_id}/{page_id}.xml"
        metadata = {"systemId": "S1", "pageId": page_id, "pageSubId": "main",
                    "pageType": 1, "fileName": f"{page_id}.xml"}
        def page(field, *, native=False):
            search = {"type": "text", "id": "SEARCH-ID", "fieldId": "FILTER"}
            date = {"type": "datetime", "id": "DATE-ID", "fieldId": "CHANGE_TIME"}
            if native:
                search.update(isDisExtraSearch=0, pcAndH5=0)
                date.update(dataType="DATETIME", isDisExtraSearch=0)
                datasource, params = {"isProduct": 0}, {"isNeedSum": 0.0}
            else:
                search.update(isEndDate=0, isMust=0, selectBox={"forceSelection": 0})
                date.update(editable=0, isMust=0, selectBox={"forceSelection": 0})
                datasource, params = {}, {}
            return {"pageId": page_id, "pageType": 1, "views": {"rows": [
                {"component": {"type": "search-box", "fields": [search]}},
                {"component": {"type": "table-main", "fields": [field, date],
                               "datasource": datasource, "params": params}},
            ]}}

        field = {"id": "NATIVE-ID", "fieldId": "FIXTURE", "type": "text", "width": 120}
        base = page({**field, "width": 100}, native=True)
        candidate = page({**field, "editable": 0, "selectBox": {"forceSelection": 0}})
        accepted = page({**field, "isDisLabel": 0, "isDisExtraSearch": 0}, native=True)
        self.assertTrue(page_source.saved_model_matches(candidate, accepted))
        for row, parent, field_index, key, value in (
            (0, "fields", 0, "isMust", 1),
            (1, "fields", 1, "dataType", "DATE"),
            (1, "fields", 1, "selectBox", {"forceSelection": 0, "codeType": "configured"}),
            (1, "params", None, "isNeedSum", 1),
            (1, "datasource", None, "isProduct", 1),
        ):
            with self.subTest(key=key):
                changed = deepcopy(accepted)
                target = changed["views"]["rows"][row]["component"][parent]
                if field_index is not None:
                    target = target[field_index]
                target[key] = value
                self.assertFalse(page_source.saved_model_matches(candidate, changed))
        base_source = SourceFile(path, native_page.encode(base), "page", metadata)
        self.store.publish([page_source.as_file(page_source.Snapshot(base, "before"), base_source)])
        submitted = native_page.encode(candidate)
        (self.store.root / path).write_bytes(submitted.encode())
        operation_id = "123456789abcdef0123456789abcdef0"
        original = {
            "operationId": operation_id, "kind": "upload", "stage": "PARTIAL",
            "paths": [path, "unattempted.xml"],
            "results": [{"path": path, "stage": "UNKNOWN", "pageProtocol": "native-json",
                         "nativeAcceptedVersion": "accepted", "submittedHash": digest(submitted),
                         "submittedModelHash": page_source.fingerprint(candidate),
                         "code": "API_PAGE_NATIVE_READBACK_MISMATCH"}],
        }
        self.store._receipt(original)
        folder = self.store.directory / "operations" / operation_id
        (folder / ("submitted-" + digest(path) + ".txt")).write_bytes(submitted.encode())
        (folder / ("submitted-native-" + digest(path) + ".json")).write_text(json.dumps(candidate), encoding="utf-8")
        self.platform.pages = [{**metadata, "versionMac": "accepted", "xml": native_page.encode(accepted)}]
        ordinary_request = self.platform.request
        observed_version = "unrelated"
        self.platform.session = {"userId": "reader"}

        def request(endpoint, params=None, *, form=None):
            if endpoint in {page_source.INFO, page_source.READ}:
                self.assertEqual(form, {"pageId": page_id})
                if endpoint == page_source.INFO:
                    return {"page": {"pageId": page_id, "systemId": "S1", "checkOutUserId": "another-owner"}}
                return {"bean": accepted, "version": observed_version}
            return ordinary_request(endpoint, params, form=form)

        with patch.object(self.platform, "request", side_effect=request):
            mismatched = self.api("pull")
            self.assertEqual(mismatched["uploadRecovery"], [
                {"path": path, "operationId": operation_id, "code": "API_PAGE_NATIVE_READBACK_MISMATCH"},
            ])
            self.assertEqual(self.store.operation(operation_id), original)
            self.assertEqual(self.store.read(path)["content"], submitted)
            comparison = self.api("conflict", {"path": path, "view": "auto"})
            self.assertEqual(comparison["view"], "readable")
            self.assertEqual(comparison["totalChanges"], 0)
            with self.assertRaisesRegex(ApiError, "其他用户签出"):
                page_source.read(self.platform, metadata, check_info=True)

            observed_version = "accepted"
            result = self.api("pull")
        self.assertTrue(result["downloadComplete"])
        self.assertEqual(result["uploadState"], "NOT_PERFORMED")
        self.assertEqual(result["uploadRecovery"], [
            {"path": path, "operationId": operation_id, "stage": "REMOTE_READBACK_VERIFIED"},
        ])
        receipt = self.store.operation(operation_id)
        self.assertEqual(receipt["stage"], "PARTIAL")
        self.assertEqual(receipt["results"][0]["nativeRemoteVersion"], "accepted")
        self.assertEqual(receipt["results"][0]["stage"], "REMOTE_READBACK_VERIFIED")
        self.assertEqual(len(receipt["results"]), 1)
        current = self.store.read(path)
        self.assertEqual(current["sourceHash"], current["baseHash"])
        self.assertEqual(page_source.model(current["content"]), accepted)
