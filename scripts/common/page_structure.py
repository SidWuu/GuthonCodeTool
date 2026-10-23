"""Source-preserving PAGE structure operations over the designer contract."""
from __future__ import annotations

import hashlib
import json
import math
import re

from common import page_design
from common.inheritance import project as inheritance_projection
from common.page_projection import _JsonValueLocator, pointer_value, json_pointer, insert_json_array_item


def targets(data):
    collections, owners = {}, {}
    def walk(value, parts=(), component=""):
        if not isinstance(value, (dict, list)):
            return
        pointer = json_pointer(parts)
        if isinstance(value, list):
            for index, child in enumerate(value):
                walk(child, (*parts, index), component)
            return
        if isinstance(value.get("type"), str) and value["type"] in page_design.COMPONENT_KINDS:
            component = value["type"]
            kind = page_design.COMPONENT_KINDS[component]
            owners[pointer] = (kind, pointer + "/params")
            for name in ("fields", "buttons"):
                if name == "fields" and kind not in {"FORM", "SEARCH", "TABLE"}:
                    continue
                if name not in value or isinstance(value[name], list):
                    collections[pointer + "/" + name] = name
        elif component and isinstance(value.get("type"), str) and (
                value["type"] in {"text", "password", "select", "date", "datetime", "label"}
                and value.get("fieldId") and not value.get("childFieldId")):
            if "bnts" not in value or isinstance(value["bnts"], list):
                collections[pointer + "/bnts"] = "buttons"
        for name in ("fields", "buttons", "bnts"):
            items = value.get(name)
            if not isinstance(items, list):
                continue
            if name == "bnts" and component:
                collections[pointer + "/bnts"] = "buttons"
            if pointer + "/" + name not in collections:
                continue
            for index, item in enumerate(items):
                if isinstance(item, dict):
                    path = pointer + "/" + name + "/" + str(index)
                    kind = "BUTTON" if name in {"buttons", "bnts"} else (
                        "COLUMN" if component in {"table-main", "table-item"} else "FIELD")
                    owners[path] = (kind, path)
                    walk(item, (*parts, name, index), component)
        for name in ("views", "rows", "cols", "cells", "component", "tabs", "tabPages"):
            if name in value:
                walk(value[name], (*parts, name), component)
    walk(data)
    if "pageSetup" not in data or isinstance(data.get("pageSetup"), dict):
        owners["/pageSetup"] = ("PAGE", "/pageSetup")
    if isinstance(data.get("modalSaveBnt"), dict):
        owners["/modalSaveBnt"] = ("BUTTON", "/modalSaveBnt")
    return collections, owners


def component_type(data, pointer):
    while pointer:
        pointer = pointer.rpartition("/")[0]
        value = pointer_value(data, pointer) if pointer else data
        if isinstance(value, dict) and isinstance(value.get("type"), str) and value["type"] in page_design.COMPONENT_KINDS:
            return value["type"]
    raise ValueError("UI collection has no recognized component")


def encoded(value):
    token = json.dumps(value, ensure_ascii=False, allow_nan=False)
    return re.sub(r"[='<>&\u2028\u2029]", lambda m: "\\u%04x" % ord(m[0]), token)


def set_value(text, pointer, value):
    spans = _JsonValueLocator(text).locate()
    if pointer in spans:
        start, end, _ = spans[pointer]
        return text[:start] + encoded(value) + text[end:]
    parent, _, name = pointer.rpartition("/")
    if parent not in spans:
        text = set_value(text, parent, {})
        spans = _JsonValueLocator(text).locate()
    obj = pointer_value(json.loads(text), parent)
    if not isinstance(obj, dict):
        raise ValueError("Property parent must be an object")
    name = name.replace("~1", "/").replace("~0", "~")
    _, end, _ = spans[parent]
    return text[:end - 1] + ("," if obj else "") + encoded(name) + ":" + encoded(value) + text[end - 1:]


def delete_value(text, pointer):
    data = json.loads(text)
    spans = _JsonValueLocator(text).locate()
    parent, _, key = pointer.rpartition("/")
    obj = pointer_value(data, parent)
    start, end, _ = spans[pointer]
    if isinstance(obj, list):
        index = int(key)
        if index:
            start = spans[parent + "/" + str(index - 1)][1]
        elif len(obj) > 1:
            end = spans[parent + "/1"][0]
    elif isinstance(obj, dict):
        # Locate member names rather than searching user-controlled value text.
        keys = list(obj)
        index = keys.index(key.replace("~1", "/").replace("~0", "~"))
        parent_start = spans[parent][0]
        previous_end = spans[parent + "/" + str(keys[index - 1]).replace("~", "~0").replace("/", "~1")][1] if index else parent_start + 1
        member_start = previous_end + (1 if index else 0)
        if index:
            start = previous_end
        else:
            start = member_start
            if len(keys) > 1:
                # The comma immediately after the value is outside its token.
                end = text.index(",", end) + 1
    else:
        raise ValueError("Cannot remove this JSON value")
    return text[:start] + text[end:]


def _script(content):
    if not isinstance(content, str) or len(content) > 500_000 or inheritance_projection(content, None)["status"] != "INACTIVE":
        raise ValueError("Event requires bounded explicit source without inheritance markers")


def member_key(item):
    for name in ("fieldId", "id", "guid"):
        if isinstance(item.get(name), str) and item[name].strip():
            return name + ":" + item[name].strip()
    return ""


def _member(data, pointer, key):
    items = pointer_value(data, pointer)
    matches = [(i, item) for i, item in enumerate(items) if isinstance(item, dict) and member_key(item) == key]
    if len(matches) != 1:
        raise ValueError("Field/button identity must resolve uniquely")
    return matches[0]


def _unique(items, item, *, button):
    key = "aliasName" if button else "fieldId"
    if item.get(key) and any(str(old.get(key) or "").casefold() == item[key].casefold() for old in items):
        raise ValueError("Duplicate fieldId/button aliasName")
    if not button and item.get("colGroupType") == 0 and any(old.get("colGroupType") == 0 for old in items):
        raise ValueError("A table supports only one action column")
    for name in ("id", "guid"):
        if item.get(name) and any(old.get(name) == item[name] for old in items):
            raise ValueError("New native IDs must be unique; do not reuse template IDs")


def _rename_control(text, old, new, kind):
    from common.page_projection import extract_page_nodes
    if not old or old == new:
        return text
    if not isinstance(new, str) or not re.fullmatch(r"[A-Za-z_$][A-Za-z0-9_$]*", new):
        raise ValueError("Control names must be script identifiers")
    if kind == "TABLE":
        pattern = re.compile(r"\b" + re.escape(old) + r"\b")
    elif kind == "TAB":
        pattern = re.compile(re.escape("." + old + "."))
        new = "." + new + "."
    elif kind in {"FORM", "TREE", "TABS", "HTML", "CUSTOM"}:
        pattern = re.compile(re.escape(old + "."))
        new += "."
    else:
        return text
    data = json.loads(text)
    for node in extract_page_nodes(data):
        if node.node_type != "SCRIPT":
            continue
        content = pointer_value(data, node.json_pointer)
        changed = pattern.sub(lambda _: new, content)
        if changed != content:
            _script(content)
            text = set_value(text, node.json_pointer, changed)
    return text


def apply(text, op):
    data = json.loads(text)
    collections, owners = targets(data)
    kind = op.get("kind")
    if kind == "grid":
        if set(op) != {"kind", "ownerPointer", "rows"} or pointer_value(data, op["ownerPointer"]).get("type") != "input-grid" or op["ownerPointer"] not in owners:
            raise ValueError("Grid placement requires an exact input-grid owner")
        from common.page_layout import validate_grid, prepare_grid
        rows = prepare_grid(op["rows"], hashlib.sha256((text + encoded(op)).encode()).hexdigest())
        component = {**pointer_value(data, op["ownerPointer"]), "gridRows": rows}
        validate_grid(component)
        return set_value(text, op["ownerPointer"] + "/gridRows", rows)
    if kind == "layout":
        if set(op) != {"kind", "rows"} or not isinstance(op["rows"], list):
            raise ValueError("Layout requires explicit native rows")
        from common.page_layout import prepare_rows, control_catalog
        seed = hashlib.sha256((text + encoded(op)).encode()).hexdigest()
        rows = prepare_rows(op["rows"], data, seed)
        text = set_value(text, "/views/rows", rows)
        return set_value(text, "/views/ctrls", control_catalog(rows))
    if kind == "datasource":
        if set(op) != {"kind", "ownerPointer", "value"} or owners.get(op["ownerPointer"], ("",))[0] not in {"TABLE", "FORM", "SEARCH", "TREE", "CHART"}:
            raise ValueError("Datasource requires a supported component owner")
        value = op["value"]
        allowed = {"dsType", "sql", "script", "fields", "pks", "isSubSelect", "isDisableDataAuth", "saveTableId", "tableNames"}
        if not isinstance(value, dict) or set(value) - allowed or type(value.get("dsType")) is not int or value["dsType"] not in {0, 1}:
            raise ValueError("Datasource requires a native SQL/script mode and declared metadata")
        for name in ("fields", "pks"):
            if not isinstance(value.get(name), list):
                raise ValueError("Datasource requires fields and pks arrays from platform metadata")
        if any(not isinstance(field, dict) for field in value["fields"]):
            raise ValueError("Datasource fields must be declared field objects")
        _script(value.get("sql" if value["dsType"] == 0 else "script"))
        pointer = op["ownerPointer"] + "/datasource"
        old = pointer_value(data, op["ownerPointer"]).get("datasource", {})
        if any(old.get(name) for name in ("superSql", "superScript", "isProduct")):
            raise ValueError("Inherited datasource changes require the inheritance editor")
        return set_value(text, pointer, value)
    if kind in {"event", "removeEvent", "patch"}:
        pointer = op.get("ownerPointer")
        owner = owners.get(pointer)
        if not owner:
            raise ValueError("Unsupported event/property owner")
        owner_kind, event_pointer = owner
        item = data.get("pageSetup", {}) if pointer == "/pageSetup" else pointer_value(data, pointer)
        if kind == "patch":
            if set(op) != {"kind", "ownerPointer", "patch"} or not isinstance(op["patch"], dict) or not 1 <= len(op["patch"]) <= 100:
                raise ValueError("Patch requires 1–100 explicit designer properties")
            for name, value in op["patch"].items():
                if name not in page_design.property_paths(owner_kind):
                    raise ValueError("Unsupported designer property; native identities and product layers are immutable")
                if isinstance(value, (dict, list)) or isinstance(value, float) and not math.isfinite(value):
                    raise ValueError("Designer properties must be finite scalar values")
                if isinstance(value, str) and len(value) > 24000:
                    raise ValueError("Designer property exceeds the text limit")
                path = (event_pointer if owner_kind not in {"FIELD", "COLUMN", "BUTTON", "PAGE"} else pointer) + "/" + name.replace(".", "/")
                spans = _JsonValueLocator(text).locate()
                old = spans[path][2] if path in spans else None
                if old is not None and value is not None and type(old) is not type(value):
                    raise ValueError("Designer property type must match exported source")
                text = set_value(text, path, value)
            after = json.loads(text)
            changed = pointer_value(after, pointer)
            if owner_kind in {"FIELD", "COLUMN", "BUTTON"}:
                collection = pointer.rpartition("/")[0]
                component = component_type(after, collection) if collection else "input-box"
                page_design.validate_member(changed, component, button=owner_kind == "BUTTON")
                if collection:
                    items = pointer_value(after, collection)
                    _unique([other for i, other in enumerate(items) if i != int(pointer.rsplit("/", 1)[1])], changed, button=owner_kind == "BUTTON")
            if owner_kind not in {"FIELD", "COLUMN", "BUTTON", "PAGE"} and "name" in op["patch"]:
                text = _rename_control(text, item.get("name"), op["patch"]["name"], owner_kind)
                text = set_value(text, pointer + "/name", op["patch"]["name"])
                if isinstance(data.get("views"), dict) and isinstance(data["views"].get("rows"), list):
                    from common.page_layout import control_catalog
                    text = set_value(text, "/views/ctrls", control_catalog(json.loads(text)["views"]["rows"]))
            return text
        required = {"kind", "ownerPointer", "eventType", "eventName"} | ({"content"} if kind == "event" else set())
        if set(op) != required or op["eventName"] not in page_design.allowed_events(owner_kind, item).get(op["eventType"], set()):
            raise ValueError("Unsupported event owner, event type or exported event name")
        path = event_pointer + "/" + op["eventType"] + "/" + op["eventName"]
        spans = _JsonValueLocator(text).locate()
        if kind == "removeEvent":
            if item.get("isProduct"):
                raise ValueError("Product events cannot be removed")
            old = pointer_value(data, path)
            _script(old)
            return delete_value(text, path)
        _script(op["content"])
        if path in spans:
            _script(pointer_value(data, path))
        return set_value(text, path, op["content"])
    pointer = op.get("collectionPointer")
    if pointer not in collections:
        raise ValueError("Target is not a recognized UI field/button collection")
    parent = pointer_value(data, pointer.rpartition("/")[0])
    items = parent.get(pointer.rsplit("/", 1)[1], [])
    if any(not isinstance(item, dict) for item in items):
        raise ValueError("Malformed UI collection")
    button = collections[pointer] == "buttons"
    component = component_type(data, pointer)
    if kind == "repairIdentities":
        if set(op) != {"kind", "collectionPointer"}:
            raise ValueError("Identity repair requires one exact collection")
        seen = set()
        seed = hashlib.sha256((text + pointer).encode()).hexdigest()
        for index, item in enumerate(items):
            identity = item.get("id")
            if not isinstance(identity, str) or not identity.strip() or identity in seen:
                if item.get("isProduct"):
                    raise ValueError("Product identity repair requires the platform owner")
                import uuid
                identity = uuid.uuid5(uuid.NAMESPACE_URL, seed + ":" + str(index)).hex.upper()
                text = set_value(text, pointer + "/" + str(index) + "/id", identity)
            seen.add(identity)
        return text
    if kind in {"remove", "move", "copy"}:
        index, source = _member(data, pointer, op.get("fieldKey"))
        if kind == "remove":
            if set(op) != {"kind", "collectionPointer", "fieldKey"}:
                raise ValueError("Remove requires one exact field/button")
            if source.get("isProduct"):
                raise ValueError("Product fields/buttons cannot be removed; hide them instead")
            if component == "input-grid" and not button:
                raise ValueError("Remove grid fields and cell placements together using layout")
            return delete_value(text, pointer + "/" + str(index))
        if kind == "move":
            if set(op) != {"kind", "collectionPointer", "fieldKey", "targetCollectionPointer"}:
                raise ValueError("Move requires an exact source and target collection")
            target = op["targetCollectionPointer"]
            if collections.get(target) != collections[pointer] or target == pointer:
                raise ValueError("Move requires distinct collections of the same kind")
            if source.get("isProduct") or component_type(data, target) != component:
                raise ValueError("Cross-type/product moves require a platform migration")
            if component == "input-grid" and not button:
                raise ValueError("Move grid fields and cell placements together using layout")
            target_items = pointer_value(data, target)
            _unique(target_items, source, button=button)
            # Remove is last so target pointers still refer to the source snapshot.
            text = insert_json_array_item(text, target, len(target_items), source, target_items)
            return delete_value(text, pointer + "/" + str(index))
        if set(op) - {"kind", "collectionPointer", "fieldKey", "targetCollectionPointer", "patch"}:
            raise ValueError("Unknown copy arguments")
        target = op.get("targetCollectionPointer", pointer)
        if collections.get(target) != collections[pointer]:
            raise ValueError("Copy target must be a recognized collection of the same kind")
        if not button and component_type(data, target) != component:
            raise ValueError("Cross-type field copying requires explicit platform conversion")
        candidate = dict(source)
        # A product copy is independent; inherited scripts still require explicit materialization.
        candidate.pop("isProduct", None)
        for name in list(candidate):
            if name.startswith("super"):
                candidate.pop(name)
        patch = op.get("patch", {})
        if not isinstance(patch, dict) or set(patch) - page_design.property_paths("BUTTON" if button else "COLUMN" if component in {"table-main", "table-item"} else "FIELD"):
            raise ValueError("Copy patch contains unsupported designer properties")
        for name, value in patch.items():
            if "." in name:
                raise ValueError("Copy patch uses direct properties; edit nested settings after creation")
            candidate[name] = value
        pointer = target
        items = pointer_value(data, pointer)
        component = component_type(data, pointer)
    elif kind == "insert" and set(op) == {"kind", "collectionPointer", "item"}:
        candidate = op["item"]
    else:
        raise ValueError("Unknown structure operation or arguments")
    seed = hashlib.sha256((text + json.dumps(op, sort_keys=True, ensure_ascii=False)).encode()).hexdigest()
    candidate = page_design.prepare_member(candidate, component, button=button, identity_seed=seed, renew_ids=kind == "copy")
    for events in ("pageEvents", "serviceEvents"):
        for content in candidate.get(events, {}).values():
            _script(content)
    _unique(items, candidate, button=button)
    if pointer not in _JsonValueLocator(text).locate():
        return set_value(text, pointer, [candidate])
    return insert_json_array_item(text, pointer, len(items), candidate, items)


def inspect(data):
    """Bounded identity/shape diagnostics, suitable for AI generated PAGE JSON."""
    collections, owners = targets(data)
    issues, total = [], 0
    def issue(code, pointer, message):
        nonlocal total
        total += 1
        if len(issues) < 100:
            issues.append({"code": code, "jsonPointer": pointer, "message": message})
    if "views" in data and not isinstance(data["views"], dict):
        issue("LAYOUT_SHAPE", "/views", "Native PAGE layout uses views.rows, not a flat component array")
    for pointer, kind in collections.items():
        try:
            items = pointer_value(data, pointer)
        except KeyError:
            continue
        native, semantic = set(), set()
        for index, item in enumerate(items):
            path = pointer + "/" + str(index)
            try:
                page_design.validate_member(item, component_type(data, pointer), button=kind == "buttons")
            except ValueError as error:
                issue("MEMBER_INVALID", path, str(error))
            if not isinstance(item, dict):
                continue
            identity = item.get("id")
            if isinstance(identity, str) and identity and identity in native:
                issue("NATIVE_ID_DUPLICATE", path + "/id", "Platform editing may replace the wrong member")
            if isinstance(identity, str):
                native.add(identity)
            identity = item.get("aliasName" if kind == "buttons" else "fieldId")
            if identity:
                folded = str(identity).casefold()
                if folded in semantic:
                    issue("MEMBER_DUPLICATE", path, "Repeated fieldId/button aliasName in this region")
                semantic.add(folded)
            if isinstance(item.get("validId"), list):
                issue("FORM_STATE_IN_SOURCE", path + "/validId", "Persist validation names as a semicolon-separated string")
        parent = pointer_value(data, pointer.rpartition("/")[0])
        if kind == "fields" and parent.get("type") == "input-grid":
            from common.page_layout import validate_grid
            try:
                validate_grid(parent)
            except ValueError as error:
                issue("GRID_FIELD_UNPLACED", pointer, str(error))
    for pointer, (kind, event_pointer) in owners.items():
        item = data.get("pageSetup", {}) if pointer == "/pageSetup" else pointer_value(data, pointer)
        try:
            settings = pointer_value(data, event_pointer)
        except KeyError:
            continue
        if not isinstance(settings, dict):
            issue("EVENT_CONTAINER_INVALID", event_pointer, "Event owner settings must be an object")
            continue
        allowed = page_design.allowed_events(kind, item)
        for group in ("pageEvents", "serviceEvents"):
            events = settings.get(group, {})
            if not isinstance(events, dict):
                issue("EVENT_CONTAINER_INVALID", event_pointer + "/" + group, "Event group must be an object")
                continue
            for event, content in events.items():
                if not isinstance(content, str):
                    issue("EVENT_CONTENT_INVALID", event_pointer + "/" + group + "/" + event, "Event script must be text")
                elif content and event not in allowed.get(group, set()):
                    issue("EVENT_UNSUPPORTED", event_pointer + "/" + group + "/" + event, "Event name does not match this platform control type")
    return {"valid": total == 0, "issues": issues, "issueCount": total, "complete": total <= 100,
            "platformRoundTripVerified": False}
