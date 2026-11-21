"""DATABASE MCP: project-scoped local index queries and operation history."""
from common.runtime_paths import runtime_home_context, workspace_root
from providers.api.mcp_server import ApiMcpServer, ApiError, W, PATH, _tool
from providers.api.mcp_server import serve_stdio as serve_protocol

LIMIT = {"type": "integer", "minimum": 1, "maximum": 50}
TOOLS = [
    _tool("find_sources", "Search the selected DATABASE workspace's local index.",
          {**W, "keyword": PATH, "limit": LIMIT}, ["workspaceKey", "keyword"]),
    _tool("get_source_context", "Read indexed context for a DATABASE source object.",
          {**W, "sourceId": PATH, "funId": PATH, "limit": LIMIT}, ["workspaceKey", "sourceId"]),
    _tool("list_sources", "List one DATABASE source category from the local index.",
          {**W, "sourceType": {"type":"string"}, "after":{"type":"integer","minimum":0}}, ["workspaceKey"]),
    _tool("read_source", "Read one indexed DATABASE readonly file by its catalog record ID.",
          {**W, "recordId":{"type":"integer","minimum":1}}, ["workspaceKey","recordId"]),
    _tool("get_source_history", "Read local synchronization records for the DATABASE workspace.",
          {**W, "limit": LIMIT}, ["workspaceKey"]),
]


class DatabaseMcpServer(ApiMcpServer):
    def __init__(self, home, version, *, enable_writes=False):
        super().__init__(home, version, enable_writes=False)
        self.tools = TOOLS

    def _call(self, name, args):
        from common import gusen_hub, legacy_workspace_assistant, legacy_source_read, pull_history
        with self._lock, runtime_home_context(self.home):
            workspace = gusen_hub.resolve_workspace(gusen_hub.load_config(), args["workspaceKey"])
            if workspace["sourceMode"] != "database":
                raise ApiError("DATABASE_SOURCE_MODE_REQUIRED", "请选择 DATABASE 工作区")
            limit = args.get("limit", 20)
            if name == "find_sources":
                return legacy_workspace_assistant.unified_search(workspace, args["keyword"], limit)
            if name == "get_source_context":
                return legacy_workspace_assistant.context_pack(workspace, args["sourceId"], args.get("funId", ""), limit)
            if name == "list_sources":
                return legacy_source_read.catalog(workspace, source_type=args.get("sourceType",""), after=args.get("after",0))
            if name == "read_source":
                return legacy_source_read.read(workspace, args["recordId"])
            return pull_history.query_history(workspace, workspace_root(self.home) / "nexus/bridge", limit=limit)


def serve_stdio(home, version, **options):
    return serve_protocol(home, version, server_class=DatabaseMcpServer, **options)
