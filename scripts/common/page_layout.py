"""Native PAGE row/column/tab layout preparation and derived control catalog."""
from __future__ import annotations

import copy
import uuid

from common import page_design


def prepare_grid(items, seed, path="gridRows"):
    if not isinstance(items, list):
        raise ValueError("Grid rows must be an array")
    result = copy.deepcopy(items)
    for index, row in enumerate(result):
        if not isinstance(row, dict):
            raise ValueError("Grid row must be an object")
        current = path + "/" + str(index)
        row.setdefault("guid", uuid.uuid5(uuid.NAMESPACE_URL, seed + current).hex.upper())
        row.setdefault("rowType", 0)
        row.setdefault("height", 36)
        row.setdefault("cells", [])
        if not isinstance(row["cells"], list):
            raise ValueError("Grid row cells must be an array")
        for cell_index, cell in enumerate(row["cells"]):
            if not isinstance(cell, dict):
                raise ValueError("Grid cell must be an object")
            cell_path = current + "/cells/" + str(cell_index)
            cell.setdefault("guid", uuid.uuid5(uuid.NAMESPACE_URL, seed + cell_path).hex.upper())
            cell.setdefault("width", 2)
            if "rows" in cell:
                cell["rows"] = prepare_grid(cell["rows"], seed, cell_path + "/rows")
    return result


def grid_field_ids(rows):
    result = []
    if not isinstance(rows, list):
        raise ValueError("Grid rows must be an array")
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("cells", []), list):
            raise ValueError("Grid rows require cell arrays")
        if row.get("rowType", 0) != 0:
            continue
        for cell in row.get("cells", []):
            if not isinstance(cell, dict):
                raise ValueError("Grid cell must be an object")
            if cell.get("control"):
                if not isinstance(cell["control"], dict) or not isinstance(cell["control"].get("ctrlId"), str):
                    raise ValueError("Grid control requires an explicit ctrlId field binding")
                result.append(cell["control"]["ctrlId"])
            elif cell.get("rows"):
                result.extend(grid_field_ids(cell["rows"]))
    return result


def validate_grid(component):
    ids = grid_field_ids(component.get("gridRows", []))
    fields = component.get("fields", [])
    children = {field.get("childFieldId") for field in fields}
    known = {field.get("fieldId") for field in fields}
    if len(ids) != len(set(ids)) or set(ids) - known:
        raise ValueError("Grid cells must bind existing unique field IDs")
    if any(field.get("fieldId") not in ids and field.get("fieldId") not in children and field.get("isHideField") != 1 for field in fields):
        raise ValueError("Grid field is not placed in gridRows; the platform would drop it")


def control_catalog(rows):
    controls = []
    names = set()
    def visit(row):
        if row.get("component"):
            item = row["component"]
            control = {"name": item.get("name"), "type": item.get("type")}
            if control["name"] in names:
                raise ValueError("Control names must be unique within a work area")
            names.add(control["name"])
            controls.append(control)
        elif row.get("tabs"):
            item = row["tabs"]
            if item.get("name") in names:
                raise ValueError("Control names must be unique within a work area")
            names.add(item.get("name"))
            controls.append({"name": item.get("name"), "type": item.get("type"), "childs": [
                {"name": tab.get("name"), "type": tab.get("type"), "childs": control_catalog(tab.get("rows", []))}
                for tab in item.get("tabPages", [])]})
        else:
            for child in row.get("cols", row.get("rows", [])):
                visit(child)
    for row in rows:
        visit(row)
    return controls


def prepare_rows(proposed, before, seed):
    from common.page_structure import targets
    from common.page_projection import pointer_value
    # Bind existing components by native guid/name, rather than array position.
    _, owners = targets(before)
    old_components = {}
    product_ids = set()
    def collect(value):
        if isinstance(value, dict):
            if value.get("isProduct") and value.get("guid"):
                product_ids.add(value["guid"])
            for name in ("views", "rows", "cols", "component", "tabs", "tabPages"):
                if name in value:
                    collect(value[name])
        elif isinstance(value, list):
            for child in value:
                collect(child)
    collect(before)
    for pointer, (kind, _) in owners.items():
        if kind not in {"PAGE", "FIELD", "COLUMN", "BUTTON"}:
            item = pointer_value(before, pointer)
            identity = item.get("guid") or item.get("name")
            if identity:
                old_components[identity] = item
    seen_guids, count = set(), 0
    def preserve_layers(original, candidate):
        if isinstance(original, dict):
            if not isinstance(candidate, dict):
                if any(name.startswith("super") for name in original):
                    raise ValueError("Product layers cannot be removed")
                return
            for name in candidate:
                if (name.startswith("super") or name == "isProduct") and candidate.get(name) != original.get(name):
                    raise ValueError("Product layers cannot be changed through layout editing")
            for name, value in original.items():
                if name.startswith("super") and candidate.get(name) != value:
                    raise ValueError("Product layers cannot be changed through layout editing")
                if name in candidate and name not in {"fields", "buttons", "tabPages", "rows", "cols"}:
                    preserve_layers(value, candidate[name])
    def identity(path):
        return uuid.uuid5(uuid.NAMESPACE_URL, seed + ":" + path).hex.upper()
    def component(item, path):
        if not isinstance(item, dict) or not isinstance(item.get("type"), str) or item["type"] not in page_design.COMPONENT_KINDS:
            raise ValueError("Layout component requires a supported native type")
        if not isinstance(item.get("name"), str) or not item["name"].strip():
            raise ValueError("Layout component requires a native control name")
        old = old_components.get(item.get("guid") or item.get("name"))
        if old and old.get("guid") != item.get("guid"):
            raise ValueError("Existing component guid cannot change during layout editing")
        if not old:
            item.setdefault("guid", identity(path))
        if item.get("guid"):
            if item["guid"] in seen_guids:
                raise ValueError("Layout native guids must be unique")
            seen_guids.add(item["guid"])
        if old:
            preserve_layers(old, item)
            if old.get("type") != item["type"]:
                raise ValueError("Existing component type cannot change during layout editing")
        if not old and (item.get("isProduct") or any(name.startswith("super") for name in item)):
            raise ValueError("New layout components cannot introduce product layers")
        if "params" in item and not isinstance(item["params"], dict):
            raise ValueError("Component params must be an object")
        if not old:
            owner_kind = page_design.COMPONENT_KINDS[item["type"]]
            allowed = page_design.allowed_events(owner_kind, item)
            for group in ("pageEvents", "serviceEvents"):
                events = item.get("params", {}).get(group, {})
                if not isinstance(events, dict) or set(events) - allowed.get(group, set()):
                    raise ValueError("Unsupported component event")
                from common.page_structure import _script
                for content in events.values():
                    _script(content)
        for name in ("fields", "buttons"):
            if name not in item:
                continue
            if not isinstance(item[name], list):
                raise ValueError("Layout fields/buttons must be arrays")
            if any(not isinstance(entry, dict) for entry in item[name]):
                raise ValueError("Layout fields/buttons must contain objects")
            for entry in (old or {}).get(name, []):
                if entry.get("isProduct") and not any(candidate.get("id") == entry.get("id") and candidate.get("fieldId") == entry.get("fieldId") for candidate in item[name]):
                    raise ValueError("Product fields/buttons cannot be removed through layout editing")
                for candidate in item[name]:
                    if entry.get("id") and candidate.get("id") == entry.get("id"):
                        preserve_layers(entry, candidate)
            if name == "fields":
                item[name] = page_design.prepare_collection((old or {}).get(name, []), item[name], item["type"], identity_seed=seed + path)
            else:
                previous = {entry.get("id"): entry for entry in (old or {}).get(name, [])}
                for entry in item[name]:
                    matched = [original for original in previous.values() if entry.get("aliasName") and original.get("aliasName") == entry["aliasName"]]
                    if matched and any(entry.get("id") != original.get("id") for original in matched):
                        raise ValueError("Existing button native id cannot change")
                item[name] = [copy.deepcopy(entry) if entry.get("id") in previous and entry == previous[entry["id"]]
                    else page_design.prepare_member(entry, item["type"], button=True, identity_seed=seed + path + str(index))
                    for index, entry in enumerate(item[name])]
        if "tabPages" in item:
            if not isinstance(item["tabPages"], list):
                raise ValueError("Tab pages must be an array")
            tab_names = [tab.get("name") for tab in item["tabPages"] if isinstance(tab, dict)]
            if len(tab_names) != len(item["tabPages"]) or len(set(tab_names)) != len(tab_names):
                raise ValueError("Tab page names must be unique")
            for index, tab in enumerate(item["tabPages"]):
                component(tab, path + "/tabPages/" + str(index))
                tab["rows"] = rows(tab.get("rows", []), path + "/tabPages/" + str(index) + "/rows")
        if item["type"] == "input-grid":
            item["gridRows"] = prepare_grid(item.get("gridRows", []), seed + path)
            validate_grid(item)
        return item
    def rows(items, path):
        nonlocal count
        if not isinstance(items, list):
            raise ValueError("Layout rows/columns must be arrays")
        result = []
        for index, original in enumerate(items):
            count += 1
            if count > 500:
                raise ValueError("Layout exceeds 500 rows/columns")
            if not isinstance(original, dict) or set(original) - {"component", "tabs", "cols", "rows", "style", "guid", "isProduct"}:
                raise ValueError("Layout row/column contains unsupported metadata")
            item = copy.deepcopy(original)
            current = path + "/" + str(index)
            item.setdefault("guid", identity(current))
            if not isinstance(item["guid"], str) or not item["guid"] or item["guid"] in seen_guids:
                raise ValueError("Layout native guids must be unique")
            seen_guids.add(item["guid"])
            branches = set(item) & {"component", "tabs", "cols", "rows"}
            if len(branches) > 1:
                raise ValueError("A layout slot must contain one component or nested rows/columns")
            for name in branches:
                item[name] = component(item[name], current + "/" + name) if name in {"component", "tabs"} else rows(item[name], current + "/" + name)
            if "style" in item and not isinstance(item["style"], dict):
                raise ValueError("Layout style must be an object")
            result.append(item)
        return result
    result = rows(proposed, "/views/rows")
    # Product layout members are retained just as the designer requires.
    after_ids = set()
    def after(value):
        if isinstance(value, dict):
            if isinstance(value.get("guid"), str):
                after_ids.add(value["guid"])
            for child in value.values():
                after(child)
        elif isinstance(value, list):
            for child in value:
                after(child)
    after(result)
    if product_ids - after_ids:
        raise ValueError("Product layout members cannot be removed")
    control_catalog(result)
    return result
