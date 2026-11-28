"""Merge DATABASE Workcopy changes against a fresh native readback."""

import heapq
import json

from common.database_source_publish import page_publication_model
from common.inheritance import project as project_inheritance
from common.page_comparison import member_identity, same_json_value
from common.page_projection import comparable_script, is_script_key, json_pointer
from common.source_merge import merge_text

_MISSING = object()
_PAGE_IDENTITY = ("pageId", "pageType", "pageAliasId", "systemId", "mkId", "superPageId", "isProduct")


def _equal(left, right):
    if left is _MISSING or right is _MISSING:
        return left is right
    return same_json_value(left, right)


def _keys(items):
    def identity(value):
        key = member_identity(value)
        if key is None and isinstance(value, dict) and value.get("fdId"):
            return "datasource:" + json.dumps([value.get("tbId"), value["fdId"]], ensure_ascii=False)
        return key

    keys = [identity(item) for item in items]
    return keys if all(keys) and len(set(keys)) == len(keys) else None


def _merge_order(base, local, remote, members):
    surviving_base = set(base) & members
    orders = [[key for key in order if key in surviving_base] for order in (base, local, remote)]
    if orders[1] == orders[0]:
        agreed = orders[2]
    elif orders[2] in (orders[0], orders[1]):
        agreed = orders[1]
    else:
        return None

    # Keep the accepted order of existing members. Additions retain their
    # neighbours in both snapshots, with native order as the tie breaker.
    priority = {key: i for i, key in enumerate(dict.fromkeys(remote + local + base))}
    links = {key: set() for key in members}
    incoming = dict.fromkeys(members, 0)
    for order in (agreed, remote, local):
        ordered = [key for key in order if key in members]
        for left, right in zip(ordered, ordered[1:]):
            if order is not agreed and left in surviving_base and right in surviving_base:
                continue
            if right not in links[left]:
                links[left].add(right)
                incoming[right] += 1
    heap = [(priority[key], key) for key in members if incoming[key] == 0]
    heapq.heapify(heap)
    result = []
    while heap:
        _, key = heapq.heappop(heap)
        result.append(key)
        for follower in links[key]:
            incoming[follower] -= 1
            if incoming[follower] == 0:
                heapq.heappush(heap, (priority[follower], follower))
    return result if len(result) == len(members) else None


def _merge_script(base, local, remote, path, conflicts, *, procedure=False):
    if procedure:
        base, local, remote = (comparable_script(value) for value in (base, local, remote))
    else:
        base, local, remote = (value.replace("\r\n", "\n") for value in (base, local, remote))
    if local == base or local == remote:
        return remote
    if remote == base:
        return local
    if any(project_inheritance(value, None)["status"] != "INACTIVE" for value in (base, local, remote)):
        conflicts.append({"path": path, "kind": "inheritance"})
        return remote
    lines = []
    result = merge_text(base, local, remote, lines)
    if result is None:
        conflicts.append({"path": path, "kind": "script", "lines": lines})
        return remote
    return result


def merge_database_source(base, local, remote, *, page_type=None, page_alias=""):
    conflicts = []
    if page_type is None:
        if any(project_inheritance(value, None)["status"] != "INACTIVE" for value in (base, local, remote)):
            return None, [{"path": "", "kind": "inheritance"}]
        merged = _merge_script(base, local, remote, "", conflicts, procedure=True)
        return (None if conflicts else merged), conflicts

    def merge_node(base, local, remote, path=()):
        old, old_key = base
        draft, draft_key = local
        live, live_key = remote
        if _equal(draft_key, old_key) or _equal(draft_key, live_key):
            return live
        live_unchanged = _equal(live_key, old_key)
        same_container = type(old_key) is type(draft_key) is type(live_key) and isinstance(live_key, (dict, list))
        if live_unchanged and (not same_container or _equal(live, old)):
            return draft
        if all(isinstance(value, dict) for value in (old_key, draft_key, live_key)):
            merged = {}
            for key in dict.fromkeys([*live, *draft_key, *old_key]):
                result = merge_node(
                    (old.get(key, _MISSING), old_key.get(key, _MISSING)),
                    (draft.get(key, _MISSING), draft_key.get(key, _MISSING)),
                    (live.get(key, _MISSING), live_key.get(key, _MISSING)),
                    (*path, key),
                )
                if result is not _MISSING:
                    merged[key] = result
            return merged
        if all(isinstance(value, list) for value in (old_key, draft_key, live_key)):
            orders = [_keys(value) for value in (old_key, draft_key, live_key)]
            if all(order is not None for order in orders):
                maps = [dict(zip(order, zip(*items))) for order, items in zip(orders, (base, local, remote))]
                positions = {key: index for index, key in enumerate(orders[2])}
                members = {}
                for key in dict.fromkeys(orders[2] + orders[1] + orders[0]):
                    result = merge_node(*(values.get(key, (_MISSING, _MISSING)) for values in maps),
                                        path=(*path, positions.get(key, key)))
                    if result is not _MISSING:
                        members[key] = result
                order = _merge_order(*orders, set(members))
                if order is not None:
                    return [members[key] for key in order]
            if live_unchanged:
                return draft
            conflicts.append({"path": json_pointer(path), "kind": "collection"})
            return live
        if (path and all(isinstance(value, str) for value in (old, draft, live))
                and is_script_key(path[-1], path[-2] if len(path) > 1 else None)):
            return _merge_script(old, draft, live, json_pointer(path), conflicts)
        conflicts.append({"path": json_pointer(path), "kind": "value"})
        return live

    models = [json.loads(value) for value in (base, local, remote)]
    projected = [page_publication_model(value, page_alias=page_alias) for value in models]
    if any(str(value.get("pageType")) != page_type for value in models):
        return None, [{"path": "/pageType", "kind": "identity"}]
    if page_type == "0":
        scripts = [value.get("compScript") for value in models]
        if any(not isinstance(value, str) or project_inheritance(value, None)["status"] != "INACTIVE" for value in scripts):
            return None, [{"path": "/compScript", "kind": "inheritance"}]
        merged = {**models[2], "compScript": _merge_script(*scripts, "/compScript", conflicts)}
    else:
        merged = merge_node(*zip(models, projected))
    if not conflicts:
        checked = page_publication_model(merged, page_alias=page_alias)
        for key in _PAGE_IDENTITY:
            if not _equal(checked.get(key, _MISSING), projected[2].get(key, _MISSING)):
                conflicts.append({"path": json_pointer((key,)), "kind": "identity"})
    return (None if conflicts else json.dumps(merged, ensure_ascii=False, separators=(",", ":"), allow_nan=False)), conflicts
