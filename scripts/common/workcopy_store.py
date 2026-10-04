"""Workcopy mirror comparison, preservation, recovery and delivery lifecycle.

The gusen_hub facade owns runtime overrides and shared provider APIs. Calls use
that facade to preserve its public API and host monkeypatch boundaries while
keeping the lifecycle implementation here.
"""
from __future__ import annotations

import argparse
import datetime as dt
import difflib
import json
import shutil
from pathlib import Path

def _work_copy_change_key(row):
    return hub._str(hub._row_value(row, "change_key"))


def _tree_files(root: Path, exclude_work_copy_files=False):
    if not root or not root.exists():
        return {}
    files = {}
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(root)
        if exclude_work_copy_files and (
            rel.parts[0] == hub.LEGACY_WORK_COPY_BASELINE_DIR or rel.as_posix() in hub.WORK_COPY_COMPARE_EXCLUDED_FILES
        ):
            continue
        files[rel.as_posix()] = path
    return files


def _tree_changes(before: Path, after: Path, after_is_work_copy=False):
    before_files = hub._tree_files(before, after_is_work_copy)
    after_files = hub._tree_files(after, after_is_work_copy)
    changes = []
    for rel in sorted(set(before_files) | set(after_files)):
        if rel not in before_files:
            status = "A"
        elif rel not in after_files:
            status = "D"
        elif before_files[rel].read_bytes() != after_files[rel].read_bytes():
            status = "M"
        else:
            continue
        changes.append({"status": status, "path": rel})
    return changes


def _work_copy_metadata(target: Path):
    path = target / hub.WORK_COPY_META_FILE
    if not path.exists():
        raise SystemExit(f"工作副本缺少 {hub.WORK_COPY_META_FILE}: {target}")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SystemExit(f"工作副本元数据无效: {path}: {exc}") from exc


def _display_path(path: Path):
    try:
        return str(path.resolve().relative_to(Path(hub.ROOT).resolve()))
    except ValueError:
        return str(path.resolve())


def _write_work_copy_metadata(target: Path, row, source_path: Path, mode: str):
    old = {}
    meta_path = target / hub.WORK_COPY_META_FILE
    if meta_path.exists():
        try:
            old = json.loads(meta_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            old = {}
    old_work_copy = old.get("_workcopy") or {}
    metadata = dict(row)
    metadata["_workcopy"] = {
        "format": 2,
        "mode": mode,
        "createdAt": old_work_copy.get("createdAt") or hub._now(),
        "updatedAt": hub._now(),
        "sourcePath": hub._display_path(source_path),
    }
    meta_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _replace_work_copy_source(source_path: Path, target: Path):
    for child in target.iterdir():
        if child.name in hub.WORK_COPY_MANAGED_FILES:
            continue
        if child.is_dir() and not child.is_symlink():
            shutil.rmtree(child)
        else:
            child.unlink()
    shutil.copytree(source_path, target, dirs_exist_ok=True)


def _manual_diff_notes(target: Path):
    path = target / hub.WORK_COPY_DIFF_FILE
    if not path.exists():
        return ""
    lines = path.read_text(encoding="utf-8").splitlines()
    if not lines or lines[0].strip() != "# 修改说明":
        return ""
    notes = []
    for line in lines[1:]:
        if line.startswith("# "):
            break
        notes.append(line)
    return "\n".join(notes).strip()


def _json_path_changes(before, after, path="$", output=None, limit=200):
    output = [] if output is None else output
    if len(output) >= limit:
        return output
    if isinstance(before, dict) and isinstance(after, dict):
        for key in sorted(set(before) | set(after)):
            child = f"{path}.{key}"
            if key not in before:
                output.append(f"A {child}")
            elif key not in after:
                output.append(f"D {child}")
            else:
                hub._json_path_changes(before[key], after[key], child, output, limit)
            if len(output) >= limit:
                break
    elif isinstance(before, list) and isinstance(after, list):
        if len(before) != len(after):
            output.append(f"M {path}.length ({len(before)} -> {len(after)})")
        for index, (left, right) in enumerate(zip(before, after)):
            hub._json_path_changes(left, right, f"{path}[{index}]", output, limit)
            if len(output) >= limit:
                break
    elif before != after:
        output.append(f"M {path}")
    return output


def _render_file_diff(before: Path, after: Path, rel: str):
    if rel == "raw.json" and (not before.exists() or not after.exists()):
        return ["JSON 文件新增。" if after.exists() else "JSON 文件删除。"]
    if rel == "raw.json" and before.exists() and after.exists():
        try:
            changes = hub._json_path_changes(
                json.loads(before.read_text(encoding="utf-8")),
                json.loads(after.read_text(encoding="utf-8")),
            )
            lines = ["JSON 路径变化：", ""] + [f"    {line}" for line in changes]
            if len(changes) == 200:
                lines.append("    ... 仅展示前 200 个路径")
            return lines
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            pass
    try:
        before_lines = before.read_text(encoding="utf-8").splitlines() if before.exists() else []
        after_lines = after.read_text(encoding="utf-8").splitlines() if after.exists() else []
    except UnicodeDecodeError:
        return ["二进制文件发生变化。"]
    diff = list(
        difflib.unified_diff(
            before_lines,
            after_lines,
            fromfile=f"readonly/{rel}",
            tofile=f"workcopy/{rel}",
            lineterm="",
        )
    )
    # ponytail: reports cap each file at 400 lines; inspect the source file directly when a larger diff matters.
    rendered = [f"    {line}" for line in diff[:400]]
    if len(diff) > 400:
        rendered.append(f"    ... 已省略 {len(diff) - 400} 行")
    return rendered or ["文件内容发生变化。"]


def _work_copy_state(target: Path, upstream_path: Path | None, upstream_change_key=""):
    upstream_missing = not upstream_path or not upstream_path.exists()
    local_changes = [] if upstream_missing else hub._tree_changes(upstream_path, target, after_is_work_copy=True)
    if upstream_missing:
        state = "UPSTREAM_MISSING"
    elif local_changes:
        state = "LOCAL_CHANGED"
    else:
        state = "CLEAN"
    return {
        "path": str(target),
        "state": state,
        "localChanged": bool(local_changes),
        "upstreamMissing": upstream_missing,
        "upstreamChangeKey": upstream_change_key,
        "localChanges": local_changes,
        "upstreamPath": str(upstream_path) if upstream_path else "",
    }


def _write_work_copy_diff(target: Path, status: dict, notes=""):
    labels = {
        "CLEAN": "无变化",
        "LOCAL_CHANGED": "与 readonly 不一致",
        "UPSTREAM_MISSING": "上游源码不存在",
    }
    lines = [
        "# 修改说明",
        "",
        notes,
        "",
        "# Workcopy 状态",
        "",
        f"- 状态：`{status['state']}`（{labels[status['state']]}）",
        f"- Readonly 版本：`{status['upstreamChangeKey'] or '-'}`",
        f"- 差异文件：{len(status['localChanges'])}",
        "",
        "# 差异文件汇总",
        "",
    ]
    if status["localChanges"]:
        lines.extend(f"- `{change['status']}` `{change['path']}`" for change in status["localChanges"])
    else:
        lines.append("- 无")
    lines.extend(["", "# Diff", ""])
    readonly = Path(status["upstreamPath"]) if status["upstreamPath"] else None
    for change in status["localChanges"]:
        rel = change["path"]
        lines.extend([f"## {change['status']} `{rel}`", ""])
        lines.extend(hub._render_file_diff(readonly / rel, target / rel, rel))
        lines.append("")
    if not status["localChanges"]:
        lines.append("无本地源码差异。")
    (target / hub.WORK_COPY_DIFF_FILE).write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")


def _write_work_copy_delivery(target: Path, status: dict):
    lines = [
        "# Workcopy 交付清单",
        "",
        f"- 状态：`{status['state']}`",
        f"- Readonly 版本：`{status['upstreamChangeKey'] or '-'}`",
        "",
    ]
    if status["state"] == "UPSTREAM_MISSING":
        lines.extend(["> 当前状态不可直接交付，请先处理上游变化。", ""])
    lines.extend(["## 需要回写或复核的文件", ""])
    if status["localChanges"]:
        lines.extend(f"- [ ] `{change['status']}` `{change['path']}`" for change in status["localChanges"])
    else:
        lines.append("- 无本地修改")
    lines.extend(
        [
            "",
            "## 交付检查",
            "",
            "- [ ] 已查看 `diff.md`",
            "- [ ] 已在谷神开发平台完成手工回写",
            "- [ ] 已重新拉取并确认上游版本",
        ]
    )
    path = target / hub.WORK_COPY_DELIVERY_FILE
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def _initialize_work_copy(source_path: Path, target: Path, row, change_key: str, mode: str):
    shutil.copytree(source_path, target)
    hub._write_work_copy_metadata(target, row, source_path, mode)
    status = hub._work_copy_state(target, source_path, change_key)
    status["action"] = "CREATED"
    return status


def _trash_work_copy(target: Path) -> Path:
    """Move an overwritten workcopy into a timestamped trash directory instead of deleting it."""
    stamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    destination = target.parent / hub.WORK_COPY_TRASH_DIR / stamp / target.name
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(target), str(destination))
    return destination


def _prepare_work_copy(source_path: Path, target: Path, row, change_key: str, mode="mirror", diff_check=True):
    if not diff_check:
        action = "OVERWRITTEN" if target.exists() else "CREATED"
        backup = hub._trash_work_copy(target) if target.exists() else None
        try:
            shutil.copytree(source_path, target)
            hub._write_work_copy_metadata(target, row, source_path, mode)
        except Exception:
            if target.exists():
                shutil.rmtree(target)
            if backup:
                shutil.move(str(backup), str(target))
            raise
        return {"path": str(target), "state": "UNCHECKED", "action": action,
                "localChanged": False, "backupPath": str(backup) if backup else ""}
    if not target.exists():
        return hub._initialize_work_copy(source_path, target, row, change_key, mode)
    legacy_baseline = target / hub.LEGACY_WORK_COPY_BASELINE_DIR
    if legacy_baseline.exists():
        shutil.rmtree(legacy_baseline)
    notes = hub._manual_diff_notes(target)
    status = hub._work_copy_state(target, source_path, change_key)
    if status["localChanged"]:
        hub._write_work_copy_metadata(target, row, source_path, mode)
        status["action"] = "PRESERVED"
        hub._write_work_copy_diff(target, status, notes)
        return status
    hub._replace_work_copy_source(source_path, target)
    hub._write_work_copy_metadata(target, row, source_path, mode)
    status = hub._work_copy_state(target, source_path, change_key)
    status["action"] = "UNCHANGED"
    if (target / hub.WORK_COPY_DIFF_FILE).exists():
        hub._write_work_copy_diff(target, status, notes)
    return status


def _current_work_copy_source(metadata: dict):
    if metadata.get("source_table") == "system-script":
        source_path = Path((metadata.get("_workcopy") or {}).get("sourcePath") or "")
        source_path = source_path if source_path.is_absolute() else hub.ROOT / source_path
        if not source_path.exists():
            return None, None, ""
        try:
            source_meta = json.loads((source_path / "meta.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None, source_path, ""
        return metadata, source_path, hub._str(source_meta.get("changeKey"))
    cfg = hub.load_config()
    workspace = hub.resolve_workspace(cfg, metadata.get("workspaceKey"))
    source_type = metadata.get("source_table") or ""
    alias = metadata.get("source_alias_id") or ""
    fun = metadata.get("fun_id") or ""
    project_id = metadata.get("project_id") or ""

    def lookup(conn):
        if project_id:
            row = conn.execute(
                """
                SELECT * FROM gusen_source_record
                WHERE source_layer='PROJECT' AND project_id=? AND source_table=? AND source_alias_id=? AND fun_id=?
                """,
                (project_id, source_type, alias, fun),
            ).fetchone()
        else:
            row = conn.execute(
                """
                SELECT * FROM gusen_source_record
                WHERE source_layer='PRODUCT' AND scope_id=? AND source_table=? AND source_alias_id=? AND fun_id=?
                """,
                (metadata.get("scope_id") or "", source_type, alias, fun),
            ).fetchone()
        if not row:
            return None, None, ""
        path = hub.ROOT / row["local_path"]
        return row, path, hub._work_copy_change_key(row)

    if workspace.get("sourceMode") == "svn":
        with hub.index_connection(workspace, action="workcopy-status-read", readonly=True) as conn:
            return lookup(conn)
    conn = hub.connect_index(workspace["indexPath"])
    try:
        return lookup(conn)
    finally:
        conn.close()


def inspect_work_copy(path):
    target = Path(path).expanduser()
    target = target if target.is_absolute() else hub.ROOT / target
    target = target.resolve()
    root = hub.work_copy_dir().resolve()
    if target != root and root not in target.parents:
        raise SystemExit(f"路径不在 workcopy 目录下: {target}")
    while target != root and not (target / hub.WORK_COPY_META_FILE).exists():
        target = target.parent
    if not (target / hub.WORK_COPY_META_FILE).exists():
        raise SystemExit(f"未找到工作副本元数据: {path}")
    metadata = hub._work_copy_metadata(target)
    _row, source_path, change_key = hub._current_work_copy_source(metadata)
    return target, hub._work_copy_state(target, source_path, change_key)


def restore_work_copy(workspace, backup_path, *, confirmation="", check_only=False):
    root = workspace["workcopyDir"].resolve()
    backup = Path(backup_path).expanduser().resolve()
    if not backup.is_relative_to(root) or hub.WORK_COPY_TRASH_DIR not in backup.relative_to(root).parts:
        raise SystemExit("backup must be inside this workspace workcopy trash")
    if not backup.is_dir() or not (backup / hub.WORK_COPY_META_FILE).is_file():
        raise SystemExit("backup does not contain valid workcopy metadata")
    trash = backup.parent.parent
    if trash.name != hub.WORK_COPY_TRASH_DIR:
        raise SystemExit("backup must identify an exact timestamped workcopy directory")
    target = trash.parent / backup.name
    metadata = hub._work_copy_metadata(backup)
    if metadata.get("workspaceKey") != workspace["workspaceKey"]:
        raise SystemExit("backup workspaceKey does not match the selected workspace")
    result = {"ok": True, "backupPath": str(backup), "targetPath": str(target), "checkOnly": check_only}
    if check_only:
        return result
    if confirmation != workspace["workspaceKey"]:
        raise SystemExit("workcopy restore requires --confirmation with the exact workspaceKey")
    with hub.file_lock(workspace["contextDir"] / ".workcopy.lock"):
        displaced = hub._trash_work_copy(target) if target.exists() else None
        try:
            shutil.move(str(backup), str(target))
        except Exception:
            if displaced:
                shutil.move(str(displaced), str(target))
            raise
    return {**result, "displacedBackupPath": str(displaced) if displaced else ""}


def work_copy_cli(args=None):
    parser = argparse.ArgumentParser(description="检查和打包 Guthon workcopy")
    parser.add_argument("command", choices=["status", "diff", "package", "save-svn", "trash-list", "restore"])
    parser.add_argument("path", nargs="?", default="")
    parser.add_argument("--confirmation", default="")
    parser.add_argument("--check", action="store_true", help="validate and preview SVN writeback without writing")
    parser.add_argument("--json", action="store_true")
    parsed = parser.parse_args(args)
    cfg = hub.load_config()
    workspace = hub.resolve_workspace(cfg)
    if parsed.command == "trash-list":
        root = workspace["workcopyDir"]
        backups = [str(path.parent) for path in root.rglob(hub.WORK_COPY_META_FILE)
                   if hub.WORK_COPY_TRASH_DIR in path.relative_to(root).parts and not path.is_symlink()]
        result = {"ok": True, "workspaceKey": workspace["workspaceKey"], "backups": sorted(backups)}
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return result
    if not parsed.path:
        parser.error("path is required for this workcopy action")
    if parsed.command == "restore":
        result = hub.restore_work_copy(workspace, parsed.path, confirmation=parsed.confirmation, check_only=parsed.check)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return result
    if workspace.get("sourceMode") == "svn":
        from providers.svn import writeback

        if parsed.command == "package":
            raise SystemExit("SVN Workcopy uses save-svn --check and svn diff instead of database delivery packaging")
        if parsed.command == "save-svn" or parsed.command == "diff":
            result = writeback.save(workspace, Path(parsed.path), check_only=parsed.check or parsed.command == "diff")
            if parsed.command == "save-svn" and not parsed.check and result.get("changed"):
                conn = hub.connect_index_for_workspace(
                    workspace,
                    action="index-init",
                    rebuild_incompatible=True,
                )
                try:
                    result["reindex"] = hub.index_svn_workspace(conn, cfg, workspace)
                finally:
                    conn.close()
                if result["reindex"].get("failures"):
                    result.update({
                        "ok": False,
                        "status": "SVN_DIRTY_REINDEX_FAILED",
                        "message": "SVN 写回成功，但本地索引重建失败；旧索引已保留",
                    })
        else:
            result = writeback.inspect_status(workspace, Path(parsed.path))
        if parsed.json:
            print(json.dumps(result, ensure_ascii=False, indent=2))
        else:
            print(f"状态: {result.get('state') or result.get('status') or ('可写回' if result.get('changed') else '无变化')}")
            if result.get("diff"):
                print(result["diff"])
            if result.get("svnDiff"):
                print(result["svnDiff"])
            if parsed.command == "save-svn" and not parsed.check:
                print("已写回本地 SVN working copy；请执行 svn diff 审阅后人工 commit")
                if result.get("reindex", {}).get("failures"):
                    print("警告: 本地索引重建失败，旧索引已保留；修复扫描错误后重新执行 reindex")
        return result
    target, status = hub.inspect_work_copy(parsed.path)
    output = None
    if parsed.command in {"diff", "package"}:
        hub._write_work_copy_diff(target, status, hub._manual_diff_notes(target))
        output = target / hub.WORK_COPY_DIFF_FILE
    if parsed.command == "package":
        output = hub._write_work_copy_delivery(target, status)
    result = {**status, "output": str(output) if output else ""}
    if parsed.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return
    print(f"状态: {status['state']}")
    print(f"与 readonly 差异: {len(status['localChanges'])}")
    print(f"Readonly 版本: {status['upstreamChangeKey'] or '-'}")
    if output:
        print(f"输出: {output}")


def create_work_copy(args=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--type", required=True, choices=sorted(hub.SVN_SOURCE_TYPES))
    parser.add_argument("--source-id", default="")
    parser.add_argument("--alias", default="")
    parser.add_argument("--fun", default="")
    parsed = parser.parse_args(args)
    cfg = hub.load_config()
    workspace = hub.resolve_workspace(cfg)
    layer, scope_id, project_id, _layer_cfg = hub.resolve_pull_scope(cfg, {"workspaceKey": workspace["workspaceKey"]})
    if workspace.get("sourceMode") == "svn":
        with hub.index_connection(workspace, action="workcopy-read", readonly=True) as conn:
            row = hub.find_svn_source(conn, workspace, parsed.type, parsed.source_id, parsed.alias, parsed.fun)
            result = hub.create_work_copy_from_row(conn, cfg, row, workspace)
    else:
        conn = hub.connect_index(workspace["indexPath"])
        try:
            if not parsed.alias:
                raise SystemExit("--alias is required in database source mode")
            row = hub.find_work_copy_source(
                conn,
                scope_id if layer == "PRODUCT" else None,
                project_id or None,
                parsed.type,
                parsed.alias,
                parsed.fun,
            )
            result = hub.create_work_copy_from_row(conn, cfg, row, workspace)
        finally:
            conn.close()
    print(result["path"])


def create_work_copy_from_row(conn, cfg, row, workspace, diff_check=True):
    row_dict = dict(row) if not isinstance(row, dict) else row
    if row_dict.get("provider") == "svn" or workspace.get("sourceMode") == "svn":
        from providers.svn import projection

        hub.svn_checkout.require_capability(workspace, "workcopy")
        return projection.open_workcopy(workspace, row_dict, hub.svn_checkout.load_scope(workspace))
    scope_id = workspace["scopeId"]
    project_id = workspace["projectId"]
    found = hub.find_work_copy_source(
        conn,
        scope_id=scope_id if not project_id else None,
        project_id=project_id,
        source_type=row["source_table"],
        alias=hub._source_alias_id(row),
        fun=row["fun_id"] or "",
    )
    source_rel = found["local_path"]
    source_path = hub.ROOT / source_rel
    target = workspace["workcopyDir"] / hub._work_copy_source_relative_path(source_path, workspace)
    work_row = dict(found)
    work_row["workspaceKey"] = workspace["workspaceKey"]
    before_files = set(path.resolve() for path in target.rglob("*") if path.is_file()) if target.exists() else set()
    with hub.file_lock(workspace["contextDir"] / ".workcopy.lock"):
        result = hub._prepare_work_copy(source_path, target, work_row, hub._work_copy_change_key(found), diff_check=diff_check)
    outputs = {target / path.relative_to(source_path) for path in source_path.rglob("*") if path.is_file()}
    outputs.add(target / hub.WORK_COPY_META_FILE)
    hub.record_generated_files(outputs)
    result.update(hub._auto_add_work_copy(cfg, target, outputs - before_files))
    return result


def _work_copy_source_relative_path(source_path, workspace):
    try:
        return Path(source_path).resolve().relative_to(workspace["readonlyDir"].resolve())
    except ValueError as error:
        raise ValueError(f"Source path is outside workspace readonly: {source_path}") from error


# Load the facade after defining aliases, so either import order is supported.
from common import gusen_hub as hub
