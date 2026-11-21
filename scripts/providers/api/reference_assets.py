"""Read-only platform references derived from registered official project files."""
from __future__ import annotations

import json
import re
from .client import ApiError
from .store import ApiStore
from .module_parameters import DIRECTORY_PATH, DIRECTORY_TYPE, directory_entries

CONFIGS = {
    DIRECTORY_PATH: (DIRECTORY_TYPE, []),
    "otherconfig/bill-type.md": ("bill-type", ["dataSourceId", "billTypeCode", "name", "tables", "fields"]),
    "otherconfig/dropdown.md": ("dropdown", ["compId", "cacheTableId", "codeFieldName", "disFieldName", "permission", "description"]),
}


def page_references(value, pointer=""):
    result = []
    if isinstance(value, dict):
        for key, child in value.items():
            location = pointer + "/" + key.replace("~", "~0").replace("/", "~1")
            if key in {"selectCompId", "billTypeCode"} and isinstance(child, str) and child:
                result.append(("dropdown" if key == "selectCompId" else "bill-type", child, location))
            result.extend(page_references(child, location))
    elif isinstance(value, list):
        for position, child in enumerate(value):
            result.extend(page_references(child, pointer + "/" + str(position)))
    return result


def config_objects(path, text, data_sources, system_ids=None):
    """Keep original line coordinates; associated fields are never assumed to be PKs."""
    if path == DIRECTORY_PATH:
        return [{"sourceType": "module-parameter", "sourceId": entry["configId"],
                 "name": entry.get("configName") or entry["configId"], "dataSourceId": entry["dataSourceId"],
                 "lineNumber": 0, "referenceId": json.dumps([entry["systemId"], entry["configId"]]), "fields": entry}
                for entry in directory_entries(text) if system_ids is None or entry["systemId"] in system_ids]
    if path not in CONFIGS:
        return []
    kind, keys = CONFIGS[path]
    result, identities, header = [], set(), False
    for line_no, line in enumerate(text.splitlines(), 1):
        if not line.lstrip().startswith("|"):
            continue
        cells = [x.strip().replace(r"\|", "|").strip("`") for x in re.split(r"(?<!\\)\|", line.strip())[1:-1]]
        if not header:
            if len(cells) != len(keys) or not all(key in cell for key, cell in zip(keys[:2] if kind == "bill-type" else keys[:4], cells)):
                raise ApiError("API_REFERENCE_FORMAT_INVALID", f"{path}:{line_no} 配置表头不匹配")
            header = True
            continue
        if all(re.fullmatch(r":?-+:?", x) for x in cells):
            continue
        if len(cells) != len(keys):
            raise ApiError("API_REFERENCE_FORMAT_INVALID", f"{path}:{line_no} 配置列数不匹配")
        fields = dict(zip(keys, cells))
        if kind == "bill-type" and fields["dataSourceId"] not in data_sources:
            continue
        identifier = fields["billTypeCode" if kind == "bill-type" else "compId"]
        identity = (fields.get("dataSourceId", ""), identifier)
        if not identifier or identity in identities:
            raise ApiError("API_REFERENCE_IDENTITY_INVALID", f"{path}:{line_no} 配置身份为空或重复")
        identities.add(identity)
        result.append({"sourceType": kind, "sourceId": identifier,
                       "name": fields.get("name") or fields.get("description") or identifier,
                       "dataSourceId": fields.get("dataSourceId", ""), "lineNumber": line_no,
                       "referenceId": json.dumps(identity, ensure_ascii=False), "fields": fields})
    if not header:
        raise ApiError("API_REFERENCE_FORMAT_INVALID", f"{path} 缺少配置表头")
    return result


def read_reference(workspace, payload):
    """One source for Nexus and MCP; upstream text is data, never executable rules."""
    kind, selector = payload.get("kind", "overview"), payload.get("selector", "")
    if kind not in {"overview", "api", "schema", "events", "rules"} or not isinstance(selector, str) or len(selector) > 160:
        raise ApiError("API_INPUT_INVALID", "无效的平台参考类别或选择器")
    store = ApiStore(workspace)
    registered = set(store.paths())
    root = "skills/platform-kit/"
    def read(relative):
        path = root + relative
        if path not in registered:
            raise ApiError("API_REFERENCE_UNAVAILABLE", "当前项目尚无参考资料：" + relative)
        item = store.read(path)
        if not item["readonly"] or item["metadata"].get("sourceType") != "skill":
            raise ApiError("API_REFERENCE_IDENTITY_INVALID", "参考资料必须来自已登记的官方只读文件")
        return item

    if kind == "api":
        items, sources = [], []
        for path in sorted(registered):
            match = re.fullmatch(root + r"apis/(javascript|guthonscript)/([\w-]+)\.md", path)
            if not match or selector and selector not in {match[1], match[1] + "/" + match[2]}:
                continue
            source = read(path[len(root):]); text = source["content"]
            sources.append({"path": path, "sourceHash": source["sourceHash"]})
            for found in re.finditer(r"^## `([^`\n]+)`[^\n]*\n([\s\S]*?)(?=^## |\Z)", text, re.M):
                signature, documentation = found.groups()
                call = re.match(r"([\w$.]+)\((.*)\)(?::.*)?$", signature)
                if not call:
                    continue
                prefix = call[1]
                if match[1] == "javascript" and "." not in prefix:
                    owner = {"vm": "$vm", "gutil": "gUtil", "self": "self", "tab-page": "tabPage", "input-box": "inputForm", "table-box": "mainTable", "tree-box": "treeBox", "html-box": "htmlBox", "report-box": "reportBox"}.get(match[2])
                    if not owner:
                        continue
                    prefix = owner + "." + prefix
                arguments = [re.sub(r"[:=].*", "", x).strip().lstrip("$") for x in call[2].split(",") if x.strip()]
                items.append({"prefix": prefix, "aliases": [prefix], "apiPath": prefix, "signature": signature,
                              "body": prefix + "(" + ",".join(arguments) + ")", "language": "javascript" if match[1] == "javascript" else "java",
                              "completionKind": "function", "description": documentation.strip().splitlines()[0] if documentation.strip() else signature,
                              "officialDocumentation": documentation.strip(), "referencePath": path,
                              "lineNumber": text[:found.start()].count("\n") + 1})
        limit,offset=payload.get("limit",50),payload.get("offset",0)
        if type(limit) is not int or not 1<=limit<=1000 or type(offset) is not int or offset<0:
            raise ApiError("API_INPUT_INVALID", "参考资料分页参数无效")
        more=offset+limit<len(items)
        return {"workspaceKey": workspace["workspaceKey"], "items": items[offset:offset+limit], "sources": sources,
                "nextOffset":offset+limit if more else None,"complete":not more,"readonly": True}
    if kind in {"schema", "events"}:
        if selector and not re.fullmatch(r"[\w-]+", selector):
            raise ApiError("API_INPUT_INVALID", "请选择明确的结构或事件分组")
        relative = "apis/page-schema/" + ("events/" if kind == "events" else "") + (selector or "index") + ".json"
        if kind == "events" and selector:
            directory = json.loads(read("apis/page-schema/events/index.json")["content"])
            group = directory.get("groups", {}).get(selector)
            if not group:
                raise ApiError("API_REFERENCE_UNAVAILABLE", "参考资料未收录此事件组")
            relative = "apis/page-schema/events/" + group.get("readFile", selector + ".json")
        item = read(relative)
        return {"workspaceKey": workspace["workspaceKey"], "path": item["path"], "sourceHash": item["sourceHash"],
                "data": json.loads(item["content"]), "coverage": "DOCUMENTED_ONLY", "readonly": True}
    if kind == "rules":
        item = read("rules/00-AI必读规则.md")
        return {"workspaceKey": workspace["workspaceKey"], "path": item["path"], "sourceHash": item["sourceHash"],
                "content": item["content"], "warnings": ["上游规则仅供参考；.gs 路径等工程约定不覆盖当前项目规则。"], "readonly": True}
    paths = sorted(p for p in registered if p.startswith(root))
    warnings = []
    for relative in ("rules/03-过程函数语法规则.md", "knowledge/api/README.md", "tools/generate_gushen_docs.js"):
        if root + relative not in registered:
            warnings.append("上游说明引用的文件未下发：" + relative)
    return {"workspaceKey": workspace["workspaceKey"], "paths": paths, "warnings": warnings,
            "capabilities": {"api": any("/apis/guthonscript/" in p or "/apis/javascript/" in p for p in paths),
                             "schema": root + "apis/page-schema/index.json" in registered,
                             "events": root + "apis/page-schema/events/index.json" in registered}, "readonly": True}


def enrich_page_model(workspace, model):
    """Annotations aid editing, without changing the proven write contract."""
    registered = set(ApiStore(workspace).paths())
    available = "skills/platform-kit/apis/page-schema/field.json" in registered
    if not available:
        return model
    try:
        for kind, selector in (("FIELDS", "field"), ("BUTTONS", "button")):
            response = read_reference(workspace, {"kind": "schema", "selector": selector})
            properties = {}
            def visit(value):
                if isinstance(value, dict):
                    for name, definition in value.get("properties", {}).items():
                        if isinstance(definition, dict) and definition.get("description"):
                            properties.setdefault(name, definition["description"])
                    for child in value.values():
                        visit(child)
                elif isinstance(value, list):
                    for child in value:
                        visit(child)
            visit(response["data"])
            for collection in model["collections"]:
                if (collection["kind"] == "BUTTONS") != (kind == "BUTTONS"):
                    continue
                for field in collection["fields"]:
                    for prop in field["properties"]:
                        if prop["name"] in properties:
                            prop["description"] = properties[prop["name"]]
                            prop["referencePath"] = response["path"]
        model["referenceWarnings"] = ["属性说明来自当前项目平台资料；未收录的类型和事件不作为保存错误。"]
    except (ApiError, json.JSONDecodeError) as error:
        model["referenceWarnings"] = ["平台属性参考不可用，原编辑能力保留：" + str(error)]
    return model


def sync_references(workspace, client, paths=None):
    """Adopt matching local references; never overwrite a different local file."""
    from .download import project_files
    from .store import digest
    from dataclasses import replace
    from .workspace import settings
    from .index import update
    from common.persistence import file_lock

    if not settings(workspace)["includeProjectFiles"]:
        raise ApiError("API_SCOPE_REQUIRED", "请先在项目设置中启用官方参考资料")
    requested = None
    kinds = None
    if paths is not None:
        if not isinstance(paths, list) or not paths or any(not isinstance(path, str) for path in paths):
            raise ApiError("API_INPUT_INVALID", "请选择一个或多个精确参考资料路径")
        from .download import source_file
        for path in paths:
            source_file(path, "", "reference", {})
            if not path.startswith(("skills/", "otherconfig/")) or path == DIRECTORY_PATH:
                raise ApiError("API_INPUT_INVALID", "请选择官方参考资料的物理路径")
        requested = set(paths)
        kinds = {"skill" if path.startswith("skills/") else "config" for path in requested}
    client.ensure_login()
    store = ApiStore(workspace)
    files, preserved = [], []
    with file_lock(store.directory / "sync.lock"):
        upstream = project_files(client, kinds)
        if requested is not None:
            missing = requested - {item.path for item in upstream}
            if missing:
                raise ApiError("API_SOURCE_NOT_FOUND", "平台未返回所选参考资料：" + ", ".join(sorted(missing)))
        for item in upstream:
            if not item.path.startswith(("skills/", "otherconfig/")) or (requested is not None and item.path not in requested):
                continue
            target = store._path(item.path)
            if target.is_file():
                local = target.read_bytes()
                if local != item.content.encode("utf-8"):
                    preserved.append(item.path)
                    item = replace(item, content=local.decode("utf-8"), metadata={**item.metadata,
                        "preservedLocalReference": True, "upstreamHash": digest(item.content),
                        "untrackedConflict": True})
            files.append(item)
        result = store.publish(files)
        result["index"] = update(workspace, [item.path for item in files])
    return {**result, "registeredReferences": len(files), "downloadedFiles": len(files), "downloadComplete": result["complete"], "preservedLocalReferences": preserved,
            "complete": result["complete"] and result["index"]["complete"] and not preserved,
            "businessSourceDownloaded": False, "platformWrites": 0}
