"""Read-only exports use the explicitly selected project scope."""

from common import gusen_hub
from providers.api.workspace import active_scope
from ._export_common import normalize_values as normalize_data_source_ids


def resolve_data_source_ids(conn, datasource_name, requested=None):
    workspace = gusen_hub.resolve_workspace(gusen_hub.load_config())
    if workspace["sourceMode"] == "database":
        from common import legacy_source
        allowed = set(legacy_source.resolve_system_scope(conn, gusen_hub.load_config(), datasource_name, workspace)["data_source_ids"])
    elif workspace["sourceMode"] == "api":
        allowed = active_scope(workspace)["dataSourceIds"]
    else:
        raise ValueError("SVN 工作区不执行数据库源码导出")
    requested = normalize_data_source_ids(requested)
    if set(requested) - allowed:
        raise ValueError("导出数据源不在当前项目范围内")
    selected = requested or sorted(allowed)
    if not selected:
        raise ValueError("请先配置当前项目的子系统与共享数据源")
    return selected
