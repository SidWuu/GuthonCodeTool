"""Fixture for the Nexus/Bridge offline DATABASE publication integration test."""
from contextlib import closing, nullcontext
import json
from pathlib import Path
import sys
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "scripts"))

import guthon_tool
from common import config_store, gusen_hub, legacy_source
from common.database_node_sync import sync_verified_source
from common.runtime_paths import runtime_home_context


def setup(home):
    for args in (["setup", "--no-team-sync"], ["workspace-create"]):
        with patch("sys.stdin") as stdin:
            stdin.read.return_value = json.dumps({"id": "database-fixture", "name": "Fixture", "sourceMode": "database"})
            guthon_tool.main([*args, "--home", str(home)])
    document = config_store.read(home)
    key, = document["workspaces"]
    document["workspaces"][key].update(
        page_origins=["https://platform.test"], systems={"include": {
            "mappings": {"fixture": {"system_id": "SYS-1", "data_source_id": "DS-1"}},
        }},
    )
    config_store.write(home, document)
    cache = {"datasources": {"": {"systems": [{
        "SYSTEM_ID": "SYS-1", "SYSTEM_NAME": "Fixture", "SYSTEM_ALIAS_ID": "fixture", "DATA_SOURCE_ID": "DS-1",
    }]}}}
    (home / "config" / "system-data.json").write_text(json.dumps(cache), encoding="utf-8")
    config = gusen_hub.load_config()
    workspace = gusen_hub.resolve_workspace(config, key)
    scope = legacy_source.resolve_system_scope(None, config, "", workspace, allow_remote=False)
    row = {"source_table": "procedure", "source_id": "FN-ROW", "fun_id": "sample",
           "source_alias_id": "pkg.fixture", "source_name": "Sample", "system_id": "SYS-1",
           "data_source_id": "DS-1", "source_content": "#return('old')", "version_mac": "db-v1"}
    with closing(legacy_source.connect_index_for_workspace(workspace)) as conn, conn:
        legacy_source.upsert_source(conn, row, workspace["layer"], workspace["scopeId"],
                                    workspace["projectId"], workspace["config"], scope, workspace=workspace)
        for page_id, page_type in (("PG-FORM", 1), ("PG-SERVICE", 0)):
            model = {"pageId": page_id, "pageType": page_type,
                     "compScript": "#return('old')", "runInTran": 1}
            if page_type:
                model["buttons"] = [{"id": "SAVE", "bntType": "save", "name": "Before"}]
                model["views"] = {"rows": [{"style": {}, "component": {
                    "fields": [{"fieldId": "FORM_FIELD", "type": "text"}],
                    "datasource": {"fields": [{"fieldId": "FORM_FIELD"}]},
                    "params": {"isAutoLoad": 1.0},
                }}]}
            else:
                model["pageAliasId"] = page_id
            page = {"source_table": "page", "source_id": page_id, "fun_id": "",
                    "source_alias_id": model.get("pageAliasId"), "source_name": page_id, "system_id": "SYS-1",
                    "source_content": json.dumps(model), "version_mac": "page-v1"}
            legacy_source.upsert_source(conn, page, workspace["layer"], workspace["scopeId"],
                                        workspace["projectId"], workspace["config"], scope, workspace=workspace)
            (home / f"{page_id}.json").write_text(json.dumps(page), encoding="utf-8")
        conn.execute("INSERT OR REPLACE INTO gusen_sync_state(state_key,state_value) VALUES('last_success_time','unchanged')")
    (home / "database-fixture.json").write_text(json.dumps(row), encoding="utf-8")
    print(json.dumps(gusen_hub.workspace_summary(gusen_hub.load_config(), workspace)))


def refresh(home):
    evidence = json.load(sys.stdin)
    config = gusen_hub.load_config()
    workspace = gusen_hub.resolve_workspace(config, evidence["workspaceKey"])
    identity = evidence["databaseIdentity"]
    is_page = identity["source_table"] == "page"
    row_file = f"{identity['source_id']}.json" if is_page else "database-fixture.json"
    row = json.loads((home / row_file).read_text(encoding="utf-8"))
    if not is_page:
        row.pop("system_id")  # The real exact procedure query does not select it.
    remote = MagicMock()
    cursor = remote.cursor.return_value.__enter__.return_value
    cursor.fetchall.return_value = [row]
    # This explicit fixture association models the missing real-platform
    # native-version to database-version evidence.
    assert evidence["version"] == ("page-v2" if is_page else "native-v2")
    version = evidence["version"] if is_page else "db-v2"
    with (patch.object(legacy_source, "resolve_datasource", return_value=("", {})),
          patch.object(legacy_source, "db_connect", return_value=nullcontext(remote)),
          patch.object(legacy_source, "_included", return_value=True),
          patch.object(legacy_source, "load_model_paths", return_value={})):
        result = sync_verified_source(workspace, config, identity,
                                      base_version=evidence["baseVersion"], database_version=version,
                                      content=evidence["content"], advance_workcopy=True,
                                      reviewed_workcopy_hash=evidence.get("reviewedWorkcopyHash"),
                                      merged_workcopy=evidence.get("mergedWorkcopy") is True,
                                      platform_differs=evidence.get("platformDiffers") is True)
    expected = [version, identity["source_id"], identity["source_alias_id"], "SYS-1"] if is_page else [
        "db-v2", "FN-ROW", "sample", "pkg.fixture", "DS-1"]
    assert cursor.execute.call_args.args[1] == expected
    if is_page:
        assert "COALESCE(NULLIF(p.PAGE_ALIAS_ID, ''), p.PAGE_ID)" in cursor.execute.call_args.args[0]
    with closing(legacy_source.connect_index_for_workspace(workspace)) as conn:
        assert conn.execute("SELECT state_value FROM gusen_sync_state WHERE state_key='last_success_time'").fetchone()[0] == "unchanged"
    print(json.dumps(result))


if __name__ == "__main__":
    action, root = sys.argv[1:]
    home = Path(root).resolve()
    with runtime_home_context(home):
        {"setup": setup, "refresh": refresh}[action](home)
