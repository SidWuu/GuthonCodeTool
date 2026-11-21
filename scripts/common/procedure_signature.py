"""Derive procedure signatures from explicit source and metadata."""

import json
import re

from common import inheritance as inheritance_algorithms


def procedure_signature(text, metadata, *, truncated=False):
    """Derive only explicit declarations and leading documentation from an index header."""
    name = r"\$?[A-Za-z_][A-Za-z0-9_]*"
    result = {"parameters": None, "hasReturn": None,
              "parameterSource": "unknown", "returnSource": "unknown"}
    if not isinstance(metadata, dict):
        metadata = {}

    header = re.match(r"\ufeff?\s*/\*\*(.*?)\*/", text, re.S)
    lines = [re.sub(r"^\s*\* ?", "", line).strip()
             for line in header.group(1).splitlines()] if header else []
    config = None
    config_tags = [i for i, line in enumerate(lines) if re.match(r"^@config(?:\s|$)", line)]
    config_invalid = len(config_tags) > 1
    if len(config_tags) == 1:
        i = config_tags[0]
        inline = re.sub(r"^@config\b", "", lines[i], count=1).strip()
        config_text = (inline + "\n" if inline.startswith("{") else "") + "\n".join(lines[i + 1:])
        def unique_pairs(pairs):
            value = {}
            for key, item in pairs:
                if key in value:
                    raise ValueError("duplicate configuration key")
                value[key] = item
            return value
        try:
            config, _ = json.JSONDecoder(object_pairs_hook=unique_pairs).raw_decode(config_text.lstrip())
            if not isinstance(config, dict):
                config_invalid = True
        except (ValueError, RecursionError):
            config_invalid = True
    if config_invalid:
        config = None

    declarations = []
    # The usual generated header is followed immediately by its one declaration.
    # Avoid masking the body in that case; any other marker requires the full scan.
    start = header.end() if header else (1 if text.startswith("\ufeff") else 0)
    leading = re.compile(r"\s*@DECLARE_PROCEDURE\s+(" + name + r")\s*\(([^()]*)\)(?=[ \t]*(?:\r?\n|$|\{))").match(text, start)
    if leading and text.count("@DECLARE_PROCEDURE") == 1 and leading.group(1) == metadata.get("funId"):
        raw = leading.group(2)
        parts = [part.strip() for part in raw.split(",")] if raw.strip() else []
        if all(re.fullmatch(name, part) for part in parts) and len(parts) == len(set(parts)):
            declarations.append(parts)
    if not declarations:
        # Markers and arguments must be actual top-level code, never comments or literals.
        masked = inheritance_algorithms.mask_noncode(text)
        if masked.startswith("\ufeff"):
            masked = " " + masked[1:]
        depth = 0
        position = 0
        marker = re.compile(r"^[ \t]*@DECLARE_PROCEDURE\s+(" + name + r")\b", re.M)
        for match in marker.finditer(masked):
            for char in masked[position:match.start()]:
                if char == "{":
                    depth += 1
                elif char == "}":
                    depth = max(0, depth - 1)
            position = match.start()
            if depth == 0 and isinstance(metadata.get("funId"), str) and match.group(1) == metadata["funId"]:
                tail = re.match(r"\s*\(([^()]*)\)(?=[ \t]*(?:\r?\n|$|\{))", masked[match.end():], re.S)
                if tail:
                    raw = text[match.end() + tail.start(1):match.end() + tail.end(1)]
                    parts = [part.strip() for part in raw.split(",")] if raw.strip() else []
                    declarations.append(parts if all(re.fullmatch(name, part) for part in parts)
                                        and len(parts) == len(set(parts)) else None)
                else:
                    declarations.append(None)
    if len(declarations) == 1 and declarations[0] is not None:
        result.update(parameters=declarations[0], parameterSource="declaration")
    elif not declarations and (header or not truncated) and not config_invalid:
        if config is not None and "params" in config:
            params = config["params"]
            if (isinstance(params, list)
                    and all(isinstance(item, dict) and isinstance(item.get("id"), str)
                            and re.fullmatch(name, item["id"]) for item in params)):
                names = [item["id"] for item in params]
                if len(names) == len(set(names)):
                    result.update(parameters=names, parameterSource="config")
        else:
            documented = []
            documented_empty = False
            in_params = False
            awaiting_name = False
            invalid = False
            for line in lines:
                tag = re.match(r"^@param(?:\s+(.*))?$", line)
                if tag:
                    in_params = True
                    rest = (tag.group(1) or "").strip()
                    awaiting_name = not rest
                    if rest == "无":
                        documented_empty = True
                    elif rest:
                        item = re.match(r"^(?:\{[^{}]+\}\s+)?(" + name + r")(?:\s|$|:|：)", rest)
                        if item:
                            documented.append(item.group(1))
                        else:
                            invalid = True
                elif line.startswith("@"):
                    in_params = False
                    awaiting_name = False
                elif in_params and line.startswith("-"):
                    item = re.match(r"^-\s*(" + name + r")\s*[:：]", line)
                    if item:
                        documented.append(item.group(1))
                        awaiting_name = False
                    else:
                        invalid = True
                elif in_params and awaiting_name and line:
                    if line == "无":
                        documented_empty = True
                        awaiting_name = False
                    else:
                        item = re.match(r"^(?:\{[^{}]+\}\s+(" + name + r")|(\$[A-Za-z_][A-Za-z0-9_]*))(?:\s|$|:|：)", line)
                        if item:
                            documented.append(item.group(1) or item.group(2))
                            awaiting_name = False
            if documented_empty and not documented and not invalid:
                result.update(parameters=[], parameterSource="documentation")
            elif documented and not documented_empty and not invalid and len(documented) == len(set(documented)):
                result.update(parameters=documented, parameterSource="documentation")

    def flag(value):
        if type(value) is bool:
            return value
        if type(value) is int and value in (0, 1):
            return bool(value)
        if isinstance(value, str) and value.lower() in ("0", "1", "false", "true"):
            return value.lower() in ("1", "true")
        return None

    if not config_invalid and config is not None and "isReturn" in config:
        value = flag(config["isReturn"])
        if value is not None:
            result.update(hasReturn=value, returnSource="config")
    elif not config_invalid and (header or not truncated):
        if "isReturn" in metadata:
            value = flag(metadata["isReturn"])
            if value is not None:
                result.update(hasReturn=value, returnSource="metadata")
        else:
            documented_returns = set()
            for line in lines:
                tag = re.match(r"^@returns?(?:\s+(.*))?$", line)
                if not tag or not (description := (tag.group(1) or "").strip()):
                    continue
                if re.match(r"^(?:\{void\}|void|无返回值)(?=$|[\s:：,，。;；])", description, re.I):
                    documented_returns.add(False)
                elif description.lower() not in {"无", "none", "null"} and re.search(r"\w", description):
                    documented_returns.add(True)
            if len(documented_returns) == 1:
                result.update(hasReturn=documented_returns.pop(), returnSource="documentation")
    return result
