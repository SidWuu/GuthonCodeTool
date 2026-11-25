"""Support logs identify failures without copying request or source content."""

import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch
from urllib.error import URLError

from providers.api import progress
from providers.api.client import ApiError
from providers.api.download import SourceFile
from providers.api.store import ApiStore
from common import persistence
from test_provider_regressions import WorkspaceCase


class ApiProgressTest(unittest.TestCase):
    def test_platform_failure_reports_safe_connection_details_and_duration(self):
        lines = []
        endpoint = "/develop/vscode/source/download/getProcedures.htm"
        with progress.output_to(lines.append), progress.operation("projects.test", "pull"):
            with self.assertRaises(ApiError), progress.request(endpoint):
                raise ApiError("API_CONNECTION_FAILED", "private URL and request body") from URLError(
                    TimeoutError(110, "private system error text")
                )
        log = "\n".join(lines)
        self.assertRegex(log, rf"平台请求未完成 · {endpoint} · API_CONNECTION_FAILED · TimeoutError · errno=110 · 耗时 \d+ ms")
        self.assertNotIn("private", log)


class ApiStatusProgressTest(WorkspaceCase):
    def test_toolhost_accepts_windows_ctime_and_still_detects_handle_changes(self):
        workspace = self.register("api")
        key = workspace["workspaceKey"]
        self.tool("api", key=key, args=["configure"], payload={
            "serverUrl": "https://fixture.invalid/guthon/", "systemIds": ["S1"],
            "dataSourceIds": ["D1"], "allSystems": False,
        })
        source_path = "datasources/D1/procedures/audit/源码.gss"
        target = workspace["providerSourceRoot"] / source_path
        content = "#return('private fixture content')\n"
        ApiStore(workspace).publish([SourceFile(source_path, content, "procedure", {
            "dataSourceId": "D1", "procedureId": "P1", "procedureAliasId": "audit", "funId": "test",
        })])
        script = """
import os
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import patch

import guthon_tool

source = Path(sys.argv[2]).stat()
original_fstat = os.fstat
source_reads = 0

def windows_fstat(fd):
    global source_reads
    info = original_fstat(fd)
    if not os.path.samestat(info, source):
        return info
    source_reads += 1
    changed_after_read = sys.argv[3] == 'change' and source_reads % 2 == 0
    return SimpleNamespace(st_dev=info.st_dev, st_ino=info.st_ino, st_size=info.st_size,
                           st_mtime_ns=info.st_mtime_ns, st_ctime_ns=info.st_ctime_ns + 100 + 100 * changed_after_read)

with patch('providers.api.store.os.fstat', side_effect=windows_fstat):
    raise SystemExit(guthon_tool.main(['serve', '--stdio', '--home', sys.argv[1]]))
"""
        def status_request(identifier, *, summary_only):
            return json.dumps({"id": identifier, "command": "api", "args": ["status", "--stdin"],
                               "workspaceKey": key, "requestKind": "read", "input": {"summaryOnly": summary_only}})

        def request(mode):
            result = subprocess.run(
                [sys.executable, "-c", script, str(self.home), str(target), mode],
                cwd=Path(__file__).resolve().parents[2] / "scripts",
                input=status_request("summary", summary_only=True) + "\n" + status_request("scan", summary_only=False) + "\n",
                capture_output=True, encoding="utf-8", timeout=30, check=True,
            )
            self.assertNotIn("private fixture content", result.stdout + result.stderr)
            return list(map(json.loads, result.stdout.splitlines()))

        ready, summary, mismatch, failed = request("change")
        self.assertEqual(ready["type"], "ready")
        self.assertTrue(summary["ok"])
        self.assertEqual(summary["id"], "summary")
        self.assertEqual((mismatch["type"], mismatch["id"]), ("progress", "scan"))
        self.assertIn(f'{key} · "{source_path}" · 字段 st_ctime_ns · Python ', mismatch["message"])
        self.assertEqual(failed["error"]["code"], "API_SOURCE_STALE")
        self.assertEqual(failed["id"], "scan")
        _, summary, status = request("stable")
        self.assertTrue(summary["ok"])
        self.assertEqual(status["result"]["files"][0]["state"], "CLEAN")
        self.assertEqual(target.read_bytes(), content.encode())


class ApiPublicationJournalTest(WorkspaceCase):
    def test_interrupted_publish_recovers_progress_with_only_one_prepared_receipt(self):
        workspace = self.register("api")
        self.tool("api", key=workspace["workspaceKey"], args=["configure"], payload={
            "serverUrl": "https://fixture.invalid/guthon/", "systemIds": ["S1"],
            "dataSourceIds": ["D1"], "allSystems": False,
        })
        store = ApiStore(workspace)
        files = [SourceFile(f"datasources/D1/procedures/audit/{name}.gss", name, "procedure", {
            "dataSourceId": "D1", "procedureId": "P1", "procedureAliasId": "audit", "funId": name,
        }) for name in ("one", "two")]

        def fail_second(path, content):
            if path.name == "two.gss":
                raise PermissionError("fixture write failure")
            return persistence.atomic_bytes(path, content)

        with (patch.object(store, "_receipt", wraps=store._receipt) as write_receipt,
              patch("providers.api.store.atomic_bytes", side_effect=fail_second)):
            with self.assertRaisesRegex(PermissionError, "fixture write failure"):
                store.publish(files)
        self.assertEqual(write_receipt.call_count, 1)
        unfinished, = store.history()
        self.assertEqual(unfinished["stage"], "PREPARED")
        self.assertEqual(unfinished["applied"], [files[0].path])
        self.assertEqual(unfinished["current"]["path"], files[1].path)
        journal = store.directory / "operations" / unfinished["operationId"] / "publication.jsonl"
        with journal.open("ab") as handle:
            handle.write(b'{"applied":')
        self.assertEqual(store.operation(unfinished["operationId"]), unfinished)

        with patch.object(store, "_receipt", wraps=store._receipt) as write_receipt:
            result = store.publish(files)
        self.assertEqual(write_receipt.call_count, 2)
        finished = store.operation(result["operationId"])
        self.assertEqual(finished["stage"], "LOCAL_REFRESH_VERIFIED")
        self.assertEqual(finished["applied"], [source.path for source in files])

    def test_windows_temporary_replace_denial_keeps_old_content_until_retry(self):
        target = self.home / "fixture.json"
        target.write_bytes(b"old")
        original_replace = os.replace
        error = PermissionError("fixture sharing denial")
        error.winerror = 5

        def replace(source, destination):
            self.assertEqual(target.read_bytes(), b"old")
            if retry.call_count == 1:
                raise error
            return original_replace(source, destination)

        with (patch("common.persistence.os.replace", side_effect=replace) as retry,
              patch("common.persistence.time.sleep") as delay):
            persistence.atomic_bytes(target, b"new")
        self.assertEqual(target.read_bytes(), b"new")
        delay.assert_called_once_with(0.05)
