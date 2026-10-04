"""SVN CLI orchestration, grouped by command lifecycle and side effects.

Provider APIs keep their own locking and source semantics. The unified CLI
supplies progress and reindex callbacks, preserving its host override boundary.
"""
from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from providers.svn import checkout


@dataclass(frozen=True)
class SvnCommand:
    parsed: object
    extra_args: list[str]
    hub: object
    config: dict
    workspace: dict
    on_progress: Callable
    reindex: Callable
    reindex_files: Callable
    reindex_refresh: Callable

    @property
    def manifest_layout(self):
        return self.workspace["svn"].get("checkoutLayout") == "manifest-working-copies"


def _lifecycle(command):
    parsed = command.parsed
    gusen_hub = command.hub
    config = command.config
    workspace = command.workspace
    manifest_layout = command.manifest_layout
    _svn_progress = command.on_progress
    _reindex_svn = command.reindex
    _reindex_svn_refresh = command.reindex_refresh
    bootstrap = None
    if parsed.action == 'auth-cache':
        if not manifest_layout:
            raise SystemExit("svn auth-cache requires manifest-working-copies")
        try:
            payload = json.load(sys.stdin)
        except json.JSONDecodeError as error:
            raise SystemExit("svn auth-cache requires a JSON stdin payload") from error
        if not isinstance(payload, dict) or not isinstance(payload.get("password"), str):
            raise SystemExit("svn auth-cache stdin must contain a password field")
        from providers.svn.nexus import bootstrap as nexus_bootstrap

        result = nexus_bootstrap.cache_authentication(workspace, payload["password"])
    elif parsed.action == 'scope-preview':
        if not manifest_layout:
            raise SystemExit("svn scope-preview requires manifest-working-copies")
        from providers.svn.nexus import bootstrap as nexus_bootstrap

        result = nexus_bootstrap.preview(workspace)
    elif parsed.action == 'scope-import':
        if not manifest_layout:
            raise SystemExit("svn scope-import requires manifest-working-copies")
        try:
            payload = json.load(sys.stdin)
        except json.JSONDecodeError as error:
            raise SystemExit("svn scope-import requires a JSON stdin payload") from error
        if not isinstance(payload, dict):
            raise SystemExit("svn scope-import stdin must contain text or file")
        from providers.svn.scope_import import (
            build_manifest_from_workspace_input,
            merge_scope_config,
            parse_scope_input,
            read_checkout_script,
        )

        source_kind = str(payload.get("source") or "script")
        if isinstance(payload.get("file"), str) and payload["file"].strip():
            source_path = Path(payload["file"]).expanduser().resolve()
            parsed_scope = build_manifest_from_workspace_input(
                read_checkout_script(source_path), workspace
            )
        elif isinstance(payload.get("text"), str):
            parsed_scope = (
                parse_scope_input(payload["text"], workspace["workspaceKey"], source_kind)
                if source_kind.casefold() in {"config", "yaml", "json"}
                else build_manifest_from_workspace_input(payload["text"], workspace)
            )
        else:
            raise SystemExit("svn scope-import stdin must contain text or file")
        config_path = workspace.get("svn", {}).get("scopeConfigPath")
        if not config_path:
            raise SystemExit(
                "SVN workspace configuration path is unavailable; use products.yaml/projects.yaml"
            )
        result = merge_scope_config(
            config_path,
            workspace["workspaceKey"],
            parsed_scope,
            workspace,
        )
        result["source"] = source_kind
    elif parsed.action in {'sync-from-script', 'sync-from-bat', 'sync-from-config'}:
        if not manifest_layout:
            raise SystemExit("svn scope sync requires manifest-working-copies")
        from providers.svn.nexus import bootstrap as nexus_bootstrap
        from providers.svn.nexus import workspace as nexus_workspace
        from providers.svn.nexus.manifest import load_authorized_scope

        manifest_path = workspace["svn"].get("scopeManifestPath")
        had_working_copies = False
        _svn_progress(f"{workspace['displayName']}｜授权范围｜检查现有 working copy")
        if manifest_path and manifest_path.is_file():
            old_scope = load_authorized_scope(workspace)
            had_working_copies = any((entry.root / ".svn").is_dir() for entry in old_scope.entries)
            if had_working_copies:
                current = nexus_workspace.status(workspace, on_progress=_svn_progress)
                if not current["status"]["clean"] and not parsed.merge_local:
                    raise SystemExit(
                        "SVN scope sync is blocked by local changes; review them first or explicitly allow merge-local"
                    )
        _svn_progress(f"{workspace['displayName']}｜授权范围｜读取可编辑范围配置（无配置时导入签出脚本）")
        scope_import = nexus_bootstrap.import_scope(
            workspace,
            accept_scope_change=parsed.accept_scope_change,
        )
        _svn_progress(
            f"{workspace['displayName']}｜授权范围｜完成 · working copy {scope_import.get('entries', 0)}"
        )
        initialized = nexus_workspace.initialize(workspace, on_progress=_svn_progress)
        refreshed = (
            nexus_workspace.refresh(
                workspace,
                merge_local=parsed.merge_local,
                on_progress=_svn_progress,
            )
            if had_working_copies
            else None
        )
        initialized_scope = initialized.get("scope") or {}
        refreshed_status = (refreshed or {}).get("status") or {}
        source_label = "script" if scope_import.get("source") == "script" else "config"
        result = {
            "ok": True,
            "action": (
                f"updated-from-{source_label}" if had_working_copies
                else f"checked-out-from-{source_label}"
            ),
            "scopeImport": scope_import,
            "workingCopies": len(initialized_scope.get("workingCopies") or []),
            "skipped": initialized_scope.get("skipped") or [],
            "clean": bool((refreshed_status or initialized_scope).get("clean")),
            "updated": len((refreshed or {}).get("updated") or []),
            "reindex": _reindex_svn(
                gusen_hub,
                config,
                workspace,
                on_progress=_svn_progress,
            ),
        }
        _svn_progress(
            f"{workspace['displayName']}｜完成｜"
            f"{'更新' if had_working_copies else '检出'} {result['workingCopies']} 个 working copy · "
            f"跳过 {len(result['skipped'])} 个 · "
            f"索引对象 {result['reindex'].get('changed', 0)}"
        )
        gusen_hub.update_workspace_state(config, workspace, "source", "SUCCESS")
    elif parsed.action == 'init':
        if manifest_layout:
            from providers.svn.nexus import workspace as nexus_workspace

            result = nexus_workspace.initialize(workspace)
        else:
            result = checkout.initialize(workspace, gusen_hub.CONFIG_DIR, bootstrap)
        result["reindex"] = _reindex_svn(gusen_hub, config, workspace)
        gusen_hub.update_workspace_state(config, workspace, "source", "SUCCESS")
    elif parsed.action == 'refresh':
        if manifest_layout:
            if parsed.path and parsed.working_copy:
                raise SystemExit("svn refresh accepts --path or --working-copy, not both")
            from providers.svn.nexus import workspace as nexus_workspace

            result = nexus_workspace.refresh(
                workspace,
                merge_local=parsed.merge_local,
                working_copy_ids=parsed.working_copy,
                logical_paths=[parsed.path] if parsed.path else None,
                on_progress=_svn_progress,
            )
        else:
            if parsed.path:
                raise SystemExit("svn refresh --path requires manifest-working-copies")
            result = checkout.refresh(
                workspace,
                gusen_hub.CONFIG_DIR,
                bootstrap,
                prune=parsed.prune,
                on_progress=_svn_progress,
            )
        result["reindex"] = (
            _reindex_svn_refresh(
                gusen_hub,
                config,
                workspace,
                result,
                on_progress=_svn_progress,
            )
            if manifest_layout
            else _reindex_svn(gusen_hub, config, workspace, on_progress=_svn_progress)
        )
        gusen_hub.update_workspace_state(config, workspace, "source", "SUCCESS")
    elif parsed.action == 'status':
        checkout.require_capability(workspace, "status")
        if manifest_layout:
            from providers.svn.nexus import workspace as nexus_workspace

            result = nexus_workspace.status(workspace, include_diff=parsed.diff, remote=parsed.remote)
        else:
            with checkout.operation_lock(workspace, "status", shared=True):
                result = {
                    "ok": True,
                    "status": checkout.svn_status(
                        workspace["checkoutPath"],
                        include_diff=parsed.diff,
                        remote=parsed.remote,
                        settings=workspace["svn"],
                    ),
                }
    return result


def _documents(command):
    parsed = command.parsed
    gusen_hub = command.hub
    config = command.config
    workspace = command.workspace
    manifest_layout = command.manifest_layout
    _svn_progress = command.on_progress
    _reindex_svn_files = command.reindex_files
    if parsed.action == 'fragments':
        if not manifest_layout:
            raise SystemExit("svn fragments requires manifest-working-copies")
        if not parsed.source_type or not parsed.source_id:
            raise SystemExit("svn fragments requires --source-type and --source-id")
        from providers.svn.nexus import documents

        result = documents.fragments(
            workspace,
            source_type=parsed.source_type,
            source_id=parsed.source_id,
            fun_id=parsed.fun_id,
            working_copy_id=parsed.working_copy[0] if len(parsed.working_copy) == 1 else "",
        )
    elif parsed.action in {'read', 'read-batch'}:
        if not manifest_layout:
            raise SystemExit(f"svn {parsed.action} requires manifest-working-copies")
        from providers.svn.nexus import documents

        if parsed.action == "read":
            if not parsed.source_type or not parsed.source_id:
                raise SystemExit("svn read requires --source-type and --source-id")
            result = documents.read(
                workspace,
                source_type=parsed.source_type,
                source_id=parsed.source_id,
                fun_id=parsed.fun_id,
                json_pointer=parsed.json_pointer,
                working_copy_id=parsed.working_copy[0] if len(parsed.working_copy) == 1 else "",
            )
        else:
            try:
                payload = json.load(sys.stdin)
            except json.JSONDecodeError as error:
                raise SystemExit("svn read-batch requires a JSON stdin payload") from error
            targets = payload.get("targets") if isinstance(payload, dict) else None
            if not isinstance(targets, list) or not targets:
                raise SystemExit("svn read-batch stdin must contain a non-empty targets array")
            if len(targets) > documents.MAX_BATCH_CHANGES:
                raise SystemExit(
                    f"svn read-batch supports at most {documents.MAX_BATCH_CHANGES} targets"
                )
            opened = []
            for index, target in enumerate(targets, 1):
                if not isinstance(target, dict):
                    raise SystemExit(f"svn read-batch target {index} must be an object")
                source_type = str(
                    target.get("sourceType") or target.get("source_type") or ""
                ).strip().lower()
                source_id = str(
                    target.get("sourceId") or target.get("source_id") or ""
                ).strip()
                if not source_type or not source_id:
                    raise SystemExit(
                        f"svn read-batch target {index} requires sourceType and sourceId"
                    )
                opened.append(
                    documents.read(
                        workspace,
                        source_type=source_type,
                        source_id=source_id,
                        fun_id=str(
                            target.get("funId") or target.get("fun_id") or ""
                        ).strip(),
                        json_pointer=str(
                            target.get("jsonPointer") or target.get("json_pointer") or ""
                        ).strip(),
                        working_copy_id=str(
                            target.get("workingCopyId") or target.get("working_copy_id") or ""
                        ).strip(),
                    )
                )
            result = {
                "ok": True,
                "workspaceKey": workspace["workspaceKey"],
                "sessionId": next(
                    (item["sessionId"] for item in opened if item.get("sessionId")),
                    "",
                ),
                "documents": opened,
            }
    elif parsed.action in {'write', 'write-batch'}:
        if not manifest_layout:
            raise SystemExit(f"svn {parsed.action} requires manifest-working-copies")
        try:
            payload = json.load(sys.stdin)
        except json.JSONDecodeError as error:
            raise SystemExit(f"svn {parsed.action} requires a JSON stdin payload") from error
        from providers.svn.nexus import documents

        if parsed.action == "write":
            if not isinstance(payload, dict) or not isinstance(payload.get("content"), str):
                raise SystemExit("svn write stdin must contain a text content field")
            session_id = parsed.session or str(payload.get("sessionId") or "")
            document_id = parsed.document or str(payload.get("documentId") or "")
            if not session_id or not document_id:
                raise SystemExit(
                    "svn write requires --session/--document or sessionId/documentId in stdin"
                )
            result = documents.write(
                workspace,
                session_id=session_id,
                document_id=document_id,
                content=payload["content"],
                expected_product_hash=str(payload.get("expectedProductHash") or ""),
            )
            source_paths = [result["sourcePath"]] if result.get("written") else []
        else:
            if not isinstance(payload, dict) or not isinstance(payload.get("changes"), list):
                raise SystemExit("svn write-batch stdin must contain a changes array")
            changes = payload["changes"]
            if not changes:
                raise SystemExit("svn write-batch changes must not be empty")
            if len(changes) > documents.MAX_BATCH_CHANGES:
                raise SystemExit(
                    f"svn write-batch supports at most {documents.MAX_BATCH_CHANGES} changes"
                )
            session_id = parsed.session or str(payload.get("sessionId") or "")
            resolved_changes = []
            auto_opened = 0
            for index, change in enumerate(changes, 1):
                if not isinstance(change, dict):
                    raise SystemExit(f"svn write-batch change {index} must be an object")
                document_id = str(change.get("documentId") or "")
                if not document_id:
                    target = change.get("target") or change
                    if not isinstance(target, dict):
                        raise SystemExit(f"svn write-batch change {index} target must be an object")
                    source_type = str(
                        target.get("sourceType") or target.get("source_type") or ""
                    ).strip().lower()
                    source_id = str(
                        target.get("sourceId") or target.get("source_id") or ""
                    ).strip()
                    if not source_type or not source_id:
                        raise SystemExit(
                            f"svn write-batch change {index} requires documentId or "
                            "sourceType/sourceId"
                        )
                    opened = documents.read(
                        workspace,
                        source_type=source_type,
                        source_id=source_id,
                        fun_id=str(
                            target.get("funId") or target.get("fun_id") or ""
                        ).strip(),
                        json_pointer=str(
                            target.get("jsonPointer") or target.get("json_pointer") or ""
                        ).strip(),
                    )
                    if not opened.get("editable"):
                        raise SystemExit(
                            f"svn write-batch target is not editable: {opened['sourcePath']}"
                        )
                    document_id = opened["documentId"]
                    if session_id and session_id != opened["sessionId"]:
                        raise SystemExit("svn write-batch changes resolved to different sessions")
                    session_id = opened["sessionId"]
                    auto_opened += 1
                resolved_changes.append({**change, "documentId": document_id})
            if not session_id:
                raise SystemExit(
                    "svn write-batch requires --session/sessionId when changes use documentId"
                )
            result = documents.write_batch(
                workspace,
                session_id=session_id,
                changes=resolved_changes,
            )
            result["autoOpened"] = auto_opened
            source_paths = result["sourcePaths"]
        _svn_progress(
            f"{workspace['displayName']}｜源码写入｜已写回 {len(source_paths)} 个本地 SVN 文件"
        )
        if source_paths:
            result["reindex"] = _reindex_svn_files(
                gusen_hub,
                config,
                workspace,
                source_paths,
                on_progress=_svn_progress,
            )
        _svn_progress(f"{workspace['displayName']}｜源码写入｜完成")
    return result


def _page_query(command):
    workspace = command.workspace
    manifest_layout = command.manifest_layout
    if not manifest_layout:
        raise SystemExit("svn page-query requires manifest-working-copies")
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError as error:
        raise SystemExit("svn page-query requires a JSON stdin payload") from error
    if not isinstance(payload, dict) or not isinstance(payload.get("name"), str):
        raise SystemExit("svn page-query requires a tool name and arguments object")
    arguments = payload.get("arguments", {})
    if not isinstance(arguments, dict):
        raise SystemExit("svn page-query arguments must be an object")
    if arguments.get("workspaceKey", workspace["workspaceKey"]) != workspace["workspaceKey"]:
        raise SystemExit("svn page-query workspaceKey differs from the selected workspace")
    from providers.svn.nexus import page_nodes

    name = payload["name"]
    identity_keys = {"workspaceKey", "sourceNamespace", "sourceId", "funId"}
    allowed_by_name = {
        "get_index_status": {"workspaceKey"},
        "search_sources": {"workspaceKey", "keyword", "sourceType", "limit", "cursor"},
        "search_page_fields": {"workspaceKey", "sourceNamespace", "fieldIdPrefix", "labelKeyword", "limit", "cursor"},
        "list_page_nodes": identity_keys | {"nodeType", "eventScope", "limit", "cursor"},
        "read_page_nodes": identity_keys | {"targets", "maxChars"},
        "read_inherited_source": identity_keys | {"sourceType", "workingCopyId", "jsonPointer",
                                                  "indexedSourceHash", "offset", "maxChars"},
        "list_page_fields": identity_keys | {"regionType", "fieldId", "fieldIdPrefix", "limit", "cursor"},
        "get_page_field": identity_keys | {"target", "maxChars"},
        "list_page_field_relations": identity_keys | {"sourceFieldId", "targetFieldId", "limit", "cursor"},
        "check_page_field_references": identity_keys | {"semanticFieldId", "limit"},
        "get_source_context": identity_keys | {"limit"},
    }
    if name not in allowed_by_name:
        raise SystemExit("Unsupported svn page-query tool name")
    if unknown := set(arguments) - allowed_by_name[name]:
        raise SystemExit("Unknown svn page-query arguments: " + ", ".join(sorted(unknown)))
    namespace = arguments.get("sourceNamespace", "")
    source_id = arguments.get("sourceId", "")
    fun_id = arguments.get("funId", "")
    if name not in {"get_index_status", "search_sources", "search_page_fields"}:
        if any(not isinstance(value, str) or not value.strip() or len(value) > 512
               for value in (namespace, source_id)) or not isinstance(fun_id, str):
            raise SystemExit("svn page-query requires sourceNamespace and sourceId")
    try:
        if name == "get_index_status":
            result = page_nodes.index_status(workspace)
        elif name == "search_sources":
            result = page_nodes.search_sources(
                workspace, keyword=arguments.get("keyword", ""),
                source_type=arguments.get("sourceType", ""),
                limit=arguments.get("limit", 20), cursor=arguments.get("cursor", ""),
            )
        elif name == "search_page_fields":
            result = page_nodes.search_page_fields(
                workspace, source_namespace=namespace,
                field_id_prefix=arguments.get("fieldIdPrefix", ""),
                label_keyword=arguments.get("labelKeyword", ""),
                limit=arguments.get("limit", 50), cursor=arguments.get("cursor", ""),
            )
        elif name == "list_page_nodes":
            result = page_nodes.list_nodes(
                workspace, source_namespace=namespace, source_id=source_id, fun_id=fun_id,
                node_type=arguments.get("nodeType", ""), event_scope=arguments.get("eventScope", ""),
                limit=arguments.get("limit", 50), cursor=arguments.get("cursor", ""),
            )
        elif name == "read_page_nodes":
            result = page_nodes.read_nodes(
                workspace, source_namespace=namespace, source_id=source_id, fun_id=fun_id,
                targets=arguments.get("targets"), max_chars=arguments.get("maxChars", 12_000),
            )
        elif name == "read_inherited_source":
            from providers.svn.nexus import inheritance_sources

            result = inheritance_sources.read_inherited_source(
                workspace, source_type=arguments.get("sourceType", ""),
                source_namespace=namespace, source_id=source_id, fun_id=fun_id,
                working_copy_id=arguments.get("workingCopyId", ""),
                json_pointer_value=arguments.get("jsonPointer", ""),
                indexed_source_hash=arguments.get("indexedSourceHash", ""),
                offset=arguments.get("offset", 0), max_chars=arguments.get("maxChars", 12_000),
            )
        elif name == "list_page_fields":
            result = page_nodes.list_fields(
                workspace, source_namespace=namespace, source_id=source_id, fun_id=fun_id,
                region_type=arguments.get("regionType", ""), field_id=arguments.get("fieldId", ""),
                field_id_prefix=arguments.get("fieldIdPrefix", ""),
                limit=arguments.get("limit", 50), cursor=arguments.get("cursor", ""),
            )
        elif name == "get_page_field":
            result = page_nodes.get_field(
                workspace, source_namespace=namespace, source_id=source_id, fun_id=fun_id,
                target=arguments.get("target"), max_chars=arguments.get("maxChars", 12_000),
            )
        elif name == "list_page_field_relations":
            result = page_nodes.list_field_relations(
                workspace, source_namespace=namespace, source_id=source_id, fun_id=fun_id,
                source_field_id=arguments.get("sourceFieldId", ""),
                target_field_id=arguments.get("targetFieldId", ""),
                limit=arguments.get("limit", 50), cursor=arguments.get("cursor", ""),
            )
        elif name == "check_page_field_references":
            result = page_nodes.field_reference_diagnostics(
                workspace, source_namespace=namespace, source_id=source_id, fun_id=fun_id,
                semantic_field_id=arguments.get("semanticFieldId", ""),
                limit=arguments.get("limit", 20),
            )
        elif name == "get_source_context":
            result = page_nodes.source_context(
                workspace, source_namespace=namespace, source_id=source_id, fun_id=fun_id,
                limit=arguments.get("limit", 10),
            )
    except page_nodes.PageIndexError as error:
        raise SystemExit(f"{error.code}: {error}") from error
    result = {"ok": True, **result}
    return result


def _queries(command):
    parsed = command.parsed
    extra_args = command.extra_args
    workspace = command.workspace
    manifest_layout = command.manifest_layout
    if parsed.action == 'catalog':
        checkout.require_capability(workspace, "browse")
        if not manifest_layout:
            raise SystemExit("svn catalog requires manifest-working-copies")
        from providers.svn.nexus import index_queries

        result = index_queries.catalog(workspace)
    elif parsed.action in {'definition', 'callers'}:
        if not manifest_layout:
            raise SystemExit(f"svn {parsed.action} requires manifest-working-copies")
        if not parsed.alias or not parsed.fun_id:
            raise SystemExit(f"svn {parsed.action} requires --alias and --fun-id")
        from providers.svn.nexus import index_queries

        result = (
            index_queries.definition(workspace, alias=parsed.alias, fun_id=parsed.fun_id)
            if parsed.action == "definition"
            else index_queries.callers(workspace, alias=parsed.alias, fun_id=parsed.fun_id, limit=parsed.limit)
        )
    elif parsed.action in {'find', 'context'}:
        if not manifest_layout:
            raise SystemExit(f"svn {parsed.action} requires manifest-working-copies")
        from providers.svn.nexus import index_queries

        if parsed.action == "find":
            if not parsed.keyword:
                raise SystemExit("svn find requires --keyword")
            result = index_queries.find(workspace, keyword=parsed.keyword, limit=parsed.limit)
        else:
            if not parsed.source_id:
                raise SystemExit("svn context requires --source-id")
            result = index_queries.context(
                workspace,
                source_id=parsed.source_id,
                fun_id=parsed.fun_id,
                limit=parsed.limit,
            )
    elif parsed.action in {'facts', 'explain'}:
        if not manifest_layout:
            raise SystemExit(f"svn {parsed.action} requires manifest-working-copies")
        from providers.svn.nexus import index_queries

        if parsed.action == "facts":
            if not (parsed.keyword or parsed.table or parsed.source_id):
                raise SystemExit("svn facts requires --keyword, --table, or --source-id")
            result = index_queries.facts(
                workspace,
                keyword=parsed.keyword,
                table_name=parsed.table,
                source_id=parsed.source_id or "",
                limit=parsed.limit if any(a == "--limit" or a.startswith("--limit=") for a in extra_args) else 3,
                continuation=parsed.continuation,
            )
        else:
            if not (parsed.table or parsed.bill_type):
                raise SystemExit("svn explain requires --table or --bill-type")
            result = index_queries.explain(
                workspace,
                table_name=parsed.table,
                bill_type_code=parsed.bill_type,
                data_source_id=parsed.data_source_id,
                operation=parsed.operation,
                limit=parsed.limit if any(a == "--limit" or a.startswith("--limit=") for a in extra_args) else 1,
                fact_limit=parsed.fact_limit,
                caller_depth=parsed.caller_depth,
                continuation=parsed.continuation,
                include_details=parsed.include_details,
            )
    return result


def _reindex_file(command):
    parsed = command.parsed
    gusen_hub = command.hub
    config = command.config
    workspace = command.workspace
    manifest_layout = command.manifest_layout
    _svn_progress = command.on_progress
    _reindex_svn_files = command.reindex_files
    if parsed.action == 'reindex-file':
        if not manifest_layout or not parsed.path:
            raise SystemExit("svn reindex-file requires manifest-working-copies and --path")
        indexed = _reindex_svn_files(
            gusen_hub,
            config,
            workspace,
            [parsed.path],
            on_progress=_svn_progress,
        )
        result = {
            "ok": True,
            "workspaceKey": workspace["workspaceKey"],
            "sourcePath": parsed.path,
            "reindex": indexed,
            "stale": bool(indexed and indexed[0].get("failures")),
        }
    return result


def _maintenance(command):
    parsed = command.parsed
    gusen_hub = command.hub
    workspace = command.workspace
    manifest_layout = command.manifest_layout
    if not manifest_layout:
        raise SystemExit("This SVN action requires manifest-working-copies")
    from providers.svn.nexus import edit_leases, operation_maintenance, source_queries, scm
    if parsed.action == "lease-renew":
        result = edit_leases.renew_edit_token(workspace, edit_token=parsed.edit_token)
    elif parsed.action == "lease-release":
        result = edit_leases.release_edit_lease(workspace, session_id=parsed.session, document_id=parsed.document)
    elif parsed.action == "operations":
        result = operation_maintenance.inspect_operations(workspace, limit=parsed.limit, cursor=parsed.cursor)
    elif parsed.action == "operation-gc":
        result = operation_maintenance.gc_operations(workspace, before=parsed.before, check=not parsed.apply, confirmation=parsed.confirmation)
    elif parsed.action == "blame":
        result = scm.blame(workspace, logical_path=parsed.path, start_line=parsed.start_line, end_line=parsed.end_line)
    elif parsed.action == "text-search":
        from common import source_text_search
        from providers.svn.nexus import page_nodes
        checkout.require_capability(workspace, "browse")
        with gusen_hub.index_connection(workspace, action="body-search", readonly=True) as conn:
            result = source_text_search.search(conn,workspace["scopeId"],keyword=parsed.keyword,generation=page_nodes._require_source_ready(conn),limit=parsed.limit,cursor=parsed.cursor)
    elif parsed.action == "table-references":
        result = source_queries.table_references(workspace, table_name=parsed.table, column_name=parsed.column,
                                               limit=parsed.limit, cursor=parsed.cursor, graph=parsed.graph)
    else:
        from common import source_changes
        checkout.require_capability(workspace, "browse")
        with gusen_hub.index_connection(workspace, action="source-changes", readonly=True) as conn:
            result = source_changes.list_changes(conn, workspace["scopeId"], since_generation=parsed.since_generation,
                                                limit=parsed.limit, cursor=parsed.cursor)
    return result


def _scm(command):
    parsed = command.parsed
    gusen_hub = command.hub
    config = command.config
    workspace = command.workspace
    manifest_layout = command.manifest_layout
    _svn_progress = command.on_progress
    _reindex_svn_files = command.reindex_files
    if not manifest_layout:
        raise SystemExit(f"svn {parsed.action} requires manifest-working-copies")
    from providers.svn.nexus import scm

    if parsed.action == "scm-status":
        result = scm.status(
            workspace,
            remote=parsed.remote,
            working_copy_ids=set(parsed.working_copy) or None,
            on_progress=_svn_progress,
        )
    elif parsed.action == "diff":
        if not parsed.path:
            raise SystemExit("svn diff requires --path")
        result = scm.diff(workspace, logical_path=parsed.path, remote=parsed.remote)
    elif parsed.action == "conflict":
        if not parsed.path:
            raise SystemExit("svn conflict requires --path")
        result = scm.conflict_details(workspace, logical_path=parsed.path)
    elif parsed.action == "resolve-conflict":
        if not parsed.path:
            raise SystemExit("svn resolve-conflict requires --path")
        result = scm.resolve_conflict(workspace, logical_path=parsed.path)
        result["reindex"] = _reindex_svn_files(
            gusen_hub,
            config,
            workspace,
            result["files"],
            on_progress=_svn_progress,
        )
    elif parsed.action == "history":
        if not parsed.path:
            raise SystemExit("svn history requires --path")
        result = scm.history(workspace, logical_path=parsed.path, limit=parsed.limit)
    elif parsed.action == "delivery-status":
        result = scm.delivery_status(workspace)
    elif parsed.action in {"revert-preview", "platform-save-preview"}:
        if not parsed.session:
            raise SystemExit(f"svn {parsed.action} requires --session")
        action = "revert" if parsed.action == "revert-preview" else "platform-save"
        result = scm.preview(
            workspace,
            action=action,
            session_id=parsed.session,
            working_copy_ids=set(parsed.working_copy) or None,
            on_progress=_svn_progress,
        )
    elif parsed.action == "revert":
        if not parsed.session or not parsed.selection_token:
            raise SystemExit("svn revert requires --session and --selection-token")
        result = scm.revert(
            workspace,
            session_id=parsed.session,
            selection_token=parsed.selection_token,
            candidate_ids=parsed.candidate,
            on_progress=_svn_progress,
        )
        result["reindex"] = _reindex_svn_files(
            gusen_hub,
            config,
            workspace,
            result["files"],
            on_progress=_svn_progress,
        )
    else:
        if not parsed.session or not parsed.selection_token:
            raise SystemExit("svn platform-save requires --session and --selection-token")
        try:
            payload = json.load(sys.stdin)
        except json.JSONDecodeError as error:
            raise SystemExit("svn platform-save requires a JSON stdin payload") from error
        result = scm.platform_save(
            workspace,
            session_id=parsed.session,
            selection_token=parsed.selection_token,
            candidate_ids=parsed.candidate,
            message=(payload or {}).get("message") if isinstance(payload, dict) else "",
            on_progress=_svn_progress,
        )
        result["reindex"] = _reindex_svn_files(
            gusen_hub,
            config,
            workspace,
            result["files"],
            on_progress=_svn_progress,
        )
    return result


MAINTENANCE_ACTIONS = {
    "lease-renew", "lease-release", "operations", "operation-gc", "blame",
    "changed-sources", "table-references", "text-search",
}
ACTION_HANDLERS = {
    **dict.fromkeys(("auth-cache", "scope-preview", "scope-import", "sync-from-script",
                    "sync-from-bat", "sync-from-config", "init", "refresh", "status"), _lifecycle),
    **dict.fromkeys(("fragments", "read", "read-batch", "write", "write-batch"), _documents),
    **dict.fromkeys(("catalog", "definition", "callers", "find", "context", "facts", "explain"), _queries),
    **dict.fromkeys(MAINTENANCE_ACTIONS, _maintenance),
    **dict.fromkeys(("scm-status", "diff", "conflict", "resolve-conflict", "history",
                    "delivery-status", "revert-preview", "platform-save-preview", "revert",
                    "platform-save"), _scm),
    "reindex-file": _reindex_file,
    "page-query": _page_query,
}


def run(parsed, extra_args, hub, config, workspace, *, on_progress, reindex,
        reindex_files, reindex_refresh):
    command = SvnCommand(parsed, extra_args, hub, config, workspace, on_progress,
                         reindex, reindex_files, reindex_refresh)
    # Preserve validation precedence: maintenance actions predate layout flags.
    if parsed.action not in MAINTENANCE_ACTIONS:
        if command.manifest_layout and parsed.prune:
            raise SystemExit("--prune is only available for the legacy sparse SVN layout")
        if not command.manifest_layout and (parsed.merge_local or parsed.working_copy):
            raise SystemExit("--merge-local and --working-copy require manifest-working-copies")
    result = ACTION_HANDLERS[parsed.action](command)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0
