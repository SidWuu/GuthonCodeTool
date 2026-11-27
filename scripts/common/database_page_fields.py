"""Clipboard batches for applying saved DATABASE UI field changes in Bridge."""

import json

from common import page_design, page_structure
from common.inheritance import project as inheritance_projection
from common.page_comparison import baseline_pointer
from common.page_projection import pointer_value


_KINDS = {"input-box": "FIELD", "table-main": "COLUMN", "table-item": "COLUMN"}
_STRUCTURAL_PROPERTIES = {"fieldId", "type", "tbId", "fdId", "parentFieldId", "childFieldId", "colGroupType"}
_ABSENT = object()


def _fields(component):
    fields = {}
    for key in ("fields", "hideFields"):
        items = component.get(key, [])
        if not isinstance(items, list):
            return {}
        for field in items:
            code = field.get("fieldId") if isinstance(field, dict) else None
            if not isinstance(code, str) or not code.strip() or code in fields:
                return {}
            fields[code] = (field, key == "hideFields")
    return fields


def _identity(field):
    return {key: field[key] for key in ("fieldId", "id", "guid")
            if isinstance(field.get(key), str) and field[key].strip()}


def _value(field, path):
    for key in path:
        field = field.get(key, _ABSENT) if isinstance(field, dict) else _ABSENT
    return field


def _changes(before, after, kind):
    properties = page_design.property_paths(kind) - _STRUCTURAL_PROPERTIES
    events = [(group, name) for group, names in page_design.allowed_events(kind, after).items() for name in names]
    for path in sorted([tuple(name.split(".")) for name in properties] + events):
        left, right = _value(before, path), _value(after, path)
        if left is right or (left is not _ABSENT and right is not _ABSENT
                             and json.dumps(left, sort_keys=True) == json.dumps(right, sort_keys=True)):
            continue
        if path[0] in ("pageEvents", "serviceEvents") and any(
            inheritance_projection(value, None)["status"] != "INACTIVE"
            for value in (left, right) if isinstance(value, str)
        ):
            continue
        yield {"path": list(path), **({"before": left} if left is not _ABSENT else {}),
               **({"after": right} if right is not _ABSENT else {})}


def field_batches(before, after):
    for pointer, slot in page_structure.targets(after)[0].items():
        if slot != "fields":
            continue
        component_pointer = pointer.rpartition("/")[0]
        component = pointer_value(after, component_pointer)
        component_type = component["type"]
        if component_type not in _KINDS:
            continue
        old_pointer = baseline_pointer(before, after, component_pointer)
        if old_pointer is None:
            continue
        previous = pointer_value(before, old_pointer)
        if not isinstance(previous, dict) or previous.get("type") != component_type:
            continue
        old_fields, new_fields = _fields(previous), _fields(component)
        stable = {code: _identity(field) for code, (field, _) in old_fields.items()
                  if code in new_fields and _identity(field) == _identity(new_fields[code][0])}
        anchors = [identity for identity in stable.values() if len(identity) > 1]
        if not anchors:
            continue
        old_ids = {value for field, _ in old_fields.values() for key, value in _identity(field).items()
                   if key != "fieldId"}
        updates, additions = [], []
        for code, (field, hidden) in new_fields.items():
            field_type = field.get("type")
            if not isinstance(field_type, str):
                continue
            if code in stable and field_type == old_fields[code][0].get("type"):
                changes = list(_changes(old_fields[code][0], field, _KINDS[component_type]))
                if changes:
                    updates.append({"identity": stable[code], "type": field_type, "changes": changes})
            elif (code not in old_fields and field_type in page_design.field_types(component_type)
                  and len(_identity(field)) > 1
                  and field.get("isProduct") in (None, 0, "0", "")
                  and not any(field.get(key) in old_ids for key in ("id", "guid")
                              if isinstance(field.get(key), str))):
                additions.append({"field": field, "hidden": hidden})
        if updates or additions:
            label = next((component[key] for key in ("name", "label", "id")
                          if isinstance(component.get(key), str) and component[key].strip()), pointer)
            yield ({"pointer": pointer, "label": label, "updated": len(updates), "added": len(additions)},
                   {"format": "guthon-database-page-fields-v1", "pageId": after["pageId"],
                    "component": label, "componentType": component_type, "anchors": anchors,
                    "updates": updates, "additions": additions})
