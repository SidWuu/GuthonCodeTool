"""Read-only exports use the same explicitly selected current-project API scope."""

from common import gusen_hub
from providers.api.workspace import active_scope
from ._export_common import normalize_values as normalize_data_source_ids


def resolve_data_source_ids(conn, datasource_name, requested=None):
    workspace = gusen_hub.resolve_workspace(gusen_hub.load_config())
    allowed = active_scope(workspace)["dataSourceIds"]
    requested = normalize_data_source_ids(requested)
    if set(requested) - allowed:
        raise ValueError("导出数据源不在当前API项目范围内")
    selected = requested or sorted(allowed)
    if not selected:
        raise ValueError("请先配置当前项目的子系统与共享数据源")
    return selected
