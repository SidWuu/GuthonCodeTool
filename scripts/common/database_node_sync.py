"""Refresh the exact DATABASE category, directory, or indexed object selected in Nexus."""
from contextlib import closing, nullcontext
import json
from pathlib import Path
from tempfile import TemporaryDirectory

from common import database_source_exports as exports, legacy_source as hub
from common.persistence import atomic_bytes, atomic_text


def sync(workspace, config, payload, progress):
    if not isinstance(payload, dict):
        raise ValueError("需要明确的 DATABASE 源码节点")
    kind = payload.get("sourceType")
    groups = payload.get("groups", [])
    record_id, export_key = payload.get("recordId"), payload.get("exportKey")
    if (kind not in {"page","procedure",*exports.TYPES} or not isinstance(groups,list)
            or any(not isinstance(part,str) or not part or part in {".",".."} or "/" in part or "\\" in part for part in groups)):
        raise ValueError("无效的 DATABASE 源码节点")
    datasource_name, datasource = hub.resolve_datasource(config, workspace=workspace)
    if kind in {"page","procedure"}:
        return _sync_sources(workspace,config,kind,groups,record_id,datasource_name,datasource,progress)
    return _sync_exports(workspace,config,kind,groups,export_key,datasource_name,datasource,progress)


def _sync_sources(workspace,config,kind,groups,record_id,datasource_name,datasource,progress):
    from common.legacy_source_read import _record

    tables = config["source_tables"]
    rules = config["sync"].get("rules") or {}
    root = workspace["readonlyDir"]
    field = "system_id" if kind=="page" else "data_source_id"
    with hub.index_connection(workspace,action="database-source-node-refresh",readonly=False) as conn:
        exact = None
        if record_id is not None:
            row = conn.execute("""SELECT * FROM gusen_source_record WHERE provider='database'
                AND scope_id=? AND source_table=? AND record_id=?""",(workspace["scopeId"],kind,record_id)).fetchone()
            if row is None or not (exact := _record(workspace,row)):
                raise ValueError("源码已移出当前工作区索引")
        folder = root.joinpath(*(groups[:1]+[kind]+groups[1:])) if groups else root
        match_folder = folder.resolve()
        if not match_folder.is_relative_to(root.resolve()) or (groups and not match_folder.is_dir()):
            raise ValueError("当前目录不属于工作区 readonly")
        progress(f"读取 DATABASE {kind} 节点")
        with hub.db_connect(datasource) as remote, hub.source_transaction(conn,workspace):
            scope = hub.resolve_system_scope(remote,config,datasource_name,workspace)
            scoped_ids = scope.get(f"{field}s", [])
            if not scoped_ids:
                raise ValueError("当前工作区没有可用的同步范围")
            prefix = exact["groups"][0] if exact and exact["groups"] else groups[0] if groups else ""
            names = scope.get("system_name_by_id" if kind=="page" else "system_name_by_data_source_id", {})
            ids = [key for key in scoped_ids if not prefix or hub.path_part(names.get(key) or key)==prefix]
            if not ids:
                raise ValueError("源码目录与已授权子系统或数据源不一致")
            with remote.cursor() as cursor:
                if exact:
                    sql,params = hub.single_source_sql(tables,kind,exact,rules)
                else:
                    builder = hub.page_sql if kind=="page" else hub.proc_sql
                    sql,bindings = hub._scoped_sql(builder(tables,rules),{f"{field}s":ids},
                                                   "system" if kind=="page" else "data_source",tables)
                    params = ["1970-01-01 00:00:00"]*2 + bindings
                cursor.execute(sql,params)
                rows = cursor.fetchall()
            model_paths = hub.load_model_paths(remote,tables) if kind=="page" else {}
            matched = changed = 0
            for row in rows:
                if str(row.get(field) or "") not in ids or not hub._included(workspace["config"],row):
                    continue
                if kind=="page":
                    row["model_path"] = model_paths.get(hub._str(row.get("model_id")))
                if not exact and not hub.source_base(row,workspace["layer"],workspace["scopeId"],workspace["projectId"],
                                                     workspace["config"],scope,workspace).resolve().is_relative_to(match_folder):
                    continue
                matched += 1
                changed += bool(hub.upsert_source(conn,row,workspace["layer"],workspace["scopeId"],workspace["projectId"],
                    workspace["config"],scope,workspace=workspace))
            if exact and not matched:
                raise ValueError("当前源码已不在可同步范围")
    progress(f"节点源码已更新 · 核对 {matched} 项，变更 {changed} 项")
    return {"matched":matched,"changed":changed}


def sync_verified_procedure(workspace, config, identity, *, base_version, database_version, content,
                            advance_workcopy=False, readback_datasource=None):
    """Refresh one mirror using independently established database-version evidence.

    An isolated verifier can supply a connection resolved by its trusted caller.
    The local operation remains bound to its original workspace configuration.
    """
    if (workspace["sourceMode"] != "database" or identity["workspaceKey"] != workspace["workspaceKey"]
            or identity["source_table"] != "procedure" or not database_version):
        raise ValueError("过程函数回拉身份或源库回读版本无效")
    if identity.get("workspaceBinding", workspace["workspaceBinding"]) != workspace["workspaceBinding"]:
        raise ValueError("发布以后项目来源或数据源配置发生变化")
    fields = ("source_id", "source_alias_id", "fun_id", "data_source_id")
    source_id, alias, fun_id, datasource_id = (identity[key] for key in fields)
    query = {"sourceId": source_id, "alias": alias, "funId": fun_id, "dataSourceId": datasource_id}
    rules = config["sync"].get("rules") or {}
    sql, params = hub.single_source_sql(config["source_tables"], "procedure", query, rules,
                                        verified_procedure_version=database_version)
    name, datasource = readback_datasource or hub.resolve_datasource(config, workspace=workspace)
    index_sql = """SELECT * FROM gusen_source_record
        WHERE provider='database' AND source_table='procedure' AND source_layer=? AND scope_id=?
          AND project_id=? AND source_id=? AND fun_id=?"""
    index_params = (workspace["layer"], workspace["scopeId"], workspace["projectId"], source_id, fun_id)
    context = workspace["contextDir"]
    with hub.file_lock(context / ".source-write.lock"), hub.index_connection(
            workspace, action="database-publish-readback", readonly=False) as conn:
        with hub.db_connect(datasource) as remote, hub.source_transaction(conn, workspace):
            indexed = conn.execute(index_sql, index_params).fetchone()
            if indexed is None or any(indexed[key] != identity[key] for key in fields):
                raise ValueError("已核验的过程函数不再属于本地索引")
            if indexed["version_mac"] not in {base_version, database_version}:
                return {"verified": False, "reason": "MIRROR_VERSION_CHANGED"}
            with remote.cursor() as cursor:
                cursor.execute("SET TRANSACTION READ ONLY")
            scope = hub.resolve_system_scope(remote, config, name, workspace)
            if datasource_id not in scope["data_source_ids"]:
                raise ValueError("已核验的过程函数不再属于授权数据源")
            with remote.cursor() as cursor:
                cursor.execute(sql, params)
                rows = cursor.fetchall()
            if not rows:
                return {"verified": False}
            if len(rows) != 1:
                raise ValueError("已核验的过程函数在源库中匹配多条记录")
            row, = rows
            if (any(row[key] != identity[key] for key in fields)
                    or (workspace["config"].get("include") and not hub._included(workspace["config"], row))
                    or any(identity.get(key, workspace[name]) != workspace[name] for key, name in (
                        ("source_layer", "layer"), ("scope_id", "scopeId"), ("project_id", "projectId")))):
                raise ValueError("数据库回读身份或范围不一致")
            script = row["source_content"] or ""
            if row["version_mac"] != database_version or script.replace("\r\n", "\n") != content.replace("\r\n", "\n"):
                return {"verified": False}
            if hub._resolve_inherited_script(script, row.get("product_source_content") or "") != script:
                raise ValueError("不能以继承展开的内容作为发布回拉结果")
            # This operation refreshes the indexed file. Layout changes and
            # shared procedure directory links belong to the regular sync.
            exact_scope = {**scope, "system_link_names_by_data_source_id": {}}
            target = hub.source_base(row, workspace["layer"], workspace["scopeId"], workspace["projectId"],
                                     workspace["config"], exact_scope, workspace)
            if not indexed["local_path"] or (hub.ROOT / indexed["local_path"]).resolve() != target.resolve():
                return {"verified": False, "reason": "MIRROR_PATH_CHANGED"}
            # Procedure rows are scoped by data source. The exact SQL does not
            # return a system ID, so preserve the indexed value for this object.
            row = {**row, "system_id": indexed["system_id"]}
            hub.upsert_source(conn, row, workspace["layer"], workspace["scopeId"], workspace["projectId"],
                              workspace["config"], exact_scope, force=True, workspace=workspace, preserve_record_id=True)
        if advance_workcopy:
            from common.database_source_publish import advance_workcopy_baseline

            with hub.file_lock(context / ".workcopy.lock"):
                indexed = conn.execute(index_sql, index_params).fetchone()
                state = advance_workcopy_baseline(workspace, indexed, base_version=base_version)
            return {"verified": True, "workcopyState": state}
    return {"verified": True}


def _sync_exports(workspace,config,kind,groups,export_key,datasource_name,datasource,progress):
    from providers.database import export_system_script_sql as scripts, export_table_schema_sql as tables, export_view_sql as views
    from common.database_exports import export_bill_type_sql as bills
    from common.database_exports._export_common import bill_type_export_lock, legacy_bill_type_dir

    root = exports._roots(workspace)[kind]
    filter_ids = set()
    code = ""
    if groups or export_key:
        with hub.index_connection(workspace,action="database-export-node") as conn:
            if not exports.available(conn):
                raise ValueError("请先重建本地导出对象索引")
            rows = conn.execute(f"SELECT {exports.OBJECT_COLUMNS} FROM database_source_export WHERE source_type=? AND "+
                                ("export_key=?" if export_key else "folder=?"),(kind,export_key or groups[0])).fetchall()
        if not rows or (groups and len(groups)!=1):
            raise ValueError("导出对象已移出当前工作区索引")
        if export_key:
            code = rows[0]["source_id"]
        for row in rows:
            relative = Path(row["local_path"])
            path = exports._file(workspace,kind,relative)
            if not path:
                continue
            if kind=="system-script":
                metadata = path.with_name("meta.json")
                if metadata.resolve() != metadata:
                    raise ValueError("系统脚本元数据路径无效")
                key = json.loads(exports._text(metadata)).get("systemId","")
            elif kind=="bill-type":
                key = json.loads(exports._text(path)).get("dataSourceId","")
            else:
                from common.database_exports._export_common import sanitize_name
                keys=[str(value["data_source_id"]) for value in workspace["systemMappings"].values()
                      if value.get("data_source_id") and relative.parts[0].startswith(sanitize_name(value["data_source_id"])+"_")]
                key = max(keys,key=len,default="") or relative.parts[0].split("_",1)[0]
            if key:
                filter_ids.add(str(key))
        if not filter_ids:
            raise ValueError("导出节点缺少可核验的系统或数据源编码")

    progress(f"读取 DATABASE {kind} 导出节点")
    with TemporaryDirectory(prefix="guthon-db-node-") as temporary, hub.db_connect(datasource) as remote:
        stage=Path(temporary)
        scope=hub.resolve_system_scope(remote,config,datasource_name,workspace)
        ids=set(scope.get("system_ids" if kind=="system-script" else "data_source_ids",[]))
        if not ids or filter_ids-ids:
            raise ValueError("导出节点超出当前同步范围")
        selected=sorted(filter_ids or ids)
        selected_codes=[code] if code else None
        if kind=="bill-type":
            if root.resolve() != root:
                raise ValueError("导出路径超出对应目录")
            result = bills.export_bill_types(remote, root, selected, selected_codes,
                                             legacy_dir=legacy_bill_type_dir(workspace), generated=False)
            changed = result["exported_data_source_count"]
        elif kind=="table":
            tables.export_table_schema(remote,stage,selected,selected_codes)
        elif kind=="view":
            views.export_views(remote,stage,selected,selected_codes,config=config)
        elif kind=="system-script":
            scripts.export_system_scripts(remote,output_dir=stage,system_ids=selected,
                                          data_source_ids=scope["data_source_ids"],script_types=selected_codes,config=config)
        if kind != "bill-type":
            changed = 0
            for path in stage.rglob("*"):
                if not path.is_file() or path.name in {"table_metadata.json", "export_summary.json"}:
                    continue
                target = root / path.relative_to(stage)
                if target.resolve() != target or not target.is_relative_to(root):
                    raise ValueError("导出路径超出对应目录")
                atomic_bytes(target,path.read_bytes())
                changed += 1
        if kind=="table" and (stage/"table_metadata.json").is_file():
            target=root/"table_metadata.json"
            if target.resolve()!=target:
                raise ValueError("表结构元数据路径无效")
            fresh=json.loads((stage/"table_metadata.json").read_text(encoding="utf-8"))
            old=json.loads(target.read_text(encoding="utf-8")) if target.is_file() else []
            retained=[row for row in old if str(row.get("DATA_SOURCE_ID")) not in selected
                      or code and row.get("TABLE_ID")!=code]
            combined=sorted([*retained,*fresh],key=lambda row:(str(row.get("DATA_SOURCE_ID") or ""),
                            str(row.get("TABLE_NAME") or ""),str(row.get("TABLE_ID") or "")))
            atomic_text(target,json.dumps(combined,ensure_ascii=False,indent=2)+"\n")
        if code and not changed:
            raise ValueError("当前导出对象已不在可同步范围")
    export_lock = bill_type_export_lock(root) if kind == "bill-type" else nullcontext()
    with export_lock, closing(hub.connect_index_for_workspace(workspace, action="database-export-index")) as conn, conn:
        diagnostics=exports.rebuild(conn,workspace)
        if kind=="bill-type":
            from common import source_facts
            source_facts.replace_workspace_bill_routes(conn, [json.loads(exports._text(path))
                for path in exports.bill_type_files(workspace)])
    progress(f"节点资料已更新 · {changed} 个文件 · {len(diagnostics)} 项本地索引诊断")
    return {"changed":changed,"diagnostics":diagnostics[:20]}
