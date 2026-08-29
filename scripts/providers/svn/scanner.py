"""Read-only scanner for configured Guthon SVN source objects."""

from __future__ import annotations

import json
import re
import xml.etree.ElementTree as ET
from pathlib import Path

from common.page_projection import extract_page_scripts
from common.source_format import decode_source
from providers.svn.checkout import file_hash, run_svn, svn_status


HEADER_FIELD = re.compile(r"(?m)^\s*\*\s*@(?P<key>[A-Za-z]+)\s+(?P<value>.*?)\s*$")
INDEX_LINK = re.compile(r"^(?P<indent>\s*)-\s+\[(?P<label>[^]]+)]\((?P<path>[^)]+)\)")
INDEX_MENU = re.compile(r"^(?P<indent>\s*)-\s+[^[]*?(?P<label>[^\s].*?)\s*$")


def _header_fields(text: str) -> dict[str, str]:
    return {match.group("key"): match.group("value").strip() for match in HEADER_FIELD.finditer(text[:8192])}


def _decode_json(text: str):
    data = json.loads(text)
    if isinstance(data, str):
        return json.loads(data), True
    return data, False


def _page_index(index_path: Path) -> dict[str, str]:
    try:
        lines = index_path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return {}
    output = {}
    menus = {}
    for line in lines:
        link = INDEX_LINK.match(line)
        if link:
            indent = len(link.group("indent"))
            label = re.sub(r"^[^\w\u4e00-\u9fff]+", "", link.group("label")).strip()
            parent = next((menus[key] for key in sorted(menus, reverse=True) if key < indent), "")
            output[link.group("path")] = f"{parent} / {label}" if parent and label in {"主页面", "子页面", "弹窗", "选窗", "服务组件", "元组件", "侧边框"} else label
            continue
        menu = INDEX_MENU.match(line)
        if menu and "[" not in line:
            indent = len(menu.group("indent"))
            label = re.sub(r"^[^\w\u4e00-\u9fff]+", "", menu.group("label")).strip()
            if label:
                menus = {key: value for key, value in menus.items() if key < indent}
                menus[indent] = label
    return output


def _revision_map(checkout_path: Path) -> dict[str, str]:
    result = run_svn(["info", "-R", "--xml", str(checkout_path)])
    root = ET.fromstring(result.stdout)
    output = {}
    for entry in root.findall("entry"):
        raw = Path(entry.get("path") or "")
        try:
            relative = raw.resolve().relative_to(checkout_path.resolve()).as_posix()
        except ValueError:
            continue
        output[relative] = entry.get("revision") or ""
    return output


def _status_map(status: dict) -> dict[str, str]:
    return {change["path"]: change["item"] or change["properties"] for change in status.get("changes") or []}


def _object_status(relative: str, status_map: dict, default="OK") -> str:
    value = status_map.get(relative)
    return "SVN_DIRTY" if value else default


def _base_object(path: Path, checkout_path: Path, source_table: str, revision_map: dict, status_map: dict) -> dict:
    relative = path.resolve().relative_to(checkout_path.resolve()).as_posix()
    digest = file_hash(path)
    revision = revision_map.get(relative, "")
    return {
        "provider": "svn",
        "source_table": source_table,
        "source_path": relative,
        "source_hash": digest,
        "svn_revision": revision,
        "change_key": f"svn:{revision}:{digest}",
        "status": _object_status(relative, status_map),
        "scripts": [],
    }


def _scan_page_json(path, checkout_path, system_id, data_source_id, names, revision_map, status_map):
    result = _base_object(path, checkout_path, "page", revision_map, status_map)
    relative_in_system = path.relative_to(checkout_path / "pages" / system_id).as_posix()
    try:
        raw = decode_source(path.read_bytes())[0]
        data, double_encoded = _decode_json(raw)
        if not isinstance(data, dict):
            raise ValueError("PAGE JSON root must be an object")
        page_id = str(data.get("pageId") or path.stem)
        if page_id != path.stem and not path.stem.startswith("SYS-"):
            result["status"] = "IDENTITY_MISMATCH"
        fields = extract_page_scripts(data)
        result.update(
            {
                "source_id": page_id,
                "source_alias_id": str(data.get("pageAliasId") or page_id),
                "fun_id": "",
                "source_name": names.get(relative_in_system, page_id),
                "system_id": system_id,
                "data_source_id": data_source_id,
                "double_encoded": double_encoded,
                "scripts": [
                    {
                        "script_type": field.key,
                        "json_path": field.json_pointer,
                        "content": field.effective_value,
                        "label": field.display_name,
                    }
                    for field in fields
                ],
            }
        )
    except Exception as error:
        result.update(
            {
                "source_id": path.stem,
                "source_alias_id": path.stem,
                "fun_id": "",
                "source_name": names.get(relative_in_system, path.stem),
                "system_id": system_id,
                "data_source_id": data_source_id,
                "status": "PARSE_ERROR",
                "error": str(error),
            }
        )
    return result


def _scan_page_gss(path, checkout_path, system_id, data_source_id, names, revision_map, status_map):
    result = _base_object(path, checkout_path, "page", revision_map, status_map)
    text = decode_source(path.read_bytes())[0]
    header = _header_fields(text)
    page_id = header.get("pageId") or path.stem
    alias = header.get("pageAliasId") or path.stem
    relative_in_system = path.relative_to(checkout_path / "pages" / system_id).as_posix()
    result.update(
        {
            "source_id": page_id,
            "source_alias_id": alias,
            "fun_id": "",
            "source_name": header.get("pageName") or names.get(relative_in_system, alias),
            "system_id": system_id,
            "data_source_id": data_source_id,
            "scripts": [{"script_type": "gss", "json_path": "", "content": text}],
        }
    )
    return result


def _scan_system_script(path, checkout_path, system_id, data_source_id, revision_map, status_map):
    result = _base_object(path, checkout_path, "system-script", revision_map, status_map)
    text = decode_source(path.read_bytes())[0]
    result.update(
        {
            "source_id": f"{system_id}#{path.stem}",
            "source_alias_id": system_id,
            "fun_id": path.stem,
            "source_name": path.name,
            "system_id": system_id,
            "data_source_id": data_source_id,
            "scripts": [{"script_type": "system_script", "json_path": "", "content": text}],
        }
    )
    return result


def _scan_metadata(path, checkout_path, kind, data_source_id, revision_map, status_map):
    result = _base_object(path, checkout_path, kind, revision_map, status_map)
    try:
        data = json.loads(decode_source(path.read_bytes())[0])
        id_key = "tableId" if kind == "table" else "viewId"
        name_key = "tableName" if kind == "table" else "viewName"
        source_id = str(data.get(id_key) or path.stem)
        if source_id != path.stem:
            result["status"] = "IDENTITY_MISMATCH"
        result.update(
            {
                "source_id": source_id,
                "source_alias_id": source_id,
                "fun_id": "",
                "source_name": str(data.get(name_key) or source_id),
                "system_id": "",
                "data_source_id": data_source_id,
                "scripts": (
                    [{"script_type": "view_sql", "json_path": "/viewSql", "content": data.get("viewSql") or ""}]
                    if kind == "view" and isinstance(data.get("viewSql"), str)
                    else []
                ),
            }
        )
    except Exception as error:
        result.update(
            {
                "source_id": path.stem,
                "source_alias_id": path.stem,
                "fun_id": "",
                "source_name": path.stem,
                "system_id": "",
                "data_source_id": data_source_id,
                "status": "PARSE_ERROR",
                "error": str(error),
            }
        )
    return result


def scan(checkout_path: Path, scope: dict) -> dict:
    """Scan only paths approved by checkout-scope.json; never update or write the checkout."""

    checkout_path = checkout_path.resolve()
    status = svn_status(checkout_path)
    revision_map = _revision_map(checkout_path)
    changes = _status_map(status)
    objects = []
    errors = []
    system_names = scope.get("systemNames") or {}
    data_sources_by_system = scope.get("dataSourceIdsBySystem") or {}
    resolved_data_sources = set((scope.get("systemNamesByDataSource") or {}).keys())

    if "pages" in scope.get("includes", []):
        for system_id in scope.get("systemIds") or []:
            root = checkout_path / "pages" / system_id
            data_source_id = ",".join(data_sources_by_system.get(system_id) or [])
            names = _page_index(root / "index.md")
            if not root.is_dir():
                errors.append({"path": f"pages/{system_id}", "error": "missing scoped directory"})
                continue
            for path in sorted(root.rglob("*")):
                if not path.is_file() or path.name == "index.md":
                    continue
                if path.suffix.lower() == ".json":
                    objects.append(_scan_page_json(path, checkout_path, system_id, data_source_id, names, revision_map, changes))
                elif path.suffix.lower() == ".gss":
                    objects.append(_scan_page_gss(path, checkout_path, system_id, data_source_id, names, revision_map, changes))

    if "procedures" in scope.get("includes", []):
        for data_source_id in scope.get("dataSourceIds") or []:
            root = checkout_path / "procedures" / data_source_id
            if not root.is_dir():
                errors.append({"path": f"procedures/{data_source_id}", "error": "missing scoped directory"})
                continue
            for path in sorted(root.rglob("*.gss")):
                relative = path.relative_to(root).with_suffix("")
                text = decode_source(path.read_bytes())[0]
                header = _header_fields(text)
                package = header.get("packageId") or ".".join(relative.parts[:-1])
                function_id = header.get("functionId") or relative.name
                result = _base_object(path, checkout_path, "procedure", revision_map, changes)
                result.update(
                    {
                        "source_id": f"{package}#{function_id}",
                        "source_alias_id": package,
                        "fun_id": function_id,
                        "source_name": header.get("description") or function_id,
                        "system_id": "",
                        "data_source_id": data_source_id,
                        "scripts": [{"script_type": "procedure_script", "json_path": "", "content": text}],
                    }
                )
                if function_id != relative.name:
                    result["status"] = "IDENTITY_MISMATCH"
                elif data_source_id not in resolved_data_sources:
                    result["status"] = "UNRESOLVED_DATA_SOURCE"
                objects.append(result)

    if "system-script" in scope.get("includes", []):
        for system_id in scope.get("systemIds") or []:
            root = checkout_path / "system-script" / system_id
            data_source_id = ",".join(data_sources_by_system.get(system_id) or [])
            if not root.is_dir():
                errors.append({"path": f"system-script/{system_id}", "error": "missing scoped directory"})
                continue
            for path in sorted(root.iterdir()):
                if path.is_file() and path.suffix.lower() in {".js", ".vm", ".sql"}:
                    objects.append(_scan_system_script(path, checkout_path, system_id, data_source_id, revision_map, changes))

    for include, kind in (("tables", "table"), ("views", "view")):
        if include not in scope.get("includes", []):
            continue
        for data_source_id in scope.get("dataSourceIds") or []:
            root = checkout_path / include / data_source_id
            if not root.is_dir():
                errors.append({"path": f"{include}/{data_source_id}", "error": "missing scoped directory"})
                continue
            for path in sorted(root.glob("*.json")):
                objects.append(_scan_metadata(path, checkout_path, kind, data_source_id, revision_map, changes))

    counts = {}
    identities = {}
    for item in objects:
        counts[item["source_table"]] = counts.get(item["source_table"], 0) + 1
        identity = (item["source_table"], item["source_id"], item.get("fun_id") or "")
        if identity in identities:
            item["status"] = "IDENTITY_AMBIGUOUS"
            identities[identity]["status"] = "IDENTITY_AMBIGUOUS"
            errors.append({
                "path": item["source_path"],
                "error": f"duplicate object identity also used by {identities[identity]['source_path']}",
            })
        else:
            identities[identity] = item
        if item.get("status") == "PARSE_ERROR":
            errors.append({"path": item["source_path"], "error": item.get("error") or "parse error"})
    return {
        "provider": "svn",
        "revision": status["revision"],
        "status": status,
        "objects": objects,
        "counts": counts,
        "errors": errors,
        "systemNames": system_names,
    }
