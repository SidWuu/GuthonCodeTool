"""Native PAGE XML projection and source-preserving structural edits.

XML remains the authority. JSON is a transient projection for the shared PAGE
editor; unchanged XML tokens, including comments, attributes and CDATA, are
copied from the original document rather than serialized again.
"""

from __future__ import annotations

from dataclasses import dataclass
import copy
import json
import re
from xml.sax.saxutils import escape, quoteattr

from common import page_editor, page_structure
from common.page_projection import pointer_parts, pointer_value
from . import xml_source
from .xml_source import XmlNode as _Xml, opening as _opening

_ARRAY_ITEMS = {
    "rows": "row",
    "ctrls": "ctrl",
    "fields": "field",
    "buttons": "button",
    "bnts": "bnt",
    "pks": "pk",
    "cols": "col",
    "cells": "cell",
    "gridRows": "gridRow",
    "tabPages": "tabPage",
    "childs": "child",
    "items": "item",
    "columns": "column",
    "options": "option",
}
_MAP_TAGS = {
    "pageSetup",
    "params",
    "pageEvents",
    "superPageEvents",
    "serviceEvents",
    "superServiceEvents",
    "datasource",
    "selectBox",
    "fileInput",
    "style",
    "authHide",
    "component",
    "views",
}
_NUMERIC = {
    "pageType",
    "width",
    "height",
    "labelWidth",
    "length",
    "scale",
    "colGroupType",
    "bntType",
    "bntSubType",
    "pcAndH5",
    "sortable",
    "editable",
    "forceSelection",
    "codeType",
    "areaRange",
    "dqMust1",
    "dqMust2",
    "dqMust3",
    "dqMust4",
    "dsType",
    "flexGrow",
    "showBorder",
    "canDrag",
    "hideType",
    "rowType",
    "maxLength",
    "maxTextLength",
    "defaultPageSize",
    "minHeight",
    "textAreaRows",
    "align",
    "pinAlign",
    "format",
}
_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_.:-]*$")
_INTEGER = re.compile(r"^-?(?:0|[1-9][0-9]*)$")
_NUMBER = re.compile(r"^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$")


@dataclass
class _Value:
    node: _Xml | None
    kind: str
    value: object
    children: object = None
    inner: object = None


def _parse(text, *, require_page=True):
    raw, root = xml_source.parse(text)
    if require_page and root.tag != "page":
        raise ValueError("Native PAGE XML root must be <page>")
    return raw, root


def _scalar(node, key):
    if node.attrs.get("nil", "").lower() == "true":
        return None
    text = "".join(node.text)
    kind = node.attrs.get("type", "") if node.tag in {"v", "item"} else ""
    if kind == "String":
        return text
    if kind == "Boolean":
        if text.lower() not in ("true", "false"):
            raise ValueError("Invalid native Boolean value")
        return text.lower() == "true"
    if kind in {"Double", "Float", "BigDecimal"}:
        try:
            return float(text)
        except ValueError as error:
            raise ValueError("Invalid native numeric value") from error
    if kind in {"Integer", "Long", "Short"}:
        try:
            return int(text)
        except ValueError as error:
            raise ValueError("Invalid native integer value") from error
    if (key.startswith("is") or key in _NUMERIC) and _NUMBER.fullmatch(text):
        return int(text) if _INTEGER.fullmatch(text) else float(text)
    return text


def _project(node, key=None):
    key = key or node.tag
    if node.attrs.get("nil", "").lower() == "true":
        return _Value(node, "scalar", None)
    if node.tag in {"v", "item"} and node.attrs.get("type") == "List":
        if any(child.tag != "item" for child in node.children):
            raise ValueError("Invalid native PAGE list item")
        children = [_project(child) for child in node.children]
        return _Value(node, "array", [item.value for item in children], children)
    if node.tag in _ARRAY_ITEMS:
        if node.children and any(
            child.tag != node.children[0].tag for child in node.children
        ):
            raise ValueError("Unexpected native PAGE collection member: " + node.tag)
        children = [_project(child) for child in node.children]
        return _Value(node, "array", [item.value for item in children], children)
    if node.children and all(
        child.tag == "attrs" and "k" in child.attrs for child in node.children
    ):
        entries = {}
        for entry in node.children:
            name = entry.attrs["k"]
            if (
                name in entries
                or len(entry.children) != 1
                or entry.children[0].tag != "v"
            ):
                raise ValueError("Ambiguous native PAGE attribute map")
            inner = _project(entry.children[0], name)
            entries[name] = _Value(entry, "entry", inner.value, inner=inner)
        return _Value(
            node, "attrs", {name: item.value for name, item in entries.items()}, entries
        )
    if node.children:
        groups = {}
        for child in node.children:
            groups.setdefault(child.tag, []).append(_project(child))
        entries = {}
        for name, children in groups.items():
            entries[name] = (
                children[0]
                if len(children) == 1
                else _Value(None, "repeat", [x.value for x in children], children)
            )
        return _Value(
            node,
            "object",
            {name: item.value for name, item in entries.items()},
            entries,
        )
    if (
        node.tag in {"v", "item"} and node.attrs.get("type") == "Map"
    ) or key in _MAP_TAGS:
        return _Value(
            node,
            "attrs"
            if node.tag in {"v", "item"}
            and node.attrs.get("type") == "Map"
            or key in {"pageSetup", "params"}
            else "object",
            {},
            {},
        )
    return _Value(node, "scalar", _scalar(node, key))


def _snapshot(text):
    raw, root = _parse(text)
    projected = _project(root)
    data = projected.value
    if (
        not isinstance(data, dict)
        or not isinstance(data.get("pageId"), str)
        or not data["pageId"].strip()
    ):
        raise ValueError("Native PAGE XML requires a non-empty pageId")
    return raw, projected


def decode(text):
    """Return the native PAGE model without changing the original XML."""
    return _snapshot(text)[1].value


def is_native(text):
    """Identify the native PAGE root; malformed XML is reported explicitly."""
    return _parse(text, require_page=False)[1].tag == "page"


def display_text(text):
    """Return a JSON view for the shared PAGE editor; hashes still bind XML."""
    return json.dumps(decode(text), ensure_ascii=False, indent=2, allow_nan=False)


def _same(left, right):
    if type(left) in (int, float) and type(right) in (int, float):
        return left == right
    if type(left) is not type(right):
        return False
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(
            _same(left[k], right[k]) for k in left
        )
    if isinstance(left, list):
        return len(left) == len(right) and all(_same(a, b) for a, b in zip(left, right))
    return left == right


def _value_text(value):
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (str, int, float)) and not isinstance(value, bool):
        return str(value)
    raise ValueError("Unsupported native PAGE scalar")


def _xml_name(name):
    if not isinstance(name, str) or not _NAME.fullmatch(name):
        raise ValueError("Unsupported native PAGE element name")
    return name


def _new_map_entry(name, value):
    if not isinstance(name, str):
        raise ValueError("Native map key must be a string")
    opening = "<attrs k=" + quoteattr(name) + ">"
    if value is None:
        body = '<v nil="true"/>'
    elif isinstance(value, dict):
        body = (
            '<v type="Map">'
            + "".join(_new_map_entry(k, v) for k, v in value.items())
            + "</v>"
        )
    elif isinstance(value, list):
        body = (
            '<v type="List">'
            + "".join(_new_typed_item(item).decode("utf-8") for item in value)
            + "</v>"
        )
    else:
        kind = (
            "Boolean"
            if isinstance(value, bool)
            else "Double"
            if isinstance(value, (int, float))
            else "String"
        )
        body = '<v type="' + kind + '">' + escape(_value_text(value)) + "</v>"
    return (opening + body + "</attrs>").encode("utf-8")


def _new_typed_item(value):
    if value is None:
        return b'<item nil="true"/>'
    if isinstance(value, dict):
        return (
            b'<item type="Map">'
            + b"".join(_new_map_entry(k, v) for k, v in value.items())
            + b"</item>"
        )
    if isinstance(value, list):
        return (
            b'<item type="List">'
            + b"".join(_new_typed_item(item) for item in value)
            + b"</item>"
        )
    kind = (
        "Boolean"
        if isinstance(value, bool)
        else "Double"
        if isinstance(value, (int, float))
        else "String"
    )
    return (
        '<item type="' + kind + '">' + escape(_value_text(value)) + "</item>"
    ).encode("utf-8")


def _new_element(tag, value):
    tag = _xml_name(tag)
    if isinstance(value, list):
        item_tag = _ARRAY_ITEMS.get(tag)
        if not item_tag:
            raise ValueError("Unsupported new PAGE XML collection: " + tag)
        body = b"".join(_new_element(item_tag, item) for item in value)
    elif isinstance(value, dict):
        if tag in {"pageSetup", "params"}:
            body = b"".join(_new_map_entry(k, v) for k, v in value.items())
        else:
            body = b"".join(_new_element(k, v) for k, v in value.items())
    elif value is None:
        body = b""
    else:
        value_text = _value_text(value)
        if tag.endswith("Script") or tag in {"script", "sql", "compScript"}:
            content = value_text.replace("]]>", "]]]]><![CDATA[>")
            return (
                "<" + tag + ' r="1"><![CDATA[' + content + "]]></" + tag + ">"
            ).encode("utf-8")
        body = escape(value_text).encode("utf-8")
    return ("<" + tag + ">").encode() + body + ("</" + tag + ">").encode()


def _scalar_xml(raw, node, value):
    opening = _opening(raw, node)
    if node.attrs.get("nil", "").lower() == "true":
        opening = re.sub(
            rb'\s+nil\s*=\s*(["\'])true\1', b"", opening, count=1, flags=re.I
        )
        if node.tag in {"v", "item"} and "type" not in node.attrs and value is not None:
            kind = (
                "Boolean"
                if isinstance(value, bool)
                else "Double"
                if isinstance(value, (int, float))
                else "String"
            )
            opening = opening[:-1] + (' type="' + kind + '">').encode()
    if value is None:
        if node.tag not in {"v", "item"}:
            raise ValueError("Null is unsupported for this native XML element")
        opening = re.sub(rb'\s+type\s*=\s*(["\']).*?\1', b"", opening, count=1)
        return opening[:-1] + b' nil="true"/>'
    if isinstance(value, (dict, list)):
        raise ValueError("Native scalar type cannot change to a container")
    return xml_source.render_text_leaf(raw, node, _value_text(value), opening_token=opening)



def _identity(value):
    if isinstance(value, dict):
        for key in ("guid", "id", "fieldId"):
            ident = value.get(key)
            if (
                isinstance(ident, (str, int))
                and not isinstance(ident, bool)
                and str(ident)
            ):
                return (key, str(ident))
    return None


def _preserve_layout_metadata(before, after):
    """Keep existing non-layout metadata when the designer rebuilds layout rows."""
    if isinstance(before, dict) and isinstance(after, dict):
        structure = {
            "component",
            "tabs",
            "cols",
            "rows",
            "tabPages",
            "fields",
            "buttons",
            "gridRows",
            "cells",
            "childs",
        }
        for key, value in before.items():
            if key not in after and key not in structure:
                after[key] = copy.deepcopy(value)
            elif key in after:
                _preserve_layout_metadata(value, after[key])
    elif isinstance(before, list) and isinstance(after, list):

        def key(item):
            identity = _identity(item)
            if (
                identity is None
                and isinstance(item, dict)
                and isinstance(item.get("name"), str)
            ):
                identity = ("name", item["name"], item.get("type"))
            return identity

        for item in after:
            identity = key(item)
            matches = [
                old for old in before if identity is not None and key(old) == identity
            ]
            if len(matches) == 1:
                _preserve_layout_metadata(matches[0], item)


def _at(lens, pointer):
    item = lens
    try:
        for part in pointer_parts(pointer):
            if item.kind == "entry":
                item = item.inner
            if item.kind in {"object", "attrs"}:
                item = item.children[part]
            elif item.kind in {"array", "repeat"}:
                if not re.fullmatch(r"0|[1-9][0-9]*", part):
                    raise ValueError("Invalid PAGE XML array position")
                item = item.children[int(part)]
            else:
                raise ValueError("PAGE XML pointer does not identify a container")
    except (KeyError, IndexError) as error:
        raise ValueError("PAGE XML pointer does not exist") from error
    return item


def _render(raw, lens, value, path, origins):
    node = lens.node
    if _same(lens.value, value):
        return raw[node.start : node.end] if node else b""
    if lens.kind == "entry":
        result = _render(raw, lens.inner, value, path, origins)
        inner = lens.inner.node
        return raw[node.start : inner.start] + result + raw[inner.end : node.end]
    if lens.kind == "scalar":
        return _scalar_xml(raw, node, value)
    if lens.kind == "repeat":
        raise ValueError("Cannot modify an ambiguous repeated XML element")
    if lens.kind == "array":
        if not isinstance(value, list):
            raise ValueError("Native PAGE collection must remain an array")
        children = lens.children
        used = set()
        rendered = []
        for i, item in enumerate(value):
            origin = origins.get(path + "/" + str(i))
            found = None
            identity = _identity(item)
            if origin is None and identity is not None:
                matches = [
                    j
                    for j, old in enumerate(children)
                    if j not in used and _identity(old.value) == identity
                ]
                if len(matches) == 1:
                    found = matches[0]
            if origin is None and found is None:
                matches = [
                    j
                    for j, old in enumerate(children)
                    if j not in used and _same(old.value, item)
                ]
                if len(matches) == 1:
                    found = matches[0]
            if (
                origin is None
                and found is None
                and i < len(children)
                and i not in used
                and identity is None
                and _identity(children[i].value) is None
            ):
                found = i
            if origin is not None:
                rendered.append(
                    _render(raw, origin, item, path + "/" + str(i), origins)
                )
            elif found is not None:
                used.add(found)
                rendered.append(
                    _render(raw, children[found], item, path + "/" + str(i), origins)
                )
            elif node.tag in {"v", "item"} and node.attrs.get("type") == "List":
                rendered.append(_new_typed_item(item))
            else:
                rendered.append(
                    _new_element(
                        children[0].node.tag if children else _ARRAY_ITEMS[node.tag],
                        item,
                    )
                )
        if not children:
            body = b"".join(rendered)
            if node.self_closing:
                return _opening(raw, node) + body + ("</" + node.tag + ">").encode()
            return (
                raw[node.start : node.close_start]
                + body
                + raw[node.close_start : node.end]
            )
        gaps = [raw[node.open_end : children[0].node.start]]
        gaps.extend(
            raw[a.node.end : b.node.start] for a, b in zip(children, children[1:])
        )
        gaps.append(raw[children[-1].node.end : node.close_start])
        pieces = [raw[node.start : node.open_end], gaps[0]]
        for i in range(len(children)):
            if i < len(rendered):
                pieces.append(rendered[i])
            if i < len(children) - 1:
                pieces.append(gaps[i + 1])
        if len(rendered) > len(children):
            sep = gaps[-2] if len(gaps) > 2 and not gaps[-2].strip() else b"\n"
            for fragment in rendered[len(children) :]:
                pieces.extend([sep, fragment])
        pieces.extend([gaps[-1], raw[node.close_start : node.end]])
        return b"".join(pieces)
    if not isinstance(value, dict):
        raise ValueError("Native PAGE object must remain an object")
    replacements = []
    for name, child in lens.children.items():
        if child.kind == "repeat":
            if name not in value or not _same(child.value, value[name]):
                raise ValueError("Cannot modify an ambiguous repeated XML element")
            continue
        if name not in value:
            replacements.append((child.node.start, child.node.end, b""))
        elif not _same(child.value, value[name]):
            replacements.append(
                (
                    child.node.start,
                    child.node.end,
                    _render(
                        raw,
                        child,
                        value[name],
                        path + "/" + name.replace("~", "~0").replace("/", "~1"),
                        origins,
                    ),
                )
            )
    additions = []
    for name, item in value.items():
        if name not in lens.children:
            additions.append(
                _new_map_entry(name, item)
                if lens.kind == "attrs"
                else _new_element(name, item)
            )
    if node.self_closing:
        if replacements:
            raise ValueError("Invalid XML self-closing element edit")
        return (
            _opening(raw, node) + b"".join(additions) + ("</" + node.tag + ">").encode()
        )
    result = bytearray(raw[node.start : node.end])
    if additions:
        replacements.append((node.close_start, node.close_start, b"".join(additions)))
    for start, end, content in sorted(replacements, key=lambda x: x[0], reverse=True):
        result[start - node.start : end - node.start] = content
    return bytes(result)


def _replace_projected(raw, root, target, json_pointer, value):
    node = target.node
    changed = _render(raw, target, value, json_pointer, {})
    result = (raw[: node.start] + changed + raw[node.end :]).decode("utf-8")
    expected = copy.deepcopy(root.value)
    parts = pointer_parts(json_pointer)
    if not parts:
        raise ValueError("PAGE XML root cannot be a text target")
    parent = (
        pointer_value(
            expected,
            "/"
            + "/".join(
                part.replace("~", "~0").replace("/", "~1") for part in parts[:-1]
            ),
        )
        if len(parts) > 1
        else expected
    )
    if isinstance(parent, list):
        parent[int(parts[-1])] = value
    else:
        parent[parts[-1]] = value
    if not _same(decode(result), expected):
        raise ValueError(
            "Native XML round-trip did not preserve the requested PAGE model"
        )
    return result


def replace_text(text, json_pointer, content):
    """Replace one existing string leaf while preserving all other XML tokens."""
    if not isinstance(content, str) or len(content) > 500_000:
        raise ValueError("PAGE text must be a bounded string")
    raw, root = _snapshot(text)
    target = _at(root, json_pointer)
    if not isinstance(target.value, str) or target.kind not in {"scalar", "entry"}:
        raise ValueError("PAGE XML pointer must identify an existing string leaf")
    return _replace_projected(raw, root, target, json_pointer, content)


def replace_value(text, json_pointer, value):
    """Replace one existing native XML list, preserving all other XML tokens."""
    if not isinstance(value, list):
        raise ValueError("PAGE XML collection value must be a list")
    raw, root = _snapshot(text)
    target = _at(root, json_pointer)
    kind = target.inner.kind if target.kind == "entry" else target.kind
    if kind != "array":
        raise ValueError("PAGE XML pointer must identify an existing collection")
    return _replace_projected(raw, root, target, json_pointer, value)


def apply_operations(text, operations):
    """Apply shared PAGE operations and return XML with untouched tokens preserved."""
    raw, root = _snapshot(text)
    before = root.value
    validation = copy.deepcopy(before)
    _, owners = page_structure.targets(validation)
    for op in operations if isinstance(operations, list) else ():
        if not isinstance(op, dict) or op.get("kind") != "event":
            continue
        owner = owners.get(op.get("ownerPointer"))
        if not owner:
            continue
        pointer = (
            owner[1]
            + "/"
            + str(op.get("eventType", ""))
            + "/"
            + str(op.get("eventName", ""))
        )
        try:
            if pointer_value(validation, pointer) is None:
                parent = pointer_value(validation, pointer.rpartition("/")[0])
                parent[pointer_parts(pointer)[-1]] = ""
        except (KeyError, TypeError, ValueError):
            pass
    projected = json.dumps(validation, ensure_ascii=False, indent=2, allow_nan=False)
    after = json.loads(page_editor.apply_operations(projected, operations))
    for op in operations:
        if op.get("kind") == "layout":
            _preserve_layout_metadata(before.get("views", {}), after.get("views", {}))
        elif op.get("kind") == "datasource":
            pointer = op["ownerPointer"] + "/datasource"
            try:
                old = pointer_value(before, pointer)
            except KeyError:
                continue
            new = pointer_value(after, pointer)
            allowed = {
                "dsType",
                "sql",
                "script",
                "fields",
                "pks",
                "isSubSelect",
                "isDisableDataAuth",
                "saveTableId",
                "tableNames",
            }
            for key, value in old.items():
                if key not in allowed and key not in new:
                    new[key] = copy.deepcopy(value)
    origins = {}
    added = {}
    for op in operations:
        if op.get("kind") not in {"copy", "move", "insert"}:
            continue
        target = op.get("targetCollectionPointer", op["collectionPointer"])
        old_target = _at(root, target)
        if old_target.kind != "array":
            raise ValueError("Target is not a native PAGE collection")
        next_index = len(old_target.value) + added.get(target, 0)
        added[target] = added.get(target, 0) + 1
        if op["kind"] in {"copy", "move"}:
            source = _at(root, op["collectionPointer"])
            matches = [
                item
                for item in source.children
                if isinstance(item.value, dict)
                and page_editor._key(item.value) == op["fieldKey"]
            ]
            if len(matches) != 1:
                raise ValueError("Copy/move source is ambiguous")
            origins[target + "/" + str(next_index)] = matches[0]
    changed = _render(raw, root, after, "", origins)
    result = (raw[: root.node.start] + changed + raw[root.node.end :]).decode("utf-8")
    if not _same(decode(result), after):
        raise ValueError(
            "Native XML round-trip did not preserve the requested PAGE model"
        )
    return result
