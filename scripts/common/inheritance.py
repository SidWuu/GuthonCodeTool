"""Source-preserving inheritance projection for SVN procedure and PAGE scripts."""

from __future__ import annotations

import re


MARKER = re.compile(r"^[ \t]*(?P<return>return[ \t]+)?@?inherit\(\);[ \t]*$")
POSSIBLE_MARKER = re.compile(r"(?<![A-Za-z0-9_])@?inherit\s*\(")
SOURCE_CATALOG_VERSION = "svn-inheritance-v1"


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


def _marker_spans(text: str) -> tuple[list[tuple[int, int, bool]], bool]:
    """Find whole-line calls outside comments and quoted strings."""

    spans = []
    uncertain = False
    state = "code"
    position = 0
    for line in text.splitlines(keepends=True):
        body = line.rstrip("\r\n")
        match = MARKER.fullmatch(body) if state == "code" else None
        if match:
            spans.append((position, position + len(body), bool(match.group("return"))))
        elif POSSIBLE_MARKER.search(body) and state == "code" and not body.lstrip().startswith(("//", "*")):
            uncertain = True
        index = 0
        while index < len(line):
            char = line[index]
            pair = line[index:index + 2]
            if state == "code":
                if pair == "//":
                    break
                if pair == "/*":
                    state = "block"
                    index += 2
                    continue
                if char in "'\"`":
                    state = char
            elif state == "block":
                if pair == "*/":
                    state = "code"
                    index += 2
                    continue
            elif char == "\\":
                index += 2
                continue
            elif char == state:
                state = "code"
            index += 1
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
