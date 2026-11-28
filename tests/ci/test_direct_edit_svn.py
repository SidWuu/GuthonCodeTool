"""Real local SVN coverage for physical direct edits and local change discovery."""

from contextlib import closing
import hashlib
import json
from pathlib import Path
import subprocess
from unittest.mock import patch

from common import gusen_hub, legacy_source
from providers.svn import checkout, direct_edit
from providers.svn.nexus import incremental
from test_provider_regressions import WorkspaceCase


def svn(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True)


class DirectEditSvnTest(WorkspaceCase):
    def setUp(self):
        super().setUp()
        self.prepare_svn_fixture()

    def prepare_svn_fixture(self):
        workspace = self.register("svn")
        self.repository = self.home / "repository"
        self.seed = self.home / "seed"
        self.relative = Path("systems/SYS/system-script/main.js")
        samples = {
            Path("info.json"): '{"proId":"fixture"}',
            Path("system-script/SYS/legacy.js"): "return 'legacy';\n",
            Path("pages/SYS/LEGACY-PAGE.gss"): "/**\n * @pageId LEGACY-PAGE\n */\nreturn 1;\n",
            Path("procedures/DS/legacy/persist.gss"): "/**\n * @packageId legacy\n * @functionId persist\n */\nreturn 1;\n",
            self.relative: "return 'initial';\n",
            Path("systems/SYS/pages/PG.json"): '{"pageId":"PG"}',
            Path("systems/SYS/pages/PG.inherit.gss"): "return 'parent';\n",
            Path("systems/SYS/pages/PG.gss"): "/**\n * @pageId PG-GSS\n */\nreturn 1;\n",
            Path("datasources/DS/procedures/pkg/save.gss"): "/**\n * @packageId pkg\n * @functionId save\n */\nreturn 1;\n",
            Path("datasources/DS/procedures/pkg/inherit.gss"): "/**\n * @packageId pkg\n * @functionId inherit\n */\n@inherit();\n",
            Path("datasources/DS/procedures/pkg/inherit.inherit.gss"): "/**\n * @packageId pkg\n * @functionId inherit\n */\nparent_before();\n",
            Path("systems/SYS/system-script/other.js"): "return 'other';\n",
        }
        for relative, content in samples.items():
            target = self.seed / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
        svn("svnadmin", "create", str(self.repository))
        self.url = self.repository.as_uri()
        svn("svn", "import", str(self.seed), self.url, "-m", "seed")
        config_path = self.home / "config/guthon.json"
        config = json.loads(config_path.read_text())
        config["workspaces"][workspace["workspaceKey"]]["svn"] = {"url": self.url}
        config_path.write_text(json.dumps(config), encoding="utf-8")
        manifest = workspace["svn"]["scopeManifestPath"]
        manifest.write_text(json.dumps({
            "schemaVersion": 1, "workspaceKey": workspace["workspaceKey"],
            "entries": [{"id": "root", "category": "root", "url": self.url,
                         "localSubdir": ".", "writable": True}],
        }), encoding="utf-8")
        self.workspace = gusen_hub.resolve_workspace(gusen_hub.load_config(), workspace["workspaceKey"])
        self.checkout = self.workspace["checkoutPath"]
        svn("svn", "checkout", self.url, str(self.checkout))
        with closing(legacy_source.connect_index_for_workspace(self.workspace)) as conn:
            result = legacy_source.index_svn_workspace(conn, gusen_hub.load_config(), self.workspace)
        self.assertFalse(result.get("failures"), result)
        self.path = self.checkout / self.relative

    def test_registered_file_refresh_and_index_visibility_including_no_diff(self):
        initial = self.path.read_bytes()
        before = direct_edit.inspect_file(self.workspace, self.path, refresh=False)
        self.assertEqual(before, {"sourceHash": hashlib.sha256(initial).hexdigest(), "modified": False})
        same = direct_edit.inspect_file(self.workspace, self.path, refresh=True)
        self.assertEqual(same["indexedHash"], before["sourceHash"])
        self.path.write_bytes(b"return 'indexed_marker';\n")
        result = direct_edit.inspect_file(self.workspace, self.path, refresh=True)
        digest = hashlib.sha256(self.path.read_bytes()).hexdigest()
        self.assertEqual(result, {"sourceHash": digest, "indexedHash": digest, "modified": True})
        with legacy_source.index_connection(self.workspace, action="fixture", readonly=True) as conn:
            row = conn.execute("SELECT source_hash FROM gusen_source_record WHERE source_path=?", (self.relative.as_posix(),)).fetchone()
            self.assertEqual(row[0], digest)
            scripts = conn.execute("SELECT content_hash FROM gusen_source_fragment WHERE content_hash=?", (digest,)).fetchall()
            self.assertTrue(scripts)
        self.path.write_bytes(initial)
        clean = direct_edit.inspect_file(self.workspace, self.path, refresh=True)
        self.assertFalse(clean["modified"])
        self.assertEqual(clean["sourceHash"], clean["indexedHash"])
        procedure = self.checkout / "datasources/DS/procedures/pkg/save.gss"
        self.assertFalse(direct_edit.inspect_file(self.workspace, procedure, refresh=False)["modified"])

    def assert_repeat_refresh_is_stable(self, workspace, path):
        logical = path.relative_to(workspace["checkoutPath"]).as_posix()

        def snapshot():
            with legacy_source.index_connection(workspace, action="fixture", readonly=True) as conn:
                row = conn.execute("SELECT record_id, source_hash, status, indexed_time FROM gusen_source_record "
                                   "WHERE provider='svn' AND source_path=?", (logical,)).fetchone()
                fragments = [tuple(item) for item in conn.execute(
                    "SELECT fragment_id, content_hash, origin_map_json FROM gusen_source_fragment "
                    "WHERE source_record_id=? ORDER BY fragment_id", (row["record_id"],))]
                generations = [tuple(item) for item in conn.execute(
                    "SELECT state_key, state_value FROM gusen_sync_state WHERE state_key IN "
                    "('source_catalog_generation', 'page_semantic_generation') ORDER BY state_key")]
            files = {}
            for file in workspace["contextDir"].rglob("*"):
                if file.is_file() and file.name != ".svn-operation.lock":
                    files[str(file.relative_to(workspace["contextDir"]))] = (
                        file.stat().st_mtime_ns, hashlib.sha256(file.read_bytes()).hexdigest(),
                    )
            return tuple(row), fragments, generations, files

        original = path.read_bytes()
        for content, modified, status in ((original, False, "OK"),
                                          (original + b"\n// external edit\n", True, "SVN_DIRTY"),
                                          (original, False, "OK")):
            path.write_bytes(content)
            first = direct_edit.inspect_file(workspace, path, refresh=True)
            self.assertEqual(first["modified"], modified)
            before = snapshot()
            self.assertEqual(before[0][2], status)
            second = direct_edit.inspect_file(workspace, path, refresh=True)
            self.assertEqual(second, first)
            self.assertEqual(snapshot(), before)

        before = snapshot()
        svn("svn", "propset", "fixture:marker", "value", str(path))
        direct_edit.inspect_file(workspace, path, refresh=True)
        with_property = snapshot()
        self.assertEqual(with_property[0][2], "SVN_DIRTY")
        self.assertNotEqual(with_property[2], before[2])
        direct_edit.inspect_file(workspace, path, refresh=True)
        self.assertEqual(snapshot(), with_property)
        svn("svn", "propdel", "fixture:marker", str(path))
        direct_edit.inspect_file(workspace, path, refresh=True)
        restored = snapshot()
        self.assertEqual(restored[0][2], "OK")
        self.assertNotEqual(restored[2], with_property[2])
        direct_edit.inspect_file(workspace, path, refresh=True)
        self.assertEqual(snapshot(), restored)

    def test_manifest_repeat_refresh_keeps_index_and_derived_files(self):
        self.assert_repeat_refresh_is_stable(self.workspace, self.path)

    def test_legacy_repeat_refresh_keeps_index_and_derived_files(self):
        workspace, _default, path = self.prepare_legacy_fixture()
        self.assert_repeat_refresh_is_stable(workspace, path)

    def test_manifest_refresh_updates_changed_inheritance_with_unchanged_child(self):
        child = self.checkout / "datasources/DS/procedures/pkg/inherit.gss"
        parent = child.with_name("inherit.inherit.gss")
        original_hash = hashlib.sha256(child.read_bytes()).hexdigest()
        parent.write_text(parent.read_text().replace("parent_before", "parent_after"))
        result = direct_edit.inspect_file(self.workspace, child, refresh=True)
        self.assertEqual(result["indexedHash"], original_hash)
        with legacy_source.index_connection(self.workspace, action="fixture", readonly=True) as conn:
            row = conn.execute("SELECT record_id FROM gusen_source_record WHERE source_path=?",
                               (child.relative_to(self.checkout).as_posix(),)).fetchone()
            body = conn.execute("SELECT content FROM source_body_content WHERE source_record_id=?",
                                (row["record_id"],)).fetchone()
            self.assertIn("parent_after", body["content"])

    def test_rejects_unsupported_and_stale_identity(self):
        for relative in ("systems/SYS/pages/PG.json", "systems/SYS/pages/PG.inherit.gss"):
            with self.subTest(relative=relative), self.assertRaisesRegex(ValueError, "不支持直接编辑|不可写"):
                direct_edit.inspect_file(self.workspace, self.checkout / relative, refresh=False)
        untracked = self.path.with_name("new.js")
        untracked.write_text("return 0;\n")
        with self.assertRaises((SystemExit, ValueError)):
            direct_edit.inspect_file(self.workspace, untracked, refresh=False)
        self.path.write_text("return 'unindexed';\n")
        current = direct_edit.inspect_file(self.workspace, self.path, refresh=False)
        self.assertTrue(current["modified"])
        self.assertEqual(current["sourceHash"], hashlib.sha256(self.path.read_bytes()).hexdigest())
        self.assertEqual(direct_edit.inspect_file(self.workspace, self.path, refresh=True)["indexedHash"], current["sourceHash"])
        procedure = self.checkout / "datasources/DS/procedures/pkg/save.gss"
        procedure.write_text(procedure.read_text().replace("@functionId save", "@functionId changed"))
        with self.assertRaisesRegex(ValueError, "无法索引|身份"):
            direct_edit.inspect_file(self.workspace, procedure, refresh=True)

    def test_watcher_reindex_cannot_authorize_changed_base_identity(self):
        paths = (
            ("datasources/DS/procedures/pkg/save.gss", "@packageId pkg", "@packageId other"),
            ("systems/SYS/pages/PG.gss", "@pageId PG-GSS", "@pageId PG-OTHER"),
        )
        for relative, before, after in paths:
            with self.subTest(path=relative):
                path = self.checkout / relative
                path.write_text(path.read_text().replace(before, after))
                with legacy_source.index_connection(self.workspace, action="watcher", readonly=False) as conn:
                    result = incremental.reindex_changed_files(conn, self.workspace, [relative])
                self.assertFalse(result["failures"], result)
                self.assertEqual(result["changed"], 1)
                for refresh in (False, True):
                    with self.assertRaisesRegex(ValueError, "身份与 BASE 版本不一致"):
                        direct_edit.inspect_file(self.workspace, path, refresh=refresh)

    def test_svn_line_ending_translation_keeps_clean_status(self):
        remote = self.home / "eol-checkout"
        svn("svn", "checkout", self.url, str(remote))
        svn("svn", "propset", "svn:eol-style", "CRLF", str(remote / self.relative))
        svn("svn", "commit", str(remote / self.relative), "-m", "set eol")
        svn("svn", "update", str(self.checkout))
        self.assertIn(b"\r\n", self.path.read_bytes())
        result = direct_edit.inspect_file(self.workspace, self.path, refresh=True)
        self.assertFalse(result["modified"])
        self.assertEqual(result["indexedHash"], hashlib.sha256(self.path.read_bytes()).hexdigest())

    def test_conflict_and_active_editor_are_denied(self):
        session = self.workspace["contextDir"] / "svn-edit-session.json"
        session.write_text(json.dumps({"version": 1, "workspaceKey": self.workspace["workspaceKey"],
            "sessionId": "fixture", "files": {}, "documents": {"doc": {"sourcePath": self.relative.as_posix()}},
            "pageEditTokens": {}, "procedureEditTokens": {}}))
        with self.assertRaisesRegex(ValueError, "活动的 Nexus 编辑租约"):
            direct_edit.inspect_file(self.workspace, self.path, refresh=False)
        session.unlink()
        remote = self.home / "remote"
        svn("svn", "checkout", self.url, str(remote))
        (remote / self.relative).write_text("return 'remote';\n")
        svn("svn", "commit", str(remote / self.relative), "-m", "remote")
        self.path.write_text("return 'local';\n")
        svn("svn", "update", str(self.checkout))
        with self.assertRaisesRegex(ValueError, "冲突|不可编辑"):
            direct_edit.inspect_file(self.workspace, self.path, refresh=True)

    def test_changed_files_reports_unindexed_added_deleted_and_content_changes(self):
        self.assertEqual(direct_edit.changed_files(self.workspace), {})
        self.path.write_text("return 'changed';\n")
        extra = self.path.with_name("unregistered.js")
        extra.write_text("return 1;\n")
        nested = self.checkout / "unregistered-folder/nested.js"
        nested.parent.mkdir()
        nested.write_text("return 2;\n")
        deleted = self.path.with_name("other.js")
        deleted.unlink()
        changes = direct_edit.changed_files(self.workspace)
        self.assertEqual(set(changes), {str(self.path), str(extra), str(deleted), str(nested.parent), str(nested)})
        self.path.write_text("return 'changed again';\n")
        self.assertNotEqual(changes[str(self.path)], direct_edit.changed_files(self.workspace)[str(self.path)])
        svn("svn", "add", str(extra))
        self.assertIn(str(extra), direct_edit.changed_files(self.workspace))

    def test_capabilities_and_uninitialized_scope(self):
        self.workspace["capabilities"]["svn.edit"] = False
        with self.assertRaisesRegex(SystemExit, "svn.edit"):
            direct_edit.inspect_file(self.workspace, self.path, refresh=False)
        self.workspace["svn"]["checkoutLayout"] = "legacy-sparse"
        self.workspace["svn"]["repositoryUrl"] = self.url
        self.path.write_text("return 'legacy';\n")
        self.assertIn(str(self.path), direct_edit.changed_files(self.workspace))
        self.workspace["checkoutPath"] = self.home / "missing-checkout"
        self.assertEqual(direct_edit.changed_files(self.workspace), {})

    def prepare_legacy_fixture(self):
        config_path = self.home / "config/guthon.json"
        config = json.loads(config_path.read_text())
        record = config["workspaces"][self.workspace["workspaceKey"]]
        record["systems"] = {"include": {"mappings": {
            "fixture": {"system_id": "SYS", "data_source_id": "DS"},
        }}}
        record["svn"] = {
            "repository_url": self.url, "checkout_layout": "legacy-sparse",
            "include": ["pages", "procedures", "system-script"],
        }
        config_path.write_text(json.dumps(config), encoding="utf-8")
        default = gusen_hub.resolve_workspace(gusen_hub.load_config(), self.workspace["workspaceKey"])
        self.assertFalse(default["capabilities"]["svn.edit"])
        record["svn"]["capabilities"] = {"browse": True, "edit": True}
        config_path.write_text(json.dumps(config), encoding="utf-8")
        workspace = gusen_hub.resolve_workspace(gusen_hub.load_config(), self.workspace["workspaceKey"])
        fingerprint, _metadata = checkout._repository_fingerprint(workspace, checkout.svn_info(self.checkout))
        scope = checkout.scope_manifest(workspace)
        scope["repositoryFingerprint"] = fingerprint
        checkout.scope_path(workspace).write_text(json.dumps(scope), encoding="utf-8")
        path = self.checkout / "system-script/SYS/legacy.js"
        with closing(legacy_source.connect_index_for_workspace(workspace)) as conn:
            indexed = legacy_source.index_svn_workspace(conn, gusen_hub.load_config(), workspace)
            self.assertEqual(indexed["failures"], 0)
        return workspace, default, path

    def test_legacy_sparse_registered_file_refresh_preserves_writeback_rules(self):
        workspace, default, path = self.prepare_legacy_fixture()
        with self.assertRaisesRegex(SystemExit, "svn.browse|svn.edit"):
            direct_edit.inspect_file(default, path, refresh=False)
        initial = path.read_bytes()
        with patch.object(checkout, "run_remote_svn", side_effect=AssertionError("unexpected remote SVN")):
            self.assertFalse(direct_edit.inspect_file(workspace, path, refresh=False)["modified"])
            self.assertEqual(direct_edit.inspect_file(workspace, path, refresh=True)["indexedHash"],
                             hashlib.sha256(initial).hexdigest())
            path.write_bytes(b"return 'external_legacy';\n")
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            self.assertEqual(digest, direct_edit.inspect_file(workspace, path, refresh=False)["sourceHash"])
            result = direct_edit.inspect_file(workspace, path, refresh=True)
            self.assertEqual(result, {"sourceHash": digest, "indexedHash": digest, "modified": True})
            with legacy_source.index_connection(workspace, action="fixture", readonly=True) as conn:
                row = conn.execute("SELECT source_hash FROM gusen_source_record WHERE source_path=?",
                                   ("system-script/SYS/legacy.js",)).fetchone()
                self.assertEqual(row["source_hash"], digest)
                self.assertIsNotNone(conn.execute("SELECT 1 FROM gusen_source_fragment WHERE content_hash=?",
                                                 (digest,)).fetchone())
            self.assertFalse((workspace["contextDir"] / checkout.EXPECTED_WRITEBACK_FILE).exists())
            with closing(legacy_source.connect_index_for_workspace(workspace)) as conn:
                rejected = legacy_source.index_svn_workspace(conn, gusen_hub.load_config(), workspace)
                self.assertGreater(rejected["failures"], 0)
                self.assertIn("unexpected SVN", str(rejected["errors"]))
            path.write_bytes(initial)
            self.assertFalse(direct_edit.inspect_file(workspace, path, refresh=True)["modified"])
        self.assertEqual("1", svn("svnlook", "youngest", str(self.repository)).stdout.strip())

    def test_legacy_sparse_page_and_procedure_refresh(self):
        workspace, _default, _path = self.prepare_legacy_fixture()
        for relative in ("pages/SYS/LEGACY-PAGE.gss", "procedures/DS/legacy/persist.gss"):
            with self.subTest(path=relative):
                path = self.checkout / relative
                path.write_text(path.read_text().replace("return 1;", "return 2;"))
                digest = hashlib.sha256(path.read_bytes()).hexdigest()
                self.assertEqual(direct_edit.inspect_file(workspace, path, refresh=True),
                                 {"sourceHash": digest, "indexedHash": digest, "modified": True})
                with legacy_source.index_connection(workspace, action="fixture", readonly=True) as conn:
                    row = conn.execute("SELECT source_hash FROM gusen_source_record WHERE source_path=?",
                                       (relative,)).fetchone()
                    self.assertEqual(row["source_hash"], digest)

    def test_legacy_sparse_base_identity_and_scope_are_verified(self):
        workspace, _default, _path = self.prepare_legacy_fixture()
        for relative, old, new, reindexed_id in (
            ("pages/SYS/LEGACY-PAGE.gss", "@pageId LEGACY-PAGE", "@pageId CHANGED", "CHANGED"),
            ("procedures/DS/legacy/persist.gss", "@packageId legacy", "@packageId changed", "changed#persist"),
        ):
            with self.subTest(path=relative):
                path = self.checkout / relative
                original = path.read_text()
                path.write_text(original.replace(old, new))
                with self.assertRaisesRegex(ValueError, "身份与 BASE 版本不一致"):
                    direct_edit.inspect_file(workspace, path, refresh=True)
                with legacy_source.index_connection(workspace, action="fixture", readonly=False) as conn:
                    row = conn.execute("SELECT source_id FROM gusen_source_record WHERE source_path=?",
                                       (relative,)).fetchone()
                    original_id = row["source_id"]
                    conn.execute("UPDATE gusen_source_record SET source_id=? WHERE source_path=?", (reindexed_id, relative))
                    conn.commit()
                with self.assertRaisesRegex(ValueError, "身份与 BASE 版本不一致"):
                    direct_edit.inspect_file(workspace, path, refresh=True)
                with legacy_source.index_connection(workspace, action="fixture", readonly=False) as conn:
                    conn.execute("UPDATE gusen_source_record SET source_id=? WHERE source_path=?", (original_id, relative))
                    conn.commit()
                path.write_text(original)
        untracked = self.checkout / "system-script/SYS/new.js"
        untracked.write_text("return 1;\n")
        with self.assertRaises((SystemExit, ValueError)):
            direct_edit.inspect_file(workspace, untracked, refresh=False)
        scope_path = checkout.scope_path(workspace)
        scope = json.loads(scope_path.read_text())
        scope["mappingHash"] = "different"
        scope_path.write_text(json.dumps(scope))
        with self.assertRaisesRegex(ValueError, "范围与当前登记配置不一致"):
            direct_edit.inspect_file(workspace, self.checkout / "system-script/SYS/legacy.js", refresh=False)
        scope["mappingHash"] = checkout.scope_manifest(workspace)["mappingHash"]
        scope["repositoryFingerprint"] = "different"
        scope_path.write_text(json.dumps(scope))
        with self.assertRaisesRegex(SystemExit, "fingerprint changed"):
            direct_edit.inspect_file(workspace, self.checkout / "system-script/SYS/legacy.js", refresh=False)
