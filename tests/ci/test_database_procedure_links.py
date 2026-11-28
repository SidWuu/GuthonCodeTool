"""Exercise shared DATABASE procedure mirrors with local filesystem links."""

from contextlib import closing, nullcontext
import os
from pathlib import Path
from unittest.mock import Mock, patch

from common import gusen_hub, legacy_source
from common.command_errors import CommandError
from common.directory_links import create_directory_link, is_directory_link
from test_provider_regressions import WorkspaceCase


class DatabaseProcedureLinksTest(WorkspaceCase):
    def setUp(self):
        super().setUp()
        self.workspace = self.register("database")
        self.config = gusen_hub.load_config()
        self.config["datasource"]["datasource"]["fixture"] = {}
        self.layer_config = {"datasource": "fixture", "include": {"all": True}}
        self.systems = [
            {"SYSTEM_ID": key, "SYSTEM_ALIAS_ID": key, "SYSTEM_NAME": name, "DATA_SOURCE_ID": "shared"}
            for key, name in (("one", "示例系统 甲"), ("two", "示例系统 乙"))
        ]
        self.primary, self.alias = (
            self.workspace["readonlyDir"] / system["SYSTEM_NAME"] / "procedure" for system in self.systems
        )
        self.relative_script = Path("fixtureProcedure/run/source.vm")
        self.conn = self.enterContext(closing(legacy_source.connect_index_for_workspace(self.workspace)))

    def row(self, version):
        return {
            "source_table": "procedure", "source_id": "PROC-1", "source_alias_id": "fixtureProcedure",
            "fun_id": "run", "source_name": "Fixture", "data_source_id": "shared",
            "source_content": f"return {version};", "version_mac": str(version),
        }

    def sync(self, selected, version):
        cursor = Mock()
        cursor.fetchall.side_effect = [[], [self.row(version)], []]
        remote = Mock()
        remote.cursor.return_value = nullcontext(cursor)
        scope = legacy_source._build_system_scope(self.systems, selected)
        with (
            patch.object(legacy_source, "db_connect", return_value=nullcontext(remote)),
            patch.object(legacy_source, "resolve_system_scope", return_value=scope),
            patch.object(legacy_source, "load_model_paths", return_value={}),
        ):
            return legacy_source._sync_layer(
                self.conn, self.config, self.layer_config, self.workspace["layer"], self.workspace["scopeId"],
                self.workspace["projectId"], "2026-01-01 00:00:00", {"changed": 0, "candidates": 0}, self.workspace,
            )

    def read(self, directory):
        return (directory / self.relative_script).read_text(encoding="utf-8")

    def assert_link(self, link, target):
        self.assertTrue(os.path.isjunction(link) if os.name == "nt" else link.is_symlink())
        self.assertEqual(link.resolve(), target.resolve())

    def test_sync_creates_and_repairs_alias_and_keeps_existing_workcopy(self):
        with patch("os.symlink", side_effect=OSError(1314, "symlink denied")) if os.name == "nt" else nullcontext():
            self.assertEqual(self.sync(["one", "two"], 1)["changed"], 1)
            self.assert_link(self.alias, self.primary)

            workcopy = legacy_source.create_work_copy_from_row(self.conn, self.config, self.row(1), self.workspace)
            workcopy_file = Path(workcopy["path"]) / "source.vm"
            self.assertEqual(workcopy_file.read_text(encoding="utf-8"), "return 1;")
            workcopy_file.write_text("return 42;", encoding="utf-8")

            if os.name == "nt":
                self.alias.rmdir()
            else:
                self.alias.unlink()
            self.assertEqual(self.sync(["one", "two"], 1)["changed"], 0)
            self.assert_link(self.alias, self.primary)
            self.sync(["one", "two"], 2)

        self.assertEqual(self.read(self.alias), "return 2;")
        self.assertEqual(workcopy_file.read_text(encoding="utf-8"), "return 42;")
        self.assertEqual(
            legacy_source._work_copy_source_relative_path((self.alias / self.relative_script).parent, self.workspace),
            Path(workcopy["path"]).relative_to(self.workspace["workcopyDir"]),
        )

    def test_existing_relative_symlink_is_reused(self):
        self.sync(["one"], 1)
        self.alias.parent.mkdir(parents=True)
        try:
            self.alias.symlink_to(os.path.relpath(self.primary, self.alias.parent), target_is_directory=True)
        except OSError as error:
            if getattr(error, "winerror", None) == 1314:
                self.skipTest("Windows account cannot create the legacy symlink fixture")
            raise
        with patch.object(legacy_source, "create_directory_link", side_effect=AssertionError("existing alias replaced")):
            self.sync(["one", "two"], 2)
        self.assertTrue(self.alias.is_symlink())
        self.assertEqual(self.read(self.alias), "return 2;")

    def test_scope_switch_rolls_back_a_created_link_then_retries(self):
        self.sync(["one", "two"], 1)

        def fail_after_creation(link, target):
            create_directory_link(link, target)
            raise OSError("simulated alias failure after creation")

        with patch.object(legacy_source, "create_directory_link", side_effect=fail_after_creation):
            with self.assertRaises(CommandError) as failure:
                self.sync(["two", "one"], 2)
        self.assertEqual(failure.exception.error_code, "DATABASE_PROCEDURE_LINK_FAILED")
        self.assert_link(self.alias, self.primary)
        self.assertFalse(is_directory_link(self.primary))
        self.assertEqual(self.read(self.primary), "return 1;")
        indexed = self.conn.execute("SELECT change_key FROM gusen_source_record").fetchone()
        self.assertEqual(indexed["change_key"], "VERSION:1")

        self.sync(["two", "one"], 2)
        self.assert_link(self.primary, self.alias)
        self.assertEqual(self.read(self.primary), "return 2;")
        self.sync(["two"], 3)
        self.assertFalse(os.path.lexists(self.primary))
        self.assertEqual(self.read(self.alias), "return 3;")

    def test_targeted_upsert_preserves_occupied_alias_path(self):
        self.sync(["one"], 1)
        self.alias.mkdir(parents=True)
        local = self.alias / "local.vm"
        local.write_text("manual content", encoding="utf-8")
        scope = legacy_source._build_system_scope(self.systems, ["one", "two"])

        def upsert(version):
            with legacy_source.source_transaction(self.conn, self.workspace):
                return legacy_source.upsert_source(
                    self.conn, self.row(version), self.workspace["layer"], self.workspace["scopeId"],
                    self.workspace["projectId"], self.layer_config, scope, workspace=self.workspace,
                )

        with self.assertRaises(CommandError) as failure:
            upsert(2)
        self.assertEqual(failure.exception.error_code, "DATABASE_SCOPE_PATH_OCCUPIED")
        self.assertEqual(self.read(self.primary), "return 1;")
        self.assertEqual(local.read_text(encoding="utf-8"), "manual content")

        local.unlink()
        self.alias.rmdir()
        external = self.home / "external" / "procedure"
        external.mkdir(parents=True)
        create_directory_link(self.alias, external)
        with self.assertRaises(CommandError) as failure:
            upsert(2)
        self.assertEqual(failure.exception.error_code, "DATABASE_SCOPE_PATH_OCCUPIED")
        self.assert_link(self.alias, external)
        self.assertEqual(self.read(self.primary), "return 1;")

        if os.name == "nt":
            self.alias.rmdir()
        else:
            self.alias.unlink()
        self.assertFalse(upsert(1))
        self.assert_link(self.alias, self.primary)
