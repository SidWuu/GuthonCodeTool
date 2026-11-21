"""Read and save bounded source scopes in the existing DATABASE and SVN contracts."""
from pathlib import PurePosixPath
from urllib.parse import quote, unquote
from xml.etree import ElementTree

from common.command_errors import CommandError
from common.svn_scope import SUPPORTED_CATEGORIES


def svn_scope_paths(svn):
    entries = svn.get("scopeEntries")
    if entries is None:
        return ["."] if svn.get("scopeRootUrl") else []
    return [entry.get("localSubdir", "") if isinstance(entry, dict) else entry for entry in entries]


def _database_systems(workspace, selected=None):
    from common.legacy_source import read_database_systems

    if not workspace["datasource"]:
        raise ValueError("请先在当前项目卡片登录谷神主数据数据库")
    systems = {}
    for row in read_database_systems(workspace, selected):
        alias, system, datasource = row["SYSTEM_ALIAS_ID"], row["SYSTEM_ID"], row["DATA_SOURCE_ID"]
        if not (alias and system and datasource):
            continue
        item = {"id": alias, "system_id": system, "data_source_id": datasource,
                "label": row["SYSTEM_NAME"] or alias}
        previous = systems.get(alias)
        if previous and (previous["system_id"], previous["data_source_id"]) != (system, datasource):
            raise CommandError("DATABASE_SCOPE_AMBIGUOUS", f"子系统别名 {alias} 对应多个来源，请核对主数据")
        systems[alias] = item
    return systems


def _svn_directories(workspace, *, include_names=False):
    from providers.svn.checkout import run_remote_svn

    svn = workspace["svn"]
    root = svn["scopeRootUrl"]
    if svn["checkoutLayout"] != "manifest-working-copies":
        raise ValueError("请通过旧 SVN 工作副本配置管理此项目的签出范围")
    if not root:
        raise ValueError("请先在当前项目卡片填写 SVN 仓库地址并登录")

    def list_children(paths):
        # Batch shallow listings. Do not descend into source trees or fetch index bodies.
        result = {}
        for start in range(0, len(paths), 64):
            targets = {path: root if path == "." else f"{root}/{quote(path, safe='/')}" for path in paths[start:start + 64]}
            response = run_remote_svn(["list", "--xml", *targets.values()], svn)
            try:
                listings = ElementTree.fromstring(response.stdout).findall("./list")
            except ElementTree.ParseError as error:
                raise ValueError("SVN 返回的目录列表无效") from error
            by_url = {unquote(item.get("path", "").rstrip("/")): item for item in listings}
            for path, url in targets.items():
                listing = by_url.get(unquote(url.rstrip("/")))
                if listing is None:
                    raise ValueError(f"SVN 没有返回目录列表：{path}")
                result[path] = sorted({name for entry in listing.findall("./entry[@kind='dir']")
                                       if (name := entry.findtext("name")) and not name.startswith(".")
                                       and "/" not in name and "\\" not in name
                                       and all(ord(char) >= 32 and ord(char) != 127 for char in name)})
        return result

    top = [path for path in list_children(["."])["."] if path in SUPPORTED_CATEGORIES and path != "root"]
    children = list_children([path for path in top if path in {"systems", "datasources"}])
    paths = [".", *top, *(f"{parent}/{child}" for parent, entries in children.items() for child in entries)]
    if not include_names:
        return paths
    names = {}
    for path, entries in list_children([path for path in paths if "/" in path]).items():
        titles = {entry[2:].strip() for entry in entries if entry.startswith("$.") and entry[2:].strip()}
        if len(titles) == 1:
            names[path] = titles.pop()
    return paths, names


def _svn_options(workspace):
    from providers.svn.group_inference import match_datasource_name

    paths, names = _svn_directories(workspace, include_names=True)
    datasource_names = {path.split("/")[1]: names.get(path, "") for path in paths if path.startswith("datasources/")}
    configured = {}
    for mapping in workspace["systemMappings"].values():
        system_id = str(mapping.get("system_id") or "")
        data_source_id = str(mapping.get("data_source_id") or "")
        if system_id and data_source_id:
            configured.setdefault(system_id, set()).add(data_source_id)

    groups = {key: [f"datasources/{key}"] for key in datasource_names}
    for path in paths:
        if not path.startswith("systems/"):
            continue
        identifier = path.split("/")[1]
        mapped = configured.get(identifier)
        inferred = match_datasource_name(names.get(path, ""), datasource_names) if not mapped else None
        for key in (sorted(mapped & datasource_names.keys()) if mapped else [inferred[0]] if inferred else []):
            groups[key].append(path)
    result = [
        {"id": group[0], "label": "贸易系统" if name in {"贸易", "国内贸易", "国际贸易"} else name or f"数据源 {key}",
         "description": key, "paths": group}
        for key, group in groups.items() for name in [datasource_names[key]]
    ]
    if not result:
        result.append({"id": ".", "label": "整个授权仓库", "paths": ["."]})
    for path, name in (("public", "公共源码"), ("skill", "开发建议")):
        if path in paths:
            result.append({"id": path, "label": name, "paths": [path]})
    return result


def options(workspace):
    if workspace["sourceMode"] == "database":
        systems = _database_systems(workspace)
        return [{"id": alias, "label": system["label"], "description": alias}
                for alias, system in sorted(systems.items())]
    return _svn_options(workspace)


def save(workspace, item, selected, *, grouped=False):
    if not isinstance(selected, list) or not selected or any(
        not isinstance(value, str) or not value or value != value.strip() for value in selected
    ):
        raise ValueError("至少选择一个有效的同步目标")
    selected = list(dict.fromkeys(selected))
    if workspace["sourceMode"] == "database":
        previous = workspace["systemMappings"]
        if set(previous) == set(selected):
            return False
        if (not previous or set(previous) - set(selected)) and (
            workspace["indexPath"].is_file()
            or any(any(path.is_file() for path in root["path"].rglob("*")) for root in workspace["sourceRoots"])
        ):
            raise CommandError("DATABASE_SCOPE_ALREADY_BOUND", "现有源码已建立，同步范围只能扩展；缩小范围需先迁移现有源码")
        found = _database_systems(workspace, selected)
        if set(selected) - found.keys():
            raise CommandError("DATABASE_SCOPE_STALE", "选择的子系统已不在主数据中，请重新选择")
        mappings = {}
        for alias in selected:
            system = found[alias]
            mappings[alias] = {**previous.get(alias, {}),
                               "system_id": system["system_id"], "data_source_id": system["data_source_id"]}
        item.setdefault("systems", {}).setdefault("include", {})["mappings"] = mappings
        item.setdefault("include", {"all": True})
        return True

    svn = workspace["svn"]
    if grouped:
        groups = {option["id"]: option["paths"] for option in _svn_options(workspace)}
        if set(selected) - groups.keys():
            raise CommandError("SVN_SCOPE_STALE", "数据源组合已变化，请重新打开同步范围")
        selected = list(dict.fromkeys(path for key in selected for path in groups[key]))
    if set(svn_scope_paths(svn)) == set(selected):
        return False
    if "." in selected and len(selected) != 1:
        raise ValueError("请选择整个仓库，或选择具体目录")
    if (svn["scopeManifestPath"] and svn["scopeManifestPath"].is_file()
        or svn.get("scopeConfigExplicit")
        or any((root["path"] / ".svn").is_dir() for root in workspace["sourceRoots"])):
        raise CommandError("SVN_SCOPE_ALREADY_BOUND", "已有 SVN 授权清单或工作副本，请通过范围迁移流程调整")
    if not grouped and set(selected) - set(_svn_directories(workspace)):
        raise CommandError("SVN_SCOPE_STALE", "目录已不在当前可读范围，请重新选择")
    values = item.setdefault("svn", {})
    if selected == ["."]:
        values.pop("scope", None)
        values.pop("entries", None)
    else:
        from providers.svn.scope_import import WRITABLE_CATEGORIES, build_manifest_from_config
        import json

        entries = []
        for path in selected:
            category = PurePosixPath(path).parts[0]
            entries.append({"url": f"{svn['scopeRootUrl']}/{quote(path, safe='/')}", "localSubdir": path,
                            "category": category, "writable": category in WRITABLE_CATEGORIES})
        result = build_manifest_from_config(json.dumps({"entries": entries}), workspace["workspaceKey"])
        values["scope"] = result.manifest["entries"]
    return True
