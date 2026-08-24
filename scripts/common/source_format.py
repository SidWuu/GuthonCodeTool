"""Lossless text-format handling for SVN source projections."""

from __future__ import annotations

from pathlib import Path


_BOMS = (
    (b"\xef\xbb\xbf", "utf-8"),
    (b"\xff\xfe", "utf-16-le"),
    (b"\xfe\xff", "utf-16-be"),
)

GENERATED_HEADER_MARKER = "--$$$--end-line--$$$--"


def decode_source(data: bytes) -> tuple[str, dict]:
    prefix = b""
    encoding = ""
    for candidate, candidate_encoding in _BOMS:
        if data.startswith(candidate):
            prefix = candidate
            encoding = candidate_encoding
            break
    payload = data[len(prefix):]
    if encoding:
        text = payload.decode(encoding)
    else:
        for candidate in ("utf-8", "gb18030"):
            try:
                text = data.decode(candidate)
                encoding = candidate
                break
            except UnicodeDecodeError:
                continue
        else:
            raise UnicodeDecodeError("utf-8/gb18030", data, 0, len(data), "unsupported SVN source encoding")
    newline = "\r\n" if "\r\n" in text else "\r" if "\r" in text else "\n"
    return text, {
        "encoding": encoding,
        "bom": prefix.hex(),
        "newline": newline,
        "trailingNewline": text.endswith(("\n", "\r")),
    }


def normalize_source_text(text: str, format_info: dict) -> str:
    newline = format_info.get("newline") or "\n"
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    if format_info.get("trailingNewline"):
        normalized = normalized.rstrip("\n") + ("\n" if normalized else "")
    else:
        normalized = normalized.rstrip("\n")
    if newline != "\n":
        normalized = normalized.replace("\n", newline)
    return normalized


def encode_source(text: str, format_info: dict) -> bytes:
    normalized = normalize_source_text(text, format_info)
    encoding = format_info.get("encoding") or "utf-8"
    try:
        prefix = bytes.fromhex(str(format_info.get("bom") or ""))
    except ValueError as error:
        raise ValueError("Invalid source BOM metadata") from error
    return prefix + normalized.encode(encoding)


def _generated_header_parts(text: str) -> tuple[str, str] | None:
    marker_at = text.find(GENERATED_HEADER_MARKER)
    if marker_at < 0:
        return None
    comment_end = text.find("*/", marker_at + len(GENERATED_HEADER_MARKER))
    if comment_end < 0:
        return None
    boundary = comment_end + 2
    if text.startswith("\r\n", boundary):
        boundary += 2
    elif text.startswith(("\r", "\n"), boundary):
        boundary += 1
    return text[:boundary], text[boundary:]


def _dominant_newline(text: str, fallback: str) -> str:
    crlf_count = text.count("\r\n")
    remainder = text.replace("\r\n", "")
    counts = [(crlf_count, "\r\n"), (remainder.count("\n"), "\n"), (remainder.count("\r"), "\r")]
    count, newline = max(counts, key=lambda item: item[0])
    return newline if count else fallback


def merge_preserving_generated_header(source_text: str, edited_text: str, format_info: dict) -> str | None:
    """Merge a whole-file edit while retaining an immutable generated header and mixed newline layout."""

    source_parts = _generated_header_parts(source_text)
    if source_parts is None:
        return None
    edited_parts = _generated_header_parts(edited_text)
    if edited_parts is None:
        raise ValueError("The generated Guthon identity header must not be edited")
    source_header, source_body = source_parts
    edited_header, edited_body = edited_parts
    canonical = lambda value: value.replace("\r\n", "\n").replace("\r", "\n")
    if canonical(source_header) != canonical(edited_header):
        raise ValueError("The generated Guthon identity header must not be edited")
    body_format = {
        **format_info,
        "bom": "",
        "newline": _dominant_newline(source_body, format_info.get("newline") or "\n"),
        "trailingNewline": source_body.endswith(("\n", "\r")),
    }
    return source_header + normalize_source_text(edited_body, body_format)


def encode_source_exact(text: str, format_info: dict) -> bytes:
    """Encode without normalizing untouched text, for PAGE token replacement."""

    encoding = format_info.get("encoding") or "utf-8"
    try:
        prefix = bytes.fromhex(str(format_info.get("bom") or ""))
    except ValueError as error:
        raise ValueError("Invalid source BOM metadata") from error
    return prefix + text.encode(encoding)


def read_projection(path: Path) -> str:
    with path.open("r", encoding="utf-8", newline="") as handle:
        return handle.read()
