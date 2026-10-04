"""Source-preserving inheritance projection for SVN procedure and PAGE scripts."""

from __future__ import annotations

import re


MARKER = re.compile(r"^[ \t]*(?P<return>return[ \t]+)?@?inherit\(\);[ \t]*$")
POSSIBLE_MARKER = re.compile(r"(?<![A-Za-z0-9_])@?inherit\s*\(")
SOURCE_CATALOG_VERSION = "svn-inheritance-v2"


def procedure_body(text: str) -> tuple[str, int]:
    """Remove only the generated leading documentation block from a parent GSS."""

    start = 1 if text.startswith("\ufeff") else 0
    if not text[start:].startswith("/**"):
        return text, 0
    end = text.find("*/", start + 3)
    if end < 0:
        return text, 0
    end += 2
    while end < len(text) and text[end] in "\r\n":
        end += 1
    return text[end:], end


def mask_noncode(content: str) -> str:
    """Preserve coordinates while masking comments, literals and template interpolation.

    Template expressions are deliberately opaque to the whole-line inheritance
    grammar. Nested templates must remain opaque too, never becoming edit targets.
    """
    masked = list(content)
    frames = [{"kind": "code"}]
    index = 0
    while index < len(content):
        frame = frames[-1]
        kind = frame["kind"]
        char = content[index]
        pair = content[index:index + 2]
        if kind != "code" and char not in "\r\n":
            masked[index] = " "
        if kind == "line":
            if char in "\r\n":
                frames.pop()
        elif kind == "block":
            if pair == "*/":
                masked[index:index + 2] = "  "
                index += 1
                frames.pop()
        elif kind in {"'", '\"', "`", "regex"}:
            if frame.get("escaped"):
                frame["escaped"] = False
            elif char == "\\":
                frame["escaped"] = True
            elif kind == "regex":
                if char == "[":
                    frame["characterClass"] = True
                elif char == "]":
                    frame["characterClass"] = False
                elif char == "/" and not frame.get("characterClass"):
                    frames.pop()
            elif kind == "`" and pair == "${":
                masked[index:index + 2] = "  "
                index += 1
                frames.append({"kind": "template-expression", "depth": 1})
            elif char == kind:
                frames.pop()
        elif pair in {"//", "##", "/*"}:
            frames.append({"kind": "block" if pair == "/*" else "line"})
            masked[index:index + 2] = "  "
            index += 1
        elif char in {"'", '\"', "`"}:
            frames.append({"kind": char})
            masked[index] = " "
        elif char == "/":
            prefix = content[max(0, index-80):index].rstrip()
            if (not prefix or prefix[-1] in "=([{,:;!&|?}"
                    or re.search(r"\b(?:return|case|throw)$", prefix)):
                frames.append({"kind": "regex"})
                masked[index] = " "
        elif kind == "template-expression":
            if char == "{":
                frame["depth"] += 1
            elif char == "}":
                frame["depth"] -= 1
                if frame["depth"] == 0:
                    frames.pop()
        index += 1
    return "".join(masked)


def _marker_spans(text: str) -> tuple[list[tuple[int, int, bool]], bool]:
    """Recognize only whole-line markers in code, excluding quoted/commented text."""
    spans = []
    uncertain = False
    position = 0
    for line, masked in zip(text.splitlines(keepends=True), mask_noncode(text).splitlines(keepends=True)):
        body = line.rstrip("\r\n")
        code = masked.rstrip("\r\n")
        match = MARKER.fullmatch(body) if MARKER.fullmatch(code) else None
        if match:
            # Include exactly the marker line, never adjacent comments.
            spans.append((position, position + len(body), bool(match.group("return"))))
        elif POSSIBLE_MARKER.search(code):
            uncertain = True
        position += len(line)
    return spans, uncertain


def project(project: str, product: str | None, *, product_offset: int = 0) -> dict:
    """Return a derived view and exact original offsets; never authorize a write."""

    markers, uncertain = _marker_spans(project)
    if not markers:
        return {"status": "UNRESOLVED" if uncertain else "INACTIVE",
                "effective": project, "segments": [{"layer": "project", "start": 0, "end": len(project),
                                                      "sourceStart": 0, "sourceEnd": len(project),
                                                      "sourceLine": 1, "effectiveLine": 1}],
                "materializable": False, "markers": 0}
    if uncertain or len(markers) != 1:
        return {"status": "AMBIGUOUS", "effective": None, "segments": [],
                "materializable": False, "markers": len(markers)}
    if product is None:
        return {"status": "MISSING_PRODUCT", "effective": None, "segments": [],
                "materializable": False, "markers": 1}
    start, end, returns = markers[0]
    product = product.rstrip("\r\n")
    before, after = project[:start], project[end:]
    effective = before + product + after
    segments = [
        {"layer": "project", "start": 0, "end": len(before), "sourceStart": 0, "sourceEnd": start},
        {"layer": "product", "start": len(before), "end": len(before) + len(product),
         "sourceStart": product_offset, "sourceEnd": product_offset + len(product)},
        {"layer": "project", "start": len(before) + len(product), "end": len(effective),
         "sourceStart": end, "sourceEnd": len(project)},
    ]
    for segment in segments:
        origin = product if segment["layer"] == "product" else project
        source_start = segment["sourceStart"] - (product_offset if segment["layer"] == "product" else 0)
        leading = len(effective[segment["start"]:segment["end"]]) - len(
            effective[segment["start"]:segment["end"]].lstrip("\r\n")
        )
        segment["sourceLine"] = origin.count("\n", 0, source_start + leading) + 1
        segment["effectiveLine"] = effective.count("\n", 0, segment["start"] + leading) + 1
    return {"status": "ACTIVE", "effective": effective, "segments": segments,
            "materializable": not returns, "markers": 1,
            "diagnostic": "return inherit requires control-flow review" if returns else ""}
