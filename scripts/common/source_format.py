"""Lossless text-format handling for SVN source projections."""

from __future__ import annotations

from pathlib import Path


_BOMS = (
    (b"\xef\xbb\xbf", "utf-8"),
    (b"\xff\xfe", "utf-16-le"),
    (b"\xfe\xff", "utf-16-be"),
)


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


def encode_source(text: str, format_info: dict) -> bytes:
    newline = format_info.get("newline") or "\n"
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    if format_info.get("trailingNewline"):
        normalized = normalized.rstrip("\n") + ("\n" if normalized else "")
    else:
        normalized = normalized.rstrip("\n")
    if newline != "\n":
        normalized = normalized.replace("\n", newline)
    encoding = format_info.get("encoding") or "utf-8"
    try:
        prefix = bytes.fromhex(str(format_info.get("bom") or ""))
    except ValueError as error:
        raise ValueError("Invalid source BOM metadata") from error
    return prefix + normalized.encode(encoding)


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
