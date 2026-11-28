"""Verify and refresh one registered legacy-sparse SVN source file."""

from pathlib import Path
import xml.etree.ElementTree as ET

from common import legacy_source
from common.source_format import decode_source
from providers.svn import checkout, scanner
from providers.svn.direct_edit import index_item_current
from providers.svn.nexus import catalog
from providers.svn.nexus.procedure_sources import source_index_status


def inspect_file(workspace: dict, path: Path, *, refresh: bool) -> dict:
    with checkout.operation_lock(workspace, "legacy-direct-edit", blocking=True):
        root = workspace["checkoutPath"]
        if not path.is_relative_to(root):
            raise ValueError("SVN 源码路径不在登记的工作副本中")
        scope = checkout.load_scope(workspace)
        configured = checkout.scope_manifest(workspace)
        if not configured["complete"] or any(
            scope.get(key) != configured[key]
            for key in ("includes", "systemIds", "dataSourceIds", "paths", "mappingHash")
        ):
            raise ValueError("SVN 稀疏检出范围与当前登记配置不一致，请重新核对范围")
        checkout.verify_repository_fingerprint(workspace, scope.get("repositoryFingerprint") or "")
        relative = path.relative_to(root)
        parts = relative.parts
        if len(parts) < 3 or parts[0] not in scope["includes"] or path.name.casefold().endswith(".inherit.gss"):
            raise ValueError("SVN 源码不在可直接编辑的稀疏检出范围中")
        category, owner = parts[:2]
        if category == "pages" and owner in scope["systemIds"] and path.suffix.lower() == ".gss":
            source_type = "page"
        elif category == "procedures" and owner in scope["dataSourceIds"] and path.suffix == ".gss":
            source_type = "procedure"
        elif (category == "system-script" and owner in scope["systemIds"] and len(parts) == 3
              and path.suffix.lower() in {".js", ".vm", ".sql"}):
            source_type = "system-script"
        else:
            raise ValueError("SVN 源码类型或归属不在当前稀疏检出范围中")
        info = ET.fromstring(checkout.run_svn(["info", "--xml", "--", str(path)]).stdout).find("entry")
        if (info is None or info.get("kind") != "file" or not info.get("revision")
                or Path(info.findtext("wc-info/wcroot-abspath") or "").resolve() != root.resolve()):
            raise ValueError("SVN 源码不是登记工作副本中具有 BASE 版本的受版本控制文件")
        target_changes = []
        for candidate in (root, *reversed(relative.parents), path):
            target = candidate if candidate.is_absolute() else root / candidate
            changes = checkout.svn_path_changes(root, target)
            if target == path:
                target_changes = changes
            for change in changes:
                block = catalog.svn_state_block(change)
                if block or change.get("copied"):
                    raise ValueError(f"SVN 源码或上级目录存在不可编辑的工作副本状态 {change['path']}：{block[1] if block else '已复制'}")
        base = checkout.run_svn_binary(["cat", "-r", "BASE", "--", str(path)]).stdout
        digest = checkout.file_hash(path)
        logical = relative.as_posix()
        status_map = {change["path"]: change["item"] or change["properties"] for change in target_changes}
        modified = any(change["path"] == logical and change["item"] == "modified" for change in target_changes)
        revisions = {logical: info.get("revision")}
        if source_type == "page":
            names = scanner._page_index(root / "pages" / owner / "index.md")
            data_source = ",".join((scope.get("dataSourceIdsBySystem") or {}).get(owner) or [])
            item = scanner._scan_page_gss(path, root, owner, data_source, names, revisions, status_map)
        elif source_type == "procedure":
            item = scanner._scan_procedure(path, root, owner, set((scope.get("systemNamesByDataSource") or {})),
                                           revisions, status_map)
        else:
            data_source = ",".join((scope.get("dataSourceIdsBySystem") or {}).get(owner) or [])
            item = scanner._scan_system_script(path, root, owner, data_source, revisions, status_map)
        if item["status"] not in {"OK", "SVN_DIRTY"}:
            raise ValueError(f"SVN 源码无法索引：{item['status']}")
        if item["source_hash"] != digest:
            raise ValueError("SVN 源码在检查期间发生变化")
        if source_type in {"page", "procedure"}:
            header = scanner._header_fields(decode_source(base)[0])
            if source_type == "page":
                base_identity = header.get("pageId") or path.stem
            else:
                source_path = path.relative_to(root / "procedures" / owner).with_suffix("")
                package = header.get("packageId") or ".".join(source_path.parts[:-1])
                function = header.get("functionId") or source_path.name
                base_identity = f"{package}#{function}"
            if item["source_id"] != base_identity:
                raise ValueError("SVN 源码身份与 BASE 版本不一致")
        if source_index_status(workspace)["buildStatus"] not in {"READY", "PARTIAL"}:
            raise ValueError("SVN 源码索引不可用或需要重建")
        with legacy_source.index_connection(workspace, action="legacy-direct-edit-index", readonly=True) as conn:
            rows = conn.execute(
                "SELECT * FROM gusen_source_record WHERE provider='svn' AND scope_id=? AND source_path=?",
                (workspace["scopeId"], logical),
            ).fetchall()
            if len(rows) != 1 or rows[0]["status"] not in {"OK", "SVN_DIRTY"}:
                raise ValueError("SVN 源码没有唯一且可用的索引身份")
            previous = dict(rows[0])
            if Path(previous["local_path"]).resolve() != path:
                raise ValueError("SVN 索引中的物理路径与登记源码不一致")
            for key in ("source_table", "source_id", "fun_id", "system_id", "data_source_id"):
                if (previous.get(key) or "") != (item.get(key) or ""):
                    raise ValueError("SVN 源码身份与索引身份不一致")
            duplicates = conn.execute(
                "SELECT source_path FROM gusen_source_record WHERE provider='svn' AND scope_id=? "
                "AND source_table=? AND source_id=? AND fun_id=? AND source_path<>?",
                (workspace["scopeId"], item["source_table"], item["source_id"], item.get("fun_id") or "", logical),
            ).fetchall()
            if duplicates:
                raise ValueError("SVN 源码身份对应多个索引路径")
            current = index_item_current(conn, previous, item)
        if refresh:
            if not current:
                with legacy_source.index_connection(workspace, action="legacy-direct-edit-index", readonly=False) as conn:
                    try:
                        conn.execute("BEGIN IMMEDIATE")
                        legacy_source._delete_svn_index_item(conn, workspace, previous)
                        legacy_source._insert_svn_index_item(conn, workspace, item, legacy_source._now())
                        legacy_source._advance_page_semantic_generation(conn)
                        conn.commit()
                    except BaseException:
                        conn.rollback()
                        raise
            with legacy_source.index_connection(workspace, action="legacy-direct-edit-index", readonly=True) as conn:
                rows = conn.execute(
                    "SELECT * FROM gusen_source_record WHERE provider='svn' AND scope_id=? AND source_path=?",
                    (workspace["scopeId"], logical),
                ).fetchall()
                if (len(rows) != 1 or rows[0]["source_hash"] != digest
                        or not index_item_current(conn, dict(rows[0]), item)):
                    raise ValueError("SVN 刷新后的索引与当前源码哈希不一致")
            checkout.run_svn_binary(["diff", "--", str(path)])
        if checkout.file_hash(path) != digest:
            raise ValueError("SVN 源码在检查或索引核验期间发生变化")
        result = {"sourceHash": digest, "modified": modified}
        if refresh:
            result["indexedHash"] = digest
        return result
