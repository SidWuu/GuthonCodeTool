"""Stable PAGE script projection and minimal JSON string replacement."""

from __future__ import annotations

import hashlib
import json
import re
from collections import Counter
from dataclasses import asdict, dataclass


SCRIPT_KEYS = {
    "script",
    "beforeSaveScript",
    "afterSaveScript",
    "onClickScript",
    "onOpenScript",
    "onCreateScript",
    "onAfterLoadScript",
    "onChangeScript",
    "onBeforeWinCloseScript",
    "doMethodScript",
    "compScript",
    "sql",
}
EVENT_SUPERS = {"serviceEvents": "superServiceEvents", "pageEvents": "superPageEvents"}
PAGE_NODE_PARSER_VERSION = "page-nodes-v1"
PAGE_FIELD_PARSER_VERSION = "page-fields-v1"
PAGE_FIELD_RELATION_PARSER_VERSION = "page-field-relations-v2"
SERVICE_EVENT_KEYS = {"beforeSave", "afterSave", "beforeSqlSelect"}
INHERIT_MARKER = re.compile(r"(?m)^[ \t]*(?:return[ \t]+)?@?inherit\(\);[ \t]*\r?$")


@dataclass(frozen=True)
class ScriptField:
    json_pointer: str
    key: str
    script_type: str
    display_name: str
    projection_name: str
    original_value: str
    effective_value: str

    def to_dict(self):
        result = asdict(self)
        result["original_hash"] = text_hash(self.original_value)
        result["effective_hash"] = text_hash(self.effective_value)
        return result


@dataclass(frozen=True)
class PageNode:
    """A PAGE locator; semantic_node_id is scoped to the containing PAGE object."""

    json_pointer: str
    node_type: str
    label: str
    semantic_node_id: str | None
    identity_stability: str
    event_scope: str | None
    owner_type: str
    owner_id: str | None


@dataclass(frozen=True)
class PageFieldEntity:
    """One UI field with an explicit PAGE locator and native identity evidence."""

    json_pointer: str
    collection_pointer: str
    ordinal: int
    region_type: str
    component_type: str
    field_id: str
    native_id: str
    native_guid: str
    table_id: str
    column_id: str
    label: str
    semantic_field_id: str | None
    identity_stability: str


@dataclass(frozen=True)
class PageFieldRelation:
    """Explicit selectBox evidence; resolution never implies complete reference coverage."""

    source_pointer: str
    collection_pointer: str
    source_field_id: str
    relation_type: str
    target_field_id: str
    target_pointer: str | None
    resolution: str
    confidence: str
    evidence_pointer: str


def text_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def json_pointer(parts) -> str:
    return "" if not parts else "/" + "/".join(str(part).replace("~", "~0").replace("/", "~1") for part in parts)


def pointer_parts(pointer: str):
    if pointer == "":
        return []
    if not pointer.startswith("/"):
        raise ValueError(f"Invalid JSON Pointer: {pointer}")
    return [part.replace("~1", "/").replace("~0", "~") for part in pointer[1:].split("/")]


def pointer_value(value, pointer: str):
    current = value
    for part in pointer_parts(pointer):
        if isinstance(current, list):
            try:
                current = current[int(part)]
            except (ValueError, IndexError) as error:
                raise KeyError(pointer) from error
        elif isinstance(current, dict) and part in current:
            current = current[part]
        else:
            raise KeyError(pointer)
    return current


def is_script_key(key, event_type: str | None = None) -> bool:
    return key != "superScript" and (
        key in SCRIPT_KEYS
        or str(key).endswith("Script")
        or (event_type == "serviceEvents" and key in SERVICE_EVENT_KEYS)
    )


def resolve_inherited_script(script: str, inherited: str) -> str:
    if not INHERIT_MARKER.search(script):
        return script
    return INHERIT_MARKER.sub(lambda _match: inherited.rstrip("\r\n"), script)


def script_extension(key: str, event_type: str | None) -> str:
    if key == "sql":
        return "sql"
    if event_type:
        return "vm" if event_type == "serviceEvents" else "js"
    return "vm" if "SaveScript" in key or key in {"script", "doMethodScript", "compScript"} else "js"


def _safe_name(value: str) -> str:
    value = re.sub(r"[<>:\"/\\|?*\x00-\x1f]", "_", value).strip(" .")
    return value[:120] or "script"


def _projection_name(display_path, key, event_type, pointer):
    readable = ".".join([*(str(value) for value in display_path[-3:] if str(value)), key])
    digest = hashlib.sha256(pointer.encode("utf-8")).hexdigest()[:10]
    return f"{_safe_name(readable)}.{digest}.{script_extension(key, event_type)}"


def _display_name(display_path, key):
    parts = []
    for value in [*(str(value) for value in display_path[-3:] if str(value)), key]:
        if not parts or parts[-1] != value:
            parts.append(value)
    return " / ".join(parts)


def _node_display_label(value: dict, node_kind: str | None = None) -> str:
    if node_kind == "button":
        name = value.get("name")
        alias = value.get("aliasName")
        readable_name = str(name).strip() if isinstance(name, (str, int, float)) else ""
        readable_alias = str(alias).strip() if isinstance(alias, (str, int, float)) else ""
        return " ".join(part for part in (readable_name, readable_alias) if part)
    for key in ("aliasName", "name"):
        label = value.get(key)
        if isinstance(label, (str, int, float)) and str(label).strip():
            return str(label).strip()
    label = value.get("label")
    field_id = value.get("fieldId")
    readable_label = str(label).strip() if isinstance(label, (str, int, float)) else ""
    readable_field_id = str(field_id).strip() if isinstance(field_id, (str, int, float)) else ""
    if readable_label and readable_field_id and readable_label != readable_field_id:
        return f"{readable_label} {readable_field_id}"
    if readable_label or readable_field_id:
        return readable_label or readable_field_id
    fallback = value.get("id")
    return str(fallback).strip() if isinstance(fallback, (str, int, float)) else ""


def extract_page_scripts(value) -> list[ScriptField]:
    """Return every explicit script string with a stable pointer and readable unique filename."""

    fields = []

    def walk(current, parts, display_path, inherited_scripts=None, event_type=None, node_kind=None):
        if isinstance(current, dict):
            label = _node_display_label(current, node_kind)
            next_display = display_path + ([label] if label else [])
            for key, child in current.items():
                child_parts = parts + [key]
                if is_script_key(key, event_type) and isinstance(child, str):
                    inherited = (inherited_scripts or {}).get(key, "")
                    if key == "script":
                        inherited = current.get("superScript", "")
                    inherited = inherited if isinstance(inherited, str) else ""
                    effective = resolve_inherited_script(child, inherited)
                    pointer = json_pointer(child_parts)
                    fields.append(
                        ScriptField(
                            json_pointer=pointer,
                            key=key,
                            script_type=script_extension(key, event_type),
                            display_name=_display_name(next_display, key),
                            projection_name=_projection_name(next_display, key, event_type, pointer),
                            original_value=child,
                            effective_value=effective,
                        )
                    )
                elif key not in EVENT_SUPERS.values():
                    inherited = current.get(EVENT_SUPERS.get(key, ""), {})
                    walk(
                        child,
                        child_parts,
                        next_display,
                        inherited if isinstance(inherited, dict) else None,
                        key if key in EVENT_SUPERS else event_type,
                        "button" if key in {"button", "buttons"} else None,
                    )
        elif isinstance(current, list):
            for index, child in enumerate(current):
                walk(child, parts + [index], display_path, inherited_scripts, event_type, node_kind)

    walk(value, [], [])
    return fields


def extract_page_fields(value, *, include_content: bool = True) -> list[dict]:
    """Return PAGE field collections; materialize content only for document callers."""

    fields = []

    def walk(current, parts, labels):
        if isinstance(current, dict):
            label = str(current.get("name") or current.get("aliasName") or current.get("id") or "").strip()
            next_labels = [*labels, *([label] if label else [])]
            for key, child in current.items():
                child_parts = [*parts, key]
                if key == "fields" and isinstance(child, list):
                    fields.append(
                        {
                            "json_pointer": json_pointer(child_parts),
                            "script_type": "fields",
                            "label": " / ".join(next_labels[-3:]) or "字段",
                            "content": json.dumps(child, ensure_ascii=False, indent=2) if include_content else None,
                        }
                    )
                else:
                    walk(child, child_parts, next_labels)
        elif isinstance(current, list):
            for index, child in enumerate(current):
                walk(child, [*parts, index], labels)

    walk(value, [], [])
    return fields


def _list_item_identity(
    items: list, item: object, collection_key: str, counts_cache: dict
) -> tuple[str | None, str | None, bool]:
    if not isinstance(item, dict):
        return None, None, False
    keys = ("fieldId", "guid", "id") if collection_key == "fields" else ("guid", "id")
    for key in keys:
        candidate = item.get(key)
        if isinstance(candidate, bool) or not isinstance(candidate, (str, int)):
            continue
        value = str(candidate).strip()
        if not value:
            continue
        cache_key = (id(items), key)
        if cache_key not in counts_cache:
            counts_cache[cache_key] = Counter(
                str(other[key]).strip()
                for other in items
                if isinstance(other, dict)
                and not isinstance(other.get(key), bool)
                and isinstance(other.get(key), (str, int))
                and str(other[key]).strip()
            )
        return key, value, counts_cache[cache_key][value] != 1
    return None, None, False


def _semantic_location(value, pointer: str, counts_cache: dict) -> tuple[str | None, str, str, str | None]:
    current = value
    parent_key = ""
    path: list[list[str]] = []
    stability = "STABLE"
    owner_type = "PAGE"
    owner_id = None
    for part in pointer_parts(pointer):
        if isinstance(current, dict):
            current = current[part]
            parent_key = part
            path.append(["key", part])
        elif isinstance(current, list):
            index = int(part)
            item = current[index]
            key, item_id, duplicate = _list_item_identity(current, item, parent_key, counts_cache)
            if key is None:
                if stability == "STABLE":
                    stability = "UNSTABLE"
            elif duplicate:
                stability = "AMBIGUOUS"
            else:
                path.append(["item", key, item_id])
            owner_type = {"fields": "FIELD", "buttons": "BUTTON", "views": "VIEW"}.get(parent_key, "LIST_ITEM")
            owner_id = item_id if key and not duplicate else None
            current = item
            parent_key = ""
        else:
            raise KeyError(pointer)
    semantic_node_id = None
    if stability == "STABLE":
        semantic_path = json.dumps(path, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        semantic_node_id = "page-node:v1:" + hashlib.sha256(semantic_path).hexdigest()
    return semantic_node_id, stability, owner_type, owner_id


def extract_page_nodes(value) -> list[PageNode]:
    """Describe existing script/SQL/field-collection projections without loading their content into the locator.

    Array positions are never semantic identities. An array item needs a unique,
    non-label native key at every array level; otherwise the locator is read-only
    and must be re-resolved from its current JSON Pointer and source hash.
    """

    if not isinstance(value, dict):
        raise ValueError("PAGE JSON root must be an object")
    nodes = []
    counts_cache = {}
    for field in extract_page_scripts(value):
        semantic_id, stability, owner_type, owner_id = _semantic_location(value, field.json_pointer, counts_cache)
        parts = pointer_parts(field.json_pointer)
        event_scope = next(
            ("SERVICE" if part == "serviceEvents" else "PAGE" for part in reversed(parts[:-1])
             if part in EVENT_SUPERS),
            None,
        )
        nodes.append(PageNode(
            json_pointer=field.json_pointer,
            node_type="SQL" if field.key == "sql" else "SCRIPT",
            label=field.display_name,
            semantic_node_id=semantic_id,
            identity_stability=stability,
            event_scope=event_scope,
            owner_type=owner_type,
            owner_id=owner_id,
        ))
    for field in extract_page_fields(value, include_content=False):
        semantic_id, stability, owner_type, owner_id = _semantic_location(value, field["json_pointer"], counts_cache)
        nodes.append(PageNode(
            json_pointer=field["json_pointer"],
            node_type="FIELD_COLLECTION",
            label=field["label"],
            semantic_node_id=semantic_id,
            identity_stability=stability,
            event_scope=None,
            owner_type=owner_type,
            owner_id=owner_id,
        ))
    return nodes


def extract_page_field_entities(value) -> list[PageFieldEntity]:
    """Describe UI fields only; datasource projection columns have no native field identity.

    The region comes from the enclosing component's explicit type. Unknown
    component types remain UNKNOWN rather than being inferred from labels.
    """

    if not isinstance(value, dict):
        raise ValueError("PAGE JSON root must be an object")
    regions = {
        "input-box": "FORM",
        "search-box": "SEARCH",
        "table-main": "MAIN_TABLE",
        "table-item": "DETAIL_TABLE",
    }
    fields = []
    counts_cache = {}
    for collection in extract_page_fields(value, include_content=False):
        collection_pointer = collection["json_pointer"]
        parent_pointer = collection_pointer.rpartition("/")[0]
        parent = pointer_value(value, parent_pointer)
        if not isinstance(parent, dict) or not isinstance(parent.get("type"), str):
            continue  # datasource.fields belongs to source projection, not a UI field region
        component_type = parent["type"]
        region_type = regions.get(component_type, "UNKNOWN")
        items = pointer_value(value, collection_pointer)
        for ordinal, item in enumerate(items):
            if not isinstance(item, dict):
                continue
            pointer = f"{collection_pointer}/{ordinal}"
            semantic_id, stability, _owner_type, _owner_id = _semantic_location(value, pointer, counts_cache)

            def native(key: str) -> str:
                candidate = item.get(key)
                return (str(candidate).strip() if isinstance(candidate, (str, int))
                        and not isinstance(candidate, bool) else "")

            fields.append(PageFieldEntity(
                json_pointer=pointer,
                collection_pointer=collection_pointer,
                ordinal=ordinal,
                region_type=region_type,
                component_type=component_type,
                field_id=native("fieldId"),
                native_id=native("id"),
                native_guid=native("guid"),
                table_id=native("tbId"),
                column_id=native("fdId"),
                label=native("label") or native("disName"),
                semantic_field_id=semantic_id,
                identity_stability=stability,
            ))
    return fields


def extract_page_field_relations(
    value, fields: list[PageFieldEntity] | None = None,
) -> list[PageFieldRelation]:
    """Resolve selectCodefieldId; retain unparsed mapping text as dependency evidence."""

    fields = fields if fields is not None else extract_page_field_entities(value)
    by_collection: dict[tuple[str, str], list[PageFieldEntity]] = {}
    by_page: dict[str, list[PageFieldEntity]] = {}
    for field in fields:
        if field.field_id:
            by_collection.setdefault((field.collection_pointer, field.field_id), []).append(field)
            by_page.setdefault(field.field_id, []).append(field)
    relations = []
    for field in fields:
        source = pointer_value(value, field.json_pointer)
        select = source.get("selectBox") if isinstance(source, dict) else None
        if not isinstance(select, dict):
            continue
        other_set_fields = select.get("otherSetFields")
        if other_set_fields:
            relations.append(PageFieldRelation(
                source_pointer=field.json_pointer,
                collection_pointer=field.collection_pointer,
                source_field_id=field.field_id,
                relation_type="OTHER_SET_FIELDS_UNPARSED",
                target_field_id="",
                target_pointer=None,
                resolution="UNPARSED",
                confidence="LOW",
                evidence_pointer=field.json_pointer + "/selectBox/otherSetFields",
            ))
        raw_target = select.get("selectCodefieldId")
        if isinstance(raw_target, bool) or not isinstance(raw_target, (str, int)):
            continue
        target_id = str(raw_target).strip()
        if not target_id:
            continue
        same_collection = by_collection.get((field.collection_pointer, target_id), [])
        same_page = by_page.get(target_id, [])
        if target_id == field.field_id:
            resolution, confidence, target = "SELF_REFERENCE", "LOW", None
        elif len(same_collection) == 1:
            resolution, confidence, target = "RESOLVED_COLLECTION", "HIGH", same_collection[0].json_pointer
        elif len(same_collection) > 1 or len(same_page) > 1:
            resolution, confidence, target = "AMBIGUOUS", "LOW", None
        elif len(same_page) == 1:
            resolution, confidence, target = "POSSIBLE_PAGE", "MEDIUM", same_page[0].json_pointer
        else:
            resolution, confidence, target = "MISSING", "LOW", None
        relations.append(PageFieldRelation(
            source_pointer=field.json_pointer,
            collection_pointer=field.collection_pointer,
            source_field_id=field.field_id,
            relation_type="SELECT_CODE_FIELD",
            target_field_id=target_id,
            target_pointer=target,
            resolution=resolution,
            confidence=confidence,
            evidence_pointer=field.json_pointer + "/selectBox/selectCodefieldId",
        ))
    return relations


class _JsonStringLocator:
    def __init__(self, text: str):
        self.text = text
        self.length = len(text)
        self.spans = {}

    def locate(self):
        end = self._value(self._space(0), [])
        if self._space(end) != self.length:
            raise ValueError("Unexpected data after JSON value")
        return self.spans

    def _space(self, index):
        while index < self.length and self.text[index] in " \t\r\n":
            index += 1
        return index

    def _string(self, index):
        if index >= self.length or self.text[index] != '"':
            raise ValueError(f"Expected JSON string at offset {index}")
        escaped = False
        cursor = index + 1
        while cursor < self.length:
            char = self.text[cursor]
            if char == '"' and not escaped:
                end = cursor + 1
                return json.loads(self.text[index:end]), end
            if char == "\\" and not escaped:
                escaped = True
            else:
                escaped = False
            cursor += 1
        raise ValueError("Unterminated JSON string")

    def _value(self, index, parts):
        index = self._space(index)
        if index >= self.length:
            raise ValueError("Unexpected end of JSON")
        char = self.text[index]
        if char == '"':
            value, end = self._string(index)
            pointer = json_pointer(parts)
            if pointer in self.spans:
                raise ValueError(f"Duplicate JSON member path: {pointer}")
            self.spans[pointer] = (index, end, value)
            return end
        if char == "{":
            cursor = self._space(index + 1)
            if cursor < self.length and self.text[cursor] == "}":
                return cursor + 1
            while True:
                key, cursor = self._string(cursor)
                cursor = self._space(cursor)
                if cursor >= self.length or self.text[cursor] != ":":
                    raise ValueError(f"Expected ':' at offset {cursor}")
                cursor = self._value(cursor + 1, parts + [key])
                cursor = self._space(cursor)
                if cursor < self.length and self.text[cursor] == "}":
                    return cursor + 1
                if cursor >= self.length or self.text[cursor] != ",":
                    raise ValueError(f"Expected ',' at offset {cursor}")
                cursor = self._space(cursor + 1)
        if char == "[":
            cursor = self._space(index + 1)
            if cursor < self.length and self.text[cursor] == "]":
                return cursor + 1
            item_index = 0
            while True:
                cursor = self._value(cursor, parts + [item_index])
                item_index += 1
                cursor = self._space(cursor)
                if cursor < self.length and self.text[cursor] == "]":
                    return cursor + 1
                if cursor >= self.length or self.text[cursor] != ",":
                    raise ValueError(f"Expected ',' at offset {cursor}")
                cursor = self._space(cursor + 1)
        cursor = index
        while cursor < self.length and self.text[cursor] not in ",]} \t\r\n":
            cursor += 1
        json.loads(self.text[index:cursor])
        return cursor


def replace_json_strings(
    text: str,
    replacements: dict[str, str],
    expected: dict[str, str] | None = None,
    encoded_replacements: dict[str, str] | None = None,
) -> str:
    """Replace only selected JSON string tokens, preserving all unrelated bytes."""

    spans = _JsonStringLocator(text).locate()
    edits = []
    for pointer, new_value in replacements.items():
        if pointer not in spans:
            raise KeyError(f"JSON Pointer not found: {pointer}")
        start, end, current = spans[pointer]
        if expected is not None and pointer in expected and current != expected[pointer]:
            raise ValueError(f"JSON Pointer value changed: {pointer}")
        edits.append(
            (
                start,
                end,
                (encoded_replacements or {}).get(pointer)
                or json.dumps(new_value, ensure_ascii=False),
            )
        )
    output = text
    for start, end, token in sorted(edits, reverse=True):
        output = output[:start] + token + output[end:]
    json.loads(output)
    return output


def json_string_token(text: str, json_pointer: str) -> str | None:
    """Return the original encoded JSON string token at a pointer."""

    spans = _JsonStringLocator(text).locate()
    span = spans.get(json_pointer)
    return text[span[0]:span[1]] if span else None


class _JsonValueLocator:
    def __init__(self, text: str):
        self.text = text
        self.length = len(text)
        self.spans = {}

    def locate(self):
        end = self._value(self._space(0), [])
        if self._space(end) != self.length:
            raise ValueError("Unexpected data after JSON value")
        return self.spans

    def _space(self, index):
        while index < self.length and self.text[index] in " \t\r\n":
            index += 1
        return index

    def _string_end(self, index):
        if index >= self.length or self.text[index] != '"':
            raise ValueError(f"Expected JSON string at offset {index}")
        escaped = False
        cursor = index + 1
        while cursor < self.length:
            char = self.text[cursor]
            if char == '"' and not escaped:
                return cursor + 1
            if char == "\\" and not escaped:
                escaped = True
            else:
                escaped = False
            cursor += 1
        raise ValueError("Unterminated JSON string")

    def _value(self, index, parts):
        start = self._space(index)
        if start >= self.length:
            raise ValueError("Unexpected end of JSON")
        char = self.text[start]
        if char == '"':
            end = self._string_end(start)
        elif char == "{":
            cursor = self._space(start + 1)
            if cursor < self.length and self.text[cursor] == "}":
                end = cursor + 1
            else:
                while True:
                    key_end = self._string_end(cursor)
                    key = json.loads(self.text[cursor:key_end])
                    cursor = self._space(key_end)
                    if cursor >= self.length or self.text[cursor] != ":":
                        raise ValueError(f"Expected ':' at offset {cursor}")
                    cursor = self._value(cursor + 1, [*parts, key])
                    cursor = self._space(cursor)
                    if cursor < self.length and self.text[cursor] == "}":
                        end = cursor + 1
                        break
                    if cursor >= self.length or self.text[cursor] != ",":
                        raise ValueError(f"Expected ',' at offset {cursor}")
                    cursor = self._space(cursor + 1)
        elif char == "[":
            cursor = self._space(start + 1)
            if cursor < self.length and self.text[cursor] == "]":
                end = cursor + 1
            else:
                item_index = 0
                while True:
                    cursor = self._value(cursor, [*parts, item_index])
                    item_index += 1
                    cursor = self._space(cursor)
                    if cursor < self.length and self.text[cursor] == "]":
                        end = cursor + 1
                        break
                    if cursor >= self.length or self.text[cursor] != ",":
                        raise ValueError(f"Expected ',' at offset {cursor}")
                    cursor = self._space(cursor + 1)
        else:
            end = start
            while end < self.length and self.text[end] not in ",]} \t\r\n":
                end += 1
            json.loads(self.text[start:end])
        pointer = json_pointer(parts)
        if pointer in self.spans:
            raise ValueError(f"Duplicate JSON value path: {pointer}")
        self.spans[pointer] = (start, end, json.loads(self.text[start:end]))
        return end


def replace_json_value(text: str, pointer: str, new_value, expected=None) -> str:
    """Replace one JSON value token while preserving every byte outside its span."""

    spans = _JsonValueLocator(text).locate()
    if pointer not in spans:
        raise KeyError(f"JSON Pointer not found: {pointer}")
    start, end, current = spans[pointer]
    if expected is not None and current != expected:
        raise ValueError(f"JSON Pointer value changed: {pointer}")
    token = json.dumps(new_value, ensure_ascii=False, indent=2)
    output = text[:start] + token + text[end:]
    json.loads(output)
    return output


def insert_json_array_item(text: str, pointer: str, index: int, item: dict, expected: list) -> str:
    """Insert one field token without serializing any existing array element."""

    spans = _JsonValueLocator(text).locate()
    if pointer not in spans:
        raise KeyError(f"JSON Pointer not found: {pointer}")
    start, end, current = spans[pointer]
    if not isinstance(current, list) or current != expected or not 0 <= index <= len(current):
        raise ValueError(f"JSON array changed or insertion index is invalid: {pointer}")
    if not isinstance(item, dict):
        raise ValueError("Inserted PAGE field must be an object")
    raw_array = text[start:end]
    newline = "\r\n" if "\r\n" in raw_array else "\n"
    pretty = "\n" in raw_array
    if current:
        item_spans = [spans[f"{pointer}/{number}"] for number in range(len(current))]
        first_start = item_spans[0][0]
        line_start = text.rfind("\n", start, first_start) + 1
        indent = text[line_start:first_start] if line_start > start else ""
        compact_gap = (text[item_spans[0][1]:item_spans[1][0]]
                       if len(item_spans) > 1 else ", ")
        separator = "," + newline + indent if pretty else (
            compact_gap if compact_gap.startswith(",") else ", "
        )
    else:
        item_spans = []
        closing_line = text.rfind("\n", start, end) + 1
        closing_indent = text[closing_line:end - 1] if closing_line > start else ""
        indent = closing_indent + "  " if pretty else ""
        separator = ""
    token = json.dumps(item, ensure_ascii=False, indent=2 if pretty else None,
                       separators=None if pretty else (",", ":"))
    if pretty:
        token = token.replace("\n", newline + indent)
    if not current:
        replacement = ("[" + newline + indent + token + newline + closing_indent + "]"
                       if pretty else "[" + token + "]")
        output = text[:start] + replacement + text[end:]
    elif index == len(current):
        position = item_spans[-1][1]
        output = text[:position] + separator + token + text[position:]
    else:
        position = item_spans[index][0]
        output = text[:position] + token + separator + text[position:]
    if pointer_value(json.loads(output), pointer) != [*current[:index], item, *current[index:]]:
        raise ValueError("PAGE field insertion did not produce the expected array")
    return output
