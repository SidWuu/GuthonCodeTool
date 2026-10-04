"""Shared value normalization, JSON output and exact export provenance."""

import json
import re
from pathlib import Path

from common import gusen_hub
from common.persistence import atomic_text, file_lock


def normalize_values(value):
    if not value:
        return []
    if isinstance(value, str):
        value = value.split(",")
    return [str(item).strip() for item in value if str(item).strip()]


def sanitize_name(value):
    if value is None or str(value).strip() == "":
        return "空"
    text = re.sub(r'[\\/:*?"<>|]+', "_", str(value)).strip()
    text = re.sub(r"\s+", "_", text)
    return text[:120] or "空"


def drop_empty(value):
    if isinstance(value, list):
        return [drop_empty(item) for item in value]
    if isinstance(value, dict):
        return {key: drop_empty(item) for key, item in value.items() if item not in (None, "")}
    return value


def write_json(path, value, *, generated=True):
    path = Path(path)
    text = json.dumps(value, ensure_ascii=False, indent=2)
    if path.is_file() and path.read_bytes() == text.encode('utf-8'):
        return False
    atomic_text(path, text)
    if generated:
        gusen_hub.record_generated_files([path])
    return True


def write_source(path, source):
    path = Path(path)
    if path.is_file() and path.read_bytes() == source.encode('utf-8'):
        return False
    atomic_text(path, source)
    gusen_hub.record_generated_files([path])
    return True


def append_summary(path, summary, limit=100):
    path = Path(path)
    with file_lock(path.with_name('.export-summary.lock')):
        summaries = json.loads(path.read_text(encoding="utf-8")) if path.exists() else []
        if not isinstance(summaries, list):
            raise ValueError("export_summary.json 必须是数组")
        write_json(path, [*summaries, summary][-limit:], generated=False)
