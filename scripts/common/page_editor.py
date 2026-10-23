"""Source-preserving PAGE editor model and bounded, typed local operations.

Pointers are valid only within the source-hash-bound editing session. Array
orders use native field keys and run after scalar edits, so a drag cannot send
the next script edit to the former occupant of an array position.
"""
from __future__ import annotations

import json
import math
import re
from common.inheritance import project as inheritance_projection
from common import page_design, page_structure

from common.page_projection import (
    _JsonValueLocator, extract_page_field_entities, extract_page_nodes,
    pointer_value,
)

MAX_PAGE_BYTES = 4_000_000
MAX_OPERATIONS = 500
REGIONS = {"FORM", "SEARCH", "MAIN_TABLE", "DETAIL_TABLE"}
BUTTON_PROPERTIES = {"name": "按钮名称", "aliasName": "按钮别名"}
PROPERTIES = {
    "label": "标题", "disName": "显示名称", "width": "宽度（原单位）",
    "height": "高度（原单位）", "labelWidth": "标签宽度",
    "maxLength": "输入最大长度", "readonly": "只读", "hide": "隐藏",
    "maxTextLength": "输入最大长度", "isDisabled": "只读", "isHide": "隐藏",
}
KNOWN_FIELDS = {"text", "password", "textarea", "number", "numeric", "date", "datetime", "datesearch", "numsearch",
                "time", "select", "checkbox", "radio", "label", "button", "file", "line"}
# The contract and structure operations are shared by every AI creation path.
_structure_targets = page_structure.targets
_create = page_structure.apply


def _add_member(text, pointer, name, value):
    if name in pointer_value(json.loads(text), pointer):
        raise ValueError("Creation requires an absent member of an object")
    return page_structure.set_value(text, pointer + "/" + name, value)


def _data(text):
    if not isinstance(text, str) or len(text.encode("utf-8")) > MAX_PAGE_BYTES:
        raise ValueError("PAGE exceeds the 4 MB local editor limit")
    spans = _JsonValueLocator(text).locate()  # Reject duplicate member paths.
    def reject_constant(value):
        raise ValueError("Non-JSON numeric constant: " + value)
    data = json.loads(text, parse_constant=reject_constant)
    if not isinstance(data, dict) or not isinstance(data.get("pageId"), str):
        raise ValueError("Local editing requires an object PAGE with pageId")
    return data, spans


def _key(field):
    for name in ("fieldId", "id", "guid"):
        value = field.get(name)
        if isinstance(value, str) and value.strip():
            return name + ":" + value.strip()
    return ""


def describe(text):
    data, _ = _data(text)
    collections = {}
    candidates = {entity.collection_pointer: (entity.region_type, "FIELDS")
                  for entity in extract_page_field_entities(data)}
    def buttons(current, pointer=""):
        if isinstance(current, dict):
            region = {"input-box":"FORM", "search-box":"SEARCH", "table-main":"MAIN_TABLE", "table-item":"DETAIL_TABLE"}.get(current.get("type"))
            if region and isinstance(current.get("buttons"), list):
                candidates[pointer + "/buttons"] = (region, "BUTTONS")
            for key, value in current.items():
                buttons(value, pointer + "/" + str(key).replace("~", "~0").replace("/", "~1"))
        elif isinstance(current, list):
            for index, value in enumerate(current):
                buttons(value, pointer + "/" + str(index))
    buttons(data)
    for pointer, (region, kind) in candidates.items():
        parent = pointer_value(data, pointer.rpartition("/")[0])
        fields = pointer_value(data, pointer)
        keys = [_key(field) if isinstance(field, dict) else "" for field in fields]
        unique = all(keys) and len({key.casefold() for key in keys}) == len(keys)
        known = region in REGIONS
        items = []
        for index, field in enumerate(fields):
            if not isinstance(field, dict):
                continue
            field_type = "button" if kind == "BUTTONS" else field.get("type", "")
            supported = known and unique and field_type in KNOWN_FIELDS
            properties = []
            for name, label in ({**PROPERTIES, **BUTTON_PROPERTIES} if kind == "BUTTONS" else PROPERTIES).items():
                if name not in field or isinstance(field[name], (dict, list)):
                    continue
                properties.append({"name": name, "label": label, "value": field[name]})
            items.append({"key": keys[index], "pointer": pointer + "/" + str(index),
                          "label": str((field.get("name") if kind == "BUTTONS" else None) or field.get("label") or field.get("disName") or keys[index]),
                          "type": field_type, "properties": properties, "editable": supported,
                          "reason": "" if supported else "未知控件、区域或字段身份不唯一，属性仅查看"})
        collections[pointer] = {"pointer": pointer, "label": str(parent.get("name") or parent.get("id") or pointer),
                                "region": region, "kind": kind, "regionPointer": pointer.rpartition("/")[0], "fields": items,
                                # Ordering moves whole source tokens; it does not edit unknown control properties.
                                "reorderable": known and unique,
                                "reorderReason": "" if known and unique else "区域不支持排序或字段身份不唯一"}
    nodes = []
    for node in extract_page_nodes(data):
        if node.node_type not in {"SCRIPT", "SQL"}:
            continue
        content = pointer_value(data, node.json_pointer)
        if not isinstance(content, str):
            continue
        inherited = node.node_type == "SCRIPT" and inheritance_projection(content, None)["status"] != "INACTIVE"
        key = node.json_pointer
        for collection in collections.values():
            for field in collection["fields"]:
                if node.json_pointer.startswith(field["pointer"] + "/") and field["key"]:
                    key = collection["pointer"] + "|" + field["key"] + "|" + node.json_pointer[len(field["pointer"]):]
        nodes.append({"key": key, "pointer": node.json_pointer, "label": node.label, "type": node.node_type,
                      "eventScope": node.event_scope, "content": content,
                      "editable": not inherited,
                      "reason": "继承脚本请使用 Nexus 原有继承编辑入口" if inherited else ""})
    insert_targets, event_owners = _structure_targets(data)
    return {"pageId": data["pageId"], "pageName": str(data.get("pageName") or ""),
            "collections": list(collections.values()), "nodes": nodes,
            "insertTargets": [{"collectionPointer": pointer, "kind": kind,
                               "componentType": page_structure.component_type(data, pointer)} for pointer, kind in insert_targets.items()],
            "eventOwners": [{"ownerPointer": pointer, "ownerType": kind,
                             "eventsPointer": target, "allowedEvents": {key: sorted(names) for key, names in page_design.allowed_events(kind, data.get("pageSetup", {}) if pointer == "/pageSetup" else pointer_value(data, pointer)).items()},
                             "properties": sorted(page_design.property_paths(kind))}
                            for pointer, (kind, target) in event_owners.items()],
            "previewMode": "原版设计视图 · 平台一致性待验收 · 不执行业务脚本", "remoteStatus": "远程状态未核验"}


def _property_value(name, value, old):
    if isinstance(value, (dict, list)) or (isinstance(value, float) and not math.isfinite(value)):
        raise ValueError("Field properties must be finite scalar values")
    if name in {"label", "disName", "name", "aliasName"}:
        if not isinstance(value, str) or len(value) > 512:
            raise ValueError("Field label must be a string of at most 512 characters")
    elif name in {"hide", "readonly"}:
        if type(value) is not bool:
            raise ValueError("hide/readonly must be boolean")
    elif name in {"isHide", "isDisabled"}:
        if type(value) is not int or value not in {0, 1}:
            raise ValueError("isHide/isDisabled must retain the platform 0/1 flag type")
    elif value is not None:
        if isinstance(value, bool) or not isinstance(value, (str, int, float)):
            raise ValueError("Dimensions and input lengths require a number or numeric string")
        if isinstance(value, str) and not re.fullmatch(r"\d+(?:\.\d+)?(?:px|%)?", value):
            raise ValueError("Unsupported dimension unit")
        if isinstance(value, (int, float)) and not 0 <= value <= 100000:
            raise ValueError("Dimension out of range")
        if name in {"maxLength", "maxTextLength"} and (isinstance(value, str) and not value.isdigit()
                                    or isinstance(value, float) and not value.is_integer()):
            raise ValueError("maxLength must be a nonnegative integer")
    # Keep the existing wire type; changing platform types needs its own contract.
    numeric = lambda item: isinstance(item, (int, float)) and not isinstance(item, bool)
    if (old is not None and value is not None and type(value) is not type(old)
            and not (numeric(old) and numeric(value))):
        raise ValueError("Property type must match the exported source")


def _encoded(value):
    token = json.dumps(value, ensure_ascii=False, allow_nan=False)
    return re.sub(r"[='<>&\u2028\u2029]", lambda m: "\\u%04x" % ord(m[0]), token)


def apply_operations(text, operations):
    """Validate all edits in memory, preserving tokens outside explicit changes."""
    if not isinstance(operations, list) or not 1 <= len(operations) <= MAX_OPERATIONS:
        raise ValueError("Expected 1–500 PAGE editor operations")
    data, spans = _data(text)
    model = describe(text)
    collections = {item["pointer"]: item for item in model["collections"]}
    nodes = {item["pointer"]: item for item in model["nodes"]}
    edits, orders, creations, members, aliases, seen = [], [], [], [], set(), set()
    for op in operations:
        if not isinstance(op, dict):
            raise ValueError("Operation must be an object")
        kind = op.get("kind")
        if kind in {"insert", "event", "patch", "removeEvent", "remove", "move", "copy", "datasource", "layout", "grid", "repairIdentities"}:
            creations.append(op)
            continue
        if kind == "property" and set(op) == {"kind", "collectionPointer", "fieldKey", "property", "value"}:
            collection = collections.get(op["collectionPointer"])
            fields = [item for item in (collection or {}).get("fields", []) if item["key"] == op["fieldKey"]]
            if len(fields) != 1 or not fields[0]["editable"]:
                raise ValueError("Field is unknown, ambiguous or outside a supported UI region")
            field = fields[0]
            name = op["property"]
            button_property = collection["kind"] == "BUTTONS" and name in BUTTON_PROPERTIES
            if name not in {item["name"] for item in field["properties"]} and not button_property:
                raise ValueError("Only declared existing presentation properties may be edited")
            pointer = field["pointer"] + "/" + name
            _property_value(name, op["value"], spans[pointer][2] if pointer in spans else None)
            if button_property and name == "name" and not op["value"].strip():
                raise ValueError("Button name must be nonempty")
            if name == "aliasName":
                aliases.add(collection["pointer"])
            value = op["value"]
        elif kind == "text" and set(op) == {"kind", "jsonPointer", "content"}:
            pointer, value = op["jsonPointer"], op["content"]
            if pointer not in nodes or not nodes[pointer]["editable"]:
                raise ValueError("Script/SQL node is unavailable or inherited")
            if not isinstance(value, str) or len(value) > 500_000:
                raise ValueError("Script/SQL must be bounded text")
            if nodes[pointer]["type"] == "SCRIPT" and inheritance_projection(value, None)["status"] != "INACTIVE":
                raise ValueError("Use the existing inheritance editor for inheritance markers")
        elif kind == "order" and set(op) == {"kind", "collectionPointer", "fieldKeys"}:
            pointer = op["collectionPointer"]
            collection = collections.get(pointer)
            keys = op["fieldKeys"]
            current = [item["key"] for item in (collection or {}).get("fields", [])]
            if (not collection or not collection["reorderable"] or not isinstance(keys, list)
                    or any(not isinstance(key, str) for key in keys)
                    or len(keys) != len(current) or set(keys) != set(current) or len(set(keys)) != len(keys)):
                raise ValueError("Order must be an exact permutation of one supported UI collection")
            if any(pointer == other or pointer.startswith(other + "/") or other.startswith(pointer + "/") for other, _ in orders):
                raise ValueError("Overlapping layout collections cannot be reordered together")
            orders.append((pointer, keys))
            continue
        else:
            raise ValueError("Unknown PAGE editor operation or arguments")
        if pointer in seen:
            raise ValueError("Repeated property or script target")
        seen.add(pointer)
        if pointer not in spans:
            members.append((field["pointer"], name, value))
            continue
        start, end, current = spans[pointer]
        if current != value or type(current) is not type(value):
            edits.append((start, end, _encoded(value)))
    for start, end, value in sorted(edits, reverse=True):
        text = text[:start] + value + text[end:]
    for pointer, name, value in members:
        text = _add_member(text, pointer, name, value)
    for pointer in aliases:
        buttons = pointer_value(json.loads(text), pointer)
        names = [button["aliasName"].casefold() for button in buttons if button.get("aliasName")]
        if len(names) != len(set(names)):
            raise ValueError("Button aliases must be unique in their region")
    if creations and orders:
        raise ValueError("Create and reorder in separate source-bound sessions to avoid shifted owners")
    if any(op.get("kind") in {"remove", "move", "removeEvent", "layout", "repairIdentities"} for op in creations) and len(operations) != 1:
        raise ValueError("Remove/move must use a separate source-bound session to avoid shifted owners")
    # Insertion appends; destructive operations are isolated from snapshot pointers.
    for op in creations:
        text = _create(text, op)
    if creations:
        final_data, _ = _data(text)
        for op in creations:
            if op.get("kind") not in {"insert", "copy"} or not op["collectionPointer"].endswith("/fields"):
                continue
            target = (op.get("item", {}).get("selectBox") or {}).get("selectCodefieldId")
            if target and sum(field.get("fieldId") == target for field in pointer_value(final_data, op["collectionPointer"])) != 1:
                raise ValueError("New selectCodefieldId must resolve uniquely in the target field group")
            parent = pointer_value(final_data, op.get("targetCollectionPointer", op["collectionPointer"]).rpartition("/")[0])
            if parent.get("type") == "input-grid":
                from common.page_layout import validate_grid
                validate_grid(parent)
            fields = parent.get("fields", [])
            for field in fields:
                for reference, reverse in (("childFieldId", "parentFieldId"), ("parentFieldId", "childFieldId")):
                    if not field.get(reference):
                        continue
                    related = [other for other in fields if other.get("fieldId") == field[reference]]
                    if len(related) != 1 or related[0] is field or related[0].get(reverse) != field.get("fieldId"):
                        raise ValueError("Composite fields require unique reciprocal parent/child bindings in the same group")
    for pointer, keys in orders:
        data, spans = _data(text)
        fields = pointer_value(data, pointer)
        current = [_key(field) for field in fields]
        if keys == current:
            continue
        tokens = {key: text[spans[pointer + "/" + str(index)][0]:spans[pointer + "/" + str(index)][1]]
                  for index, key in enumerate(current)}
        # Keep each positional separator/indent and move complete source tokens.
        start, end, _ = spans[pointer]
        parts, cursor = [], start
        for index, key in enumerate(keys):
            item_start, item_end, _ = spans[pointer + "/" + str(index)]
            parts.extend((text[cursor:item_start], tokens[key]))
            cursor = item_end
        parts.append(text[cursor:end])
        text = text[:start] + "".join(parts) + text[end:]
    _data(text)
    return text
