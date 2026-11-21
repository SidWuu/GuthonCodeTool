"""Read existing SVN and DATABASE workspace state without changing its format."""
import hashlib
import json
import sqlite3


def workspace_steps(workspace):
    from common import legacy_source as hub
    return ("source",) if workspace.get("sourceMode") == "svn" else hub.WORKSPACE_STEPS

def workspace_index_state(workspace: dict) -> dict:
    """Return local index readiness without triggering synchronization or remote access."""

    index_path = workspace["indexPath"]
    index_size = index_path.stat().st_size if index_path.is_file() else 0
    source_count = system_count = None
    index_ready = False
    if index_size:
        try:
            connection = sqlite3.connect(f"{index_path.resolve().as_uri()}?mode=ro", uri=True)
            try:
                columns = {
                    row[1]
                    for row in connection.execute("PRAGMA table_info(gusen_source_record)")
                }
                if {"scope_id", "source_namespace"}.issubset(columns):
                    where, params = "scope_id=?", (workspace["scopeId"],)
                elif {"product_id", "project_id"}.issubset(columns):
                    where, params = "(product_id=? OR project_id=?)", (workspace["scopeId"], workspace["scopeId"])
                else:
                    where = ""
                if where:
                    physical = "COUNT(DISTINCT NULLIF(local_path,''))" if "local_path" in columns else "COUNT(*)"
                    systems = ("COUNT(DISTINCT NULLIF(system_id,''))"
                               if workspace["sourceMode"] == "svn" and "system_id" in columns else "NULL")
                    rows, source_count, system_count = connection.execute(
                        f"SELECT COUNT(*), {physical}, {systems} FROM gusen_source_record WHERE {where}", params
                    ).fetchone()
                    index_ready = bool(rows)
            finally:
                connection.close()
        except sqlite3.Error:
            source_count = system_count = None
    return {
        "path": str(index_path),
        "ready": index_ready,
        "sourceCount": source_count,
        "systemCount": system_count,
        "sizeBytes": index_size,
        "requiredAction": "" if index_ready else "init-or-reindex",
    }


def source_summary(workspace, index, state, checkout=None):
    """Give the project card local scope, inventory and change facts."""
    source_count = index.get("sourceCount") if index.get("ready") or state["status"] == "SYNCED" else None
    if workspace["sourceMode"] == "database":
        mappings = workspace["systemMappings"]
        systems = {str(mapping.get("system_id") or alias) if isinstance(mapping, dict) else alias
                   for alias, mapping in mappings.items()}
        workcopy = workspace["workcopyDir"]
        has_workcopy = workcopy.is_dir() and any(path.is_dir() for path in workcopy.iterdir())
        all_systems = not systems and bool(workspace["kind"])
        return {"systemCount":None if all_systems else len(systems), "allSystems":all_systems, "sourceCount":source_count,
                "changedCount":None if has_workcopy else 0}

    from common.workspace_source_scope import svn_scope_paths

    svn = workspace["svn"]
    copies = (checkout or {}).get("workingCopies") or []
    paths = [item.get("localSubdir", "") for item in copies] if copies else svn_scope_paths(svn)
    systems = {parts[1] for value in paths if isinstance(value, str)
               and len(parts := value.split("/")) == 2 and parts[0] in {"systems", "pages", "system-script"}}
    system_count = index.get("systemCount") or len(systems) or None
    changes = (sum(len(item["changes"]) for item in copies)
               if copies and all(isinstance(item.get("changes"), list) for item in copies) else None)
    return {"systemCount":system_count, "sourceCount":source_count, "changedCount":changes,
            "wholeRepository":"." in paths or bool(svn.get("repositoryUrl") and not paths),
            "directoryCount":len(paths) if paths and "." not in paths else None}

def workspace_config_digest(config, workspace):
    workspace_config = dict(workspace["config"])
    workspace_config.pop("source_mode", None)
    workspace_config.pop("aliases", None)  # Task navigation does not change source synchronization.
    payload = {
        "workspace": workspace_config,
        "sourceMode": workspace["sourceMode"],
        "datasource": workspace["datasource"],
        "rules": config.get("sync", {}).get("rules") or {},
        "sourceTables": config.get("source_tables") or {},
    }
    return hashlib.sha256(
        json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()

def legacy_workspace_config_digest(config, workspace):
    """Recognize state written before provider selection moved out of YAML."""

    workspace_config = dict(workspace["config"])
    workspace_config.pop("aliases", None)
    workspace_config["source_mode"] = workspace["sourceMode"]
    payload = {
        "workspace": workspace_config,
        "datasource": workspace["datasource"],
        "rules": config.get("sync", {}).get("rules") or {},
        "sourceTables": config.get("source_tables") or {},
    }
    return hashlib.sha256(
        json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()

def load_workspace_state(config, workspace):
    path = workspace["statePath"]
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        state = {}
    if not isinstance(state, dict) or not isinstance(state.get("steps", {}), dict):
        raise ValueError(f"Invalid workspace state: {path}")
    digest = workspace_config_digest(config, workspace)
    digest_matches = state.get("configDigest") in {
        digest,
        legacy_workspace_config_digest(config, workspace),
    }
    steps = state.get("steps") if isinstance(state.get("steps"), dict) else {}
    all_synced = digest_matches and all(
        (steps.get(step) or {}).get("status") == "SUCCESS" for step in workspace_steps(workspace)
    )
    if not state:
        status = "UNINITIALIZED"
    elif all_synced:
        status = "SYNCED"
    elif digest_matches and any((steps.get(step) or {}).get("status") == "PARTIAL" for step in workspace_steps(workspace)):
        status = "PARTIAL"
    elif digest_matches and state.get("lastFailure"):
        status = "FAILED"
    else:
        status = "PARTIAL"
    return {
        "workspaceKey": workspace["workspaceKey"],
        "configDigest": digest,
        "status": status,
        "lastFullSyncAt": state.get("lastFullSyncAt") or "",
        "steps": steps,
        "lastFailure": state.get("lastFailure"),
    }

def _svn_source_control_groups(workspace, working_copies):
    from common import legacy_source as hub
    mappings = workspace.get("systemMappings") or {}
    root_copy = next(
        (item for item in working_copies if isinstance(item, dict) and item.get("category") == "root"),
        None,
    )
    if root_copy:
        system_ids = sorted({
            str(mapping.get("system_id") or "").strip()
            for mapping in mappings.values()
            if isinstance(mapping, dict) and str(mapping.get("system_id") or "").strip()
        })
        return [{
            "id": "repository-root",
            "label": workspace.get("name") or workspace.get("workspaceKey") or "SVN 仓库",
            "dataSourceId": "",
            "systemIds": system_ids,
            "systemNames": [],
            "workingCopyIds": [str(root_copy.get("id") or "repository-root")],
            "inferred": False,
        }]

    def checkout_name(local_subdir):
        return hub.group_inference.checkout_name(workspace["checkoutPath"] / local_subdir)

    inferred = None
    effective_mappings = mappings
    if not mappings:
        inferred = hub.group_inference.infer_groups(workspace["checkoutPath"], working_copies)
        effective_mappings = {
            f"inferred.{system_id}": {
                "system_id": system_id,
                "data_source_id": match["dataSourceId"],
                "inference": match,
            }
            for system_id, match in inferred["matches"].items()
        }

    systems_by_data_source = {}
    for mapping in effective_mappings.values():
        if not isinstance(mapping, dict):
            continue
        data_source_id = str(mapping.get("data_source_id") or "").strip()
        system_id = str(mapping.get("system_id") or "").strip()
        if not data_source_id or not system_id:
            continue
        group = systems_by_data_source.setdefault(data_source_id, {"systemIds": [], "systemNames": []})
        if system_id not in group["systemIds"]:
            group["systemIds"].append(system_id)
        system_name = checkout_name(f"systems/{system_id}")
        if system_name and system_name not in group["systemNames"]:
            group["systemNames"].append(system_name)

    copy_ids_by_subdir = {
        str(item.get("localSubdir") or "").strip().replace("\\", "/"): str(item.get("id") or "").strip()
        for item in working_copies
        if isinstance(item, dict) and str(item.get("id") or "").strip()
    }
    assigned = set()
    groups = []
    for data_source_id, system_group in systems_by_data_source.items():
        subdirs = [f"datasources/{data_source_id}"] + [
            f"systems/{system_id}" for system_id in system_group["systemIds"]
        ]
        working_copy_ids = [copy_ids_by_subdir[subdir] for subdir in subdirs if subdir in copy_ids_by_subdir]
        assigned.update(working_copy_ids)
        system_names = system_group["systemNames"]
        datasource_name = checkout_name(f"datasources/{data_source_id}")
        display_name = (
            datasource_name
            if datasource_name
            else system_names[0]
            if len(system_names) == 1
            else " / ".join(system_names)
            if system_names
            else f"{data_source_id} 子系统"
        )
        groups.append({
            "id": f"{'subsystem' if mappings else 'inferred-subsystem'}-flat-{data_source_id}",
            "label": display_name,
            "dataSourceId": data_source_id,
            "systemIds": system_group["systemIds"],
            "systemNames": system_group["systemNames"],
            "workingCopyIds": working_copy_ids,
            "inferred": not bool(mappings),
        })

    remaining = {
        str(item.get("localSubdir") or "").strip().replace("\\", "/"):
            str(item.get("id") or "").strip()
        for item in working_copies
        if isinstance(item, dict)
        and str(item.get("id") or "").strip()
        and str(item.get("id") or "").strip() not in assigned
    }
    if inferred:
        for item in inferred["unmatchedSystems"]:
            system_id = item["systemId"]
            working_copy_id = remaining.pop(f"systems/{system_id}", "")
            if working_copy_id:
                groups.append({
                    "id": f"unmatched-system-flat-{system_id}",
                    "label": item["systemName"] or f"{system_id} 业务系统",
                    "dataSourceId": "",
                    "systemIds": [system_id],
                    "systemNames": [item["systemName"]] if item["systemName"] else [],
                    "workingCopyIds": [working_copy_id],
                    "inferred": True,
                    "unmatched": True,
                })
        for item in inferred["unmatchedDatasources"]:
            data_source_id = item["dataSourceId"]
            working_copy_id = remaining.pop(f"datasources/{data_source_id}", "")
            if working_copy_id:
                groups.append({
                    "id": f"unmatched-datasource-flat-{data_source_id}",
                    "label": item["dataSourceName"] or f"{data_source_id} 数据源",
                    "dataSourceId": data_source_id,
                    "systemIds": [],
                    "systemNames": [],
                    "workingCopyIds": [working_copy_id],
                    "inferred": True,
                    "unmatched": True,
                })
    remaining_ids = [working_copy_id for working_copy_id in remaining.values() if working_copy_id]
    if remaining_ids:
        groups.append({
            "id": "shared-flat",
            "label": "公共源码",
            "dataSourceId": "",
            "systemIds": [],
            "systemNames": [],
            "workingCopyIds": remaining_ids,
        })
    return groups


def update_workspace_state(config, workspace, step=None, status=None, error="", full_sync=False):
    from common import legacy_source as hub
    with hub.file_lock(workspace["contextDir"] / ".state.lock"):
        hub.ensure_workspace_structure(workspace)
        state = load_workspace_state(config, workspace)
        state["configDigest"] = workspace_config_digest(config, workspace)
        state.pop("status", None)
        now = hub._now()
        if step:
            state.setdefault("steps", {})[step] = {"status": status, "updatedAt": now}
        if error:
            state["lastFailure"] = {"step": step or "", "message": str(error)[:1000], "time": now}
        elif status == "SUCCESS" and (state.get("lastFailure") or {}).get("step") == step:
            state["lastFailure"] = None
        if full_sync:
            state["lastFullSyncAt"] = now
            state["lastFailure"] = None
        state_path = workspace["statePath"]
        hub.svn_checkout.atomic_json(state_path, state)
        return load_workspace_state(config, workspace)
