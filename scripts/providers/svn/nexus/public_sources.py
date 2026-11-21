"""Read-only tree projections for the repository's public reference JSON."""

import json
from pathlib import PurePosixPath

REFERENCE_TYPES = {
    "bill-types.json": ("bill-type", "billTypeCode", "billTypeName"),
    "module-comps.json": ("dropdown", "compId", "description"),
}


def reference_type(source_type, source_path):
    if source_type == "public":
        reference = REFERENCE_TYPES.get(PurePosixPath(source_path).name.casefold())
        if reference:
            return reference[0]
    return ""


def reference_fragments(path, text):
    _, id_key, name_key = REFERENCE_TYPES[path.name.casefold()]
    value = json.loads(text)
    entries = value.get("comps") if isinstance(value, dict) else None
    if not isinstance(entries, list):
        return []
    return [
        {"script_type": "json", "json_path": f"/comps/{index}",
         "label": str(item.get(name_key) or item.get(id_key) or index + 1),
         "source_code": str(item.get(id_key) or ""),
         "data_source_id": str(item.get("dataSourceId") or ""),
         "content": json.dumps(item, ensure_ascii=False, indent=2)}
        for index, item in enumerate(entries) if isinstance(item, dict)
    ]
