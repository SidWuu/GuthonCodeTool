"""Stable PAGE script projection and minimal JSON string replacement."""

from __future__ import annotations

import hashlib
import json
import re
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
INHERIT_MARKER = re.compile(r"(?m)^[ \t]*(?:return[ \t]+)?@?inherit\(\);[ \t]*\r?$")


@dataclass(frozen=True)
class ScriptField:
    json_pointer: str
    key: str
    script_type: str
    projection_name: str
    original_value: str
    effective_value: str

    def to_dict(self):
        result = asdict(self)
        result["original_hash"] = text_hash(self.original_value)
        result["effective_hash"] = text_hash(self.effective_value)
        return result


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


def is_script_key(key) -> bool:
    return key != "superScript" and (key in SCRIPT_KEYS or str(key).endswith("Script"))


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


def extract_page_scripts(value) -> list[ScriptField]:
    """Return every explicit script string with a stable pointer and readable unique filename."""

    fields = []

    def walk(current, parts, display_path, inherited_scripts=None, event_type=None):
        if isinstance(current, dict):
            label = str(current.get("aliasName") or current.get("name") or current.get("id") or "")
            next_display = display_path + ([label] if label else [])
            for key, child in current.items():
                child_parts = parts + [key]
                if is_script_key(key) and isinstance(child, str):
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
                    )
        elif isinstance(current, list):
            for index, child in enumerate(current):
                walk(child, parts + [index], display_path, inherited_scripts, event_type)

    walk(value, [], [])
    return fields


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


def replace_json_strings(text: str, replacements: dict[str, str], expected: dict[str, str] | None = None) -> str:
    """Replace only selected JSON string tokens, preserving all unrelated bytes."""

    spans = _JsonStringLocator(text).locate()
    edits = []
    for pointer, new_value in replacements.items():
        if pointer not in spans:
            raise KeyError(f"JSON Pointer not found: {pointer}")
        start, end, current = spans[pointer]
        if expected is not None and pointer in expected and current != expected[pointer]:
            raise ValueError(f"JSON Pointer value changed: {pointer}")
        edits.append((start, end, json.dumps(new_value, ensure_ascii=False)))
    output = text
    for start, end, token in sorted(edits, reverse=True):
        output = output[:start] + token + output[end:]
    json.loads(output)
    return output
