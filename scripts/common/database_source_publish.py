"""Private DATABASE publication evidence, separate from refreshable Workcopy metadata."""
from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path

from common.persistence import atomic_text


_FIELDS = ("source_layer", "scope_id", "project_id", "system_id", "data_source_id",
           "source_table", "source_id", "source_alias_id", "fun_id")


def workcopy_baseline(workspace, row, source_path, current_hash, *, capture=None, candidate_hash=None):
    """Read immutable edit evidence, or start a new draft from verified mirror bytes."""
    identity = {"workspaceKey": workspace["workspaceKey"], **{key: row[key] for key in _FIELDS}}
    key = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
    root = Path(workspace["contextDir"]).resolve()
    path = root / "database-source-publish" / "baselines" / f"{key}.json"
    if path.resolve() != path:
        raise ValueError("发布基线路径包含符号链接")
    if capture is not None:
        record = {"identity": identity, "sourcePath": source_path, "sourceVersion": row["version_mac"],
                  "changeKey": row["change_key"], "sourceHash": hashlib.sha256(capture).hexdigest(),
                  "sourceBytes": base64.b64encode(capture).decode("ascii")}
        content = capture
    else:
        if not path.is_file():
            return None, None
        record = json.loads(path.read_text(encoding="utf-8"))
        if record["candidateHash"] != current_hash:
            return None, None
        content = base64.b64decode(record["sourceBytes"], validate=True)
        if (record["identity"] != identity or record["sourcePath"] != source_path
                or record["sourceHash"] != hashlib.sha256(content).hexdigest()):
            raise ValueError("发布基线与当前源码身份或摘要不一致")
    if candidate_hash is not None:
        record["candidateHash"] = candidate_hash
        atomic_text(path, json.dumps(record, ensure_ascii=False))
    return record, content


def reviewable_workcopies(workspace, *, include_unindexed=False):
    """List registered procedure drafts without walking the synchronized source tree."""
    from common import legacy_source as hub
    from common.database_workcopy_edit import _bytes, _digest
    from common.legacy_source_read import _record
    from common.source_format import decode_source

    directory = workspace["contextDir"].resolve() / "database-source-publish" / "baselines"
    if not directory.is_dir() or directory.resolve() != directory:
        return []
    copy_root = workspace["workcopyDir"].resolve()
    items = []
    with hub.index_connection(workspace, action="database-workcopy-review") as conn:
        for file in directory.glob("*.json"):
            if not file.is_file() or file.is_symlink():
                continue
            baseline = json.loads(file.read_text(encoding="utf-8"))
            identity = baseline["identity"]
            if identity["workspaceKey"] != workspace["workspaceKey"] or identity["scope_id"] != workspace["scopeId"]:
                continue
            row = conn.execute("SELECT * FROM gusen_source_record WHERE provider='database' AND " +
                               " AND ".join(f"{key}=?" for key in _FIELDS),
                               tuple(identity[key] for key in _FIELDS)).fetchone()
            source = _record(workspace, row) if row is not None else None
            source_path = baseline["sourcePath"]
            indexed = source is not None and source["sourcePath"] == source_path
            if not indexed and not include_unindexed:
                continue
            target = copy_root / source_path
            if not target.is_relative_to(copy_root) or target.resolve() != target or not target.is_file():
                continue
            current_hash = _digest(_bytes(target))
            if current_hash == baseline["sourceHash"]:
                continue
            trusted = current_hash == baseline["candidateHash"]
            mirror = workspace["readonlyDir"].resolve() / source_path
            if indexed and mirror.resolve() == mirror and mirror.is_file():
                if decode_source(_bytes(mirror))[0] == decode_source(_bytes(target))[0]:
                    continue
            items.append({**(source if indexed else {"sourcePath": source_path}), "trustedBaseline": indexed and trusted})
    return sorted(items, key=lambda item: item["sourcePath"])


def assert_no_registered_drafts(workspace):
    from common.command_errors import CommandError

    drafts = reviewable_workcopies(workspace, include_unindexed=True)
    if drafts:
        raise CommandError("DATABASE_WORKCOPY_DRAFTS_PENDING",
                           f"当前项目仍有 {len(drafts)} 项已登记的过程函数草稿，请备份后处理工作副本，再切换或删除项目")



def advance_workcopy_baseline(workspace, indexed, *, base_version):
    from common.database_workcopy_edit import _bytes, _digest
    from common.source_format import decode_source
    from common import legacy_source as hub

    mirror_root = workspace["readonlyDir"].resolve()
    mirror = (hub.ROOT / indexed["local_path"] / "source.vm").resolve()
    relative = mirror.relative_to(mirror_root).as_posix()
    copy = workspace["workcopyDir"].resolve() / relative
    if copy.resolve() != copy:
        return "CONFLICT"
    if not copy.exists():
        return "ABSENT"
    if not copy.is_file():
        return "CONFLICT"
    current = _bytes(copy)
    candidate_hash = _digest(current)
    baseline, _ = workcopy_baseline(workspace, indexed, relative, candidate_hash)
    published = _bytes(mirror)
    if baseline is None or baseline["sourceVersion"] not in {base_version, indexed["version_mac"]}:
        return "CONFLICT"
    if baseline["sourceVersion"] != indexed["version_mac"]:
        workcopy_baseline(workspace, indexed, relative, candidate_hash,
                          capture=published, candidate_hash=candidate_hash)
    return "CLEAN" if decode_source(current)[0] == decode_source(published)[0] else "EDITED"


def assert_no_pending_publications(workspace):
    from common.command_errors import CommandError

    directory = workspace["spaceRoot"] / "nexus" / "bridge" / "database-publication"
    for path in directory.glob("*.json"):
        record = json.loads(path.read_text(encoding="utf-8"))
        if (record["workspaceKey"] == workspace["workspaceKey"] and record["state"] == "PLATFORM_UNKNOWN"
                and not any(path.with_suffix(path.suffix + suffix).is_file() for suffix in (".verified", ".rejected"))):
            raise CommandError("DATABASE_PUBLICATION_PENDING", "当前项目有待核验的过程函数发布，请先查询原操作")
