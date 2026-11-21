"""Byte-span XML parsing and source-preserving text leaf edits."""

from __future__ import annotations
from dataclasses import dataclass, field
import re
from xml.parsers import expat
from xml.sax.saxutils import escape


@dataclass
class XmlNode:
    tag: str
    attrs: dict
    start: int
    open_end: int
    self_closing: bool
    children: list = field(default_factory=list)
    text: list = field(default_factory=list)
    close_start: int = 0
    end: int = 0


def _tag_end(raw, start):
    quote = 0
    for pos in range(start, len(raw)):
        char = raw[pos]
        if quote:
            if char == quote:
                quote = 0
        elif char in (34, 39):
            quote = char
        elif char == 62:
            return pos + 1
    raise ValueError("Unterminated XML tag")


def parse(text):
    if not isinstance(text, str):
        raise ValueError("XML must be text")
    declaration = re.match(r"^\ufeff?\s*<\?xml\s+([^?]*)\?>", text, re.I)
    if declaration:
        encoding = re.search(
            r'\bencoding\s*=\s*(["\'])([^"\']+)\1', declaration.group(1), re.I
        )
        if encoding and encoding.group(2).lower().replace("-", "") != "utf8":
            raise ValueError("XML encoding must match UTF-8 source bytes")
    raw = text.encode("utf-8")
    parser = expat.ParserCreate()
    stack = []
    root = None

    def start(tag, attrs):
        nonlocal root
        pos = parser.CurrentByteIndex
        end = _tag_end(raw, pos)
        node = XmlNode(tag, attrs, pos, end, raw[pos:end].rstrip().endswith(b"/>"))
        if stack:
            stack[-1].children.append(node)
        elif root is None:
            root = node
        else:
            raise ValueError("XML has multiple roots")
        stack.append(node)

    def end(tag):
        node = stack.pop()
        if node.tag != tag:
            raise ValueError("XML element mismatch")
        if node.self_closing:
            node.close_start = node.end = node.open_end
        else:
            node.close_start = parser.CurrentByteIndex
            node.end = _tag_end(raw, node.close_start)

    def chars(value):
        if stack:
            stack[-1].text.append(value)

    def forbidden(*_args):
        raise ValueError("XML DTD and external entities are unsupported")

    parser.StartElementHandler = start
    parser.EndElementHandler = end
    parser.CharacterDataHandler = chars
    parser.StartDoctypeDeclHandler = forbidden
    parser.ExternalEntityRefHandler = forbidden
    try:
        parser.Parse(raw, True)
    except expat.ExpatError as error:
        raise ValueError("Invalid XML") from error
    if root is None:
        raise ValueError("XML root is missing")
    return raw, root



def opening(raw, node):
    """Return the original opening token, expanded if it was self-closing."""
    return re.sub(rb"/\s*>$", b">", raw[node.start:node.open_end])


def leaf_text(node):
    if node.children:
        raise ValueError("XML text target must be an existing leaf")
    return "".join(node.text)


def render_text_leaf(raw, node, text, *, opening_token=None, preserve_comments=False):
    """Render a changed leaf, keeping its tag and optionally its embedded comments."""
    if not isinstance(text, str):
        raise ValueError("XML leaf value must be a string")
    leaf_text(node)
    token = opening(raw, node) if opening_token is None else opening_token
    inner = raw[node.open_end:node.close_start] if not node.self_closing else b""
    if not preserve_comments and (b"<!--" in inner or b"<?" in inner):
        raise ValueError("Cannot replace XML scalar containing comments or processing instructions")
    cdata = b"<![CDATA[" in inner
    encoded = (("<![CDATA[" + text.replace("]]>", "]]]]><![CDATA[>") + "]]>").encode("utf-8")
               if cdata else escape(text).encode("utf-8"))
    if preserve_comments and (b"<!--" in inner or b"<?" in inner):
        pattern = re.compile(rb"<!\[CDATA\[.*?\]\]>|<!--.*?-->|<\?.*?\?>", re.S)
        pieces, cursor, inserted = [], 0, False
        for match in pattern.finditer(inner):
            if match.start() > cursor and not inserted:
                pieces.append(encoded); inserted = True
            marker = match.group()
            if marker.startswith(b"<![CDATA["):
                if not inserted:
                    pieces.append(encoded); inserted = True
            else:
                pieces.append(marker)
            cursor = match.end()
        if not inserted:
            pieces.append(encoded)
        inner = b"".join(pieces)
    else:
        inner = encoded
    return token + inner + ("</" + node.tag + ">").encode("utf-8")
