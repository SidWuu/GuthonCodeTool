"""Private DATABASE publication evidence, separate from refreshable Workcopy metadata."""
from __future__ import annotations

import base64
import hashlib
import json
from importlib.resources import files
from pathlib import Path

from common.page_comparison import same_json_value
from common.page_projection import comparable_script
from common.persistence import atomic_bytes, atomic_text


_FIELDS = ("source_layer", "scope_id", "project_id", "system_id", "data_source_id",
           "source_table", "source_id", "source_alias_id", "fun_id")

_PAGE_DEFAULTS = json.loads(files("common").joinpath("database_page_defaults.json").read_text(encoding="utf-8"))


def source_identity(workspace, row):
    return {"workspaceKey": workspace["workspaceKey"], **{key: row[key] for key in _FIELDS}}


def page_publication_model(value, *, comparable=True, page_alias=None):
    native_comparison = comparable and page_alias is not None

    def project(node, location=()):
        if isinstance(node, dict):
            defaults = (_PAGE_DEFAULTS.get("/".join(location[-2:]), {})
                        if native_comparison and (not location or location[0] == "views") else {})
            result = {}
            for key, item in node.items():
                if comparable:
                    if type(item) in (int, float) and (item == defaults.get(key)
                            or (item == 0 and key in {"scale", "length"} and node.get("tbId") and node.get("fdId"))):
                        continue
                    if not location and key == "pageAliasId" and page_alias and item == page_alias:
                        continue
                    if node.get("pageId") and key == "pageType" and type(item) in (str, int):
                        item = str(item)
                result[key] = project(item, (*location, key))
            return result
        if isinstance(node, list):
            items = (*location[:-1], f"{location[-1] if location else ''}[]")
            return [project(item, items) for item in node]
        if comparable and isinstance(node, str):
            return node.replace("\r\n", "\n")
        if native_comparison and isinstance(node, float) and node.is_integer():
            return int(node)
        # The designer represents long native identifiers as strings.
        if type(node) is int and abs(node) >= 10**15:
            return str(node)
        return node

    return project(value)


def same_page_workcopy(before, after):
    if str(before.get("pageType")) == str(after.get("pageType")) == "0":
        scripts = [page.get("compScript") for page in (before, after)]
        if all(isinstance(script, str) for script in scripts):
            return comparable_script(scripts[0]) == comparable_script(scripts[1])
    return same_json_value(page_publication_model(before), page_publication_model(after))


def workcopy_baseline(workspace, row, source_path, current_hash, *, capture=None, candidate_hash=None, match_candidate=True):
    """Read immutable edit evidence, or start a new draft from verified mirror bytes."""
    identity = source_identity(workspace, row)
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
        if match_candidate and record["candidateHash"] != current_hash:
            return None, None
        content = base64.b64decode(record["sourceBytes"], validate=True)
        if (record["identity"] != identity or record["sourcePath"] != source_path
                or record["sourceHash"] != hashlib.sha256(content).hexdigest()):
            raise ValueError("发布基线与当前源码身份或摘要不一致")
    if candidate_hash is not None:
        record["candidateHash"] = candidate_hash
        atomic_text(path, json.dumps(record, ensure_ascii=False))
    return record, content


def same_workcopy_source(row, before, after):
    from common.source_format import decode_source
    from common.database_workcopy_edit import _page

    if before == after:
        return True
    left, right = (decode_source(content)[0] for content in (before, after))
    if row["source_table"] == "procedure":
        return comparable_script(left) == comparable_script(right)
    try:
        return same_page_workcopy(_page(left, row["source_id"])[1], _page(right, row["source_id"])[1])
    except (ValueError, RecursionError):
        return False


def capture_clean_workcopy(workspace, row, source_dir):
    """Record the clean copy against the preceding mirror before synchronization replaces it."""
    from common.database_workcopy_edit import _bytes, _digest
    from common import legacy_source as hub

    root = workspace["readonlyDir"].resolve()
    filename = "raw.json" if row["source_table"] == "page" else "source.vm"
    source = source_dir / filename
    if source.resolve() != source or not source.is_relative_to(root):
        return
    relative = source.relative_to(root).as_posix()
    target = workspace["workcopyDir"].resolve() / relative
    if not target.is_file() or target.resolve() != target or not source.is_file():
        return
    with hub.file_lock(workspace["contextDir"] / ".workcopy.lock"):
        try:
            before, current = _bytes(source), _bytes(target)
        except (OSError, ValueError):
            return
        if same_workcopy_source(row, before, current):
            workcopy_baseline(workspace, row, relative, _digest(current),
                              capture=before, candidate_hash=_digest(current))


def reviewable_workcopies(workspace, *, include_unindexed=False):
    """List DATABASE drafts with the state of their editing baseline."""
    from common import legacy_source as hub
    from common.database_workcopy_edit import _bytes, _digest, _page
    from common.legacy_source_read import _record, local_changes
    from common.source_format import decode_source

    if not include_unindexed:
        if not workspace["indexPath"].is_file():
            return []
        return sorted(local_changes(workspace, include_records=True)["items"], key=lambda item: item["sourcePath"])

    directory = workspace["contextDir"].resolve() / "database-source-publish" / "baselines"
    if directory.resolve() != directory:
        raise ValueError("发布基线路径包含符号链接")
    if not directory.is_dir() and (include_unindexed or not workspace["indexPath"].is_file()):
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
                before, after = (decode_source(_bytes(file))[0] for file in (mirror, target))
                if identity["source_table"] == "page":
                    before, after = (_page(text, identity["source_id"])[1] for text in (before, after))
                    matches = same_page_workcopy(before, after)
                else:
                    matches = before == after
                if matches:
                    continue
            items.append({**(source if indexed else {"sourcePath": source_path}), "trustedBaseline": indexed and trusted,
                          "needsMerge": not indexed or not trusted or baseline["sourceVersion"] != row["version_mac"]})
    return sorted(items, key=lambda item: item["sourcePath"])


def assert_no_registered_drafts(workspace):
    from common.command_errors import CommandError

    drafts = reviewable_workcopies(workspace, include_unindexed=True)
    if drafts:
        raise CommandError("DATABASE_WORKCOPY_DRAFTS_PENDING",
                           f"当前项目仍有 {len(drafts)} 项已登记的源码草稿，请备份后处理工作副本，再切换或删除项目")



def advance_workcopy_baseline(workspace, indexed, *, base_version, reviewed_workcopy_hash=None,
                              merged_workcopy=False, platform_differs=False):
    from common.database_workcopy_edit import _bytes, _digest, _page, record_cli_file_versions
    from common.source_format import decode_source
    from common import legacy_source as hub

    mirror_root = workspace["readonlyDir"].resolve()
    is_page = indexed["source_table"] == "page"
    mirror = (hub.ROOT / indexed["local_path"] / ("raw.json" if is_page else "source.vm")).resolve()
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
    approved_copy = candidate_hash == reviewed_workcopy_hash
    if merged_workcopy:
        # Advancing to a new baseline with the pre-merge draft still on disk
        # would turn the preserved upstream edits into apparent deletions.
        if not same_workcopy_source(indexed, current, published):
            if platform_differs or not approved_copy:
                return "CONFLICT"
            if _bytes(copy) != current:
                return "CONFLICT"
            atomic_bytes(copy, published)
            candidate_hash = _digest(published)
            warning = record_cli_file_versions(workspace, indexed["source_id"], copy, {copy: candidate_hash})
            if warning:
                raise ValueError(warning)
        workcopy_baseline(workspace, indexed, relative, candidate_hash, capture=published, candidate_hash=candidate_hash)
        return "CLEAN"
    if not approved_copy and (baseline is None or baseline["sourceVersion"] not in {base_version, indexed["version_mac"]}):
        return "CONFLICT"
    if baseline is None or baseline["sourceVersion"] != indexed["version_mac"]:
        workcopy_baseline(workspace, indexed, relative, candidate_hash,
                          capture=published, candidate_hash=candidate_hash)
    before, after = (decode_source(value)[0] for value in (current, published))
    if is_page:
        before, after = (_page(value, indexed["source_id"])[1] for value in (before, after))
        return "CLEAN" if same_page_workcopy(before, after) else "EDITED"
    return "CLEAN" if comparable_script(before) == comparable_script(after) else "EDITED"


def assert_no_pending_publications(workspace):
    from common.command_errors import CommandError

    directory = workspace["spaceRoot"] / "nexus" / "bridge" / "database-publication"
    for path in directory.glob("*.json"):
        record = json.loads(path.read_text(encoding="utf-8"))
        if (record["workspaceKey"] == workspace["workspaceKey"] and record["state"] == "PLATFORM_UNKNOWN"
                and not any(path.with_suffix(path.suffix + suffix).is_file() for suffix in (".verified", ".rejected"))):
            raise CommandError("DATABASE_PUBLICATION_PENDING", "当前项目有待核验的源码上传，请先查询原操作")
