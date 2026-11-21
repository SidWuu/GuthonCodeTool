"""DATABASE MCP: project-scoped local index queries and operation history."""
from common.runtime_paths import runtime_home_context, workspace_root
from providers.api.mcp_server import ApiMcpServer, ApiError, W, PATH, _tool
from providers.api.mcp_server import serve_stdio as serve_protocol

LIMIT = {"type": "integer", "minimum": 1, "maximum": 50}
READ_BOUNDS = {"offset": {"type": "integer", "minimum": 0},
               "maxChars": {"type": "integer", "minimum": 1, "maximum": 50_000}}
IDENTITY = {**W, "recordId": {"type": "integer", "minimum": 1},
            "sourceId": PATH, "sourcePath": PATH, "pointer": PATH}
IDENTITY_FIELDS = ["workspaceKey", "recordId", "sourceId", "sourcePath"]
CANDIDATE = {**IDENTITY, "sourceHash": PATH, "content": {"type": "string", "maxLength": 500_000}}
CANDIDATE_FIELDS = [*IDENTITY_FIELDS, "sourceHash", "content"]
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
WORKCOPY_TOOLS = [
    _tool("read_workcopy", "Read a bounded slice of the exact Workcopy or its readonly baseline. Check sourceHash between pages.",
          {**IDENTITY, **READ_BOUNDS}, IDENTITY_FIELDS),
    _tool("preview_workcopy", "Preview local Workcopy content or a PAGE fragment. Returns candidateSourceHash without writing.",
          CANDIDATE, CANDIDATE_FIELDS),
    _tool("save_workcopy", "Save the exact previewed candidate against its original sourceHash. Writes only source/workcopy and independently reads back its hash.",
          {**CANDIDATE, "candidateSourceHash": PATH}, [*CANDIDATE_FIELDS, "candidateSourceHash"],
          write=True, destructive=True),
]
WORKCOPY_ACTIONS = {"read_workcopy": "edit-read", "preview_workcopy": "edit-preview", "save_workcopy": "edit-save"}


class DatabaseMcpServer(ApiMcpServer):
    def __init__(self, home, version, *, enable_writes=False):
        super().__init__(home, version, enable_writes=False)
        self.tools = TOOLS

    def _call(self, name, args):
        from common import gusen_hub, legacy_workspace_assistant, legacy_source_read, pull_history
        with self._lock, runtime_home_context(self.home):
            config = gusen_hub.load_config()
            workspace = gusen_hub.resolve_workspace(config, args["workspaceKey"])
            if workspace["sourceMode"] != "database":
                raise ApiError("DATABASE_SOURCE_MODE_REQUIRED", "请选择 DATABASE 工作区")
            if name in WORKCOPY_ACTIONS:
                from common.database_workcopy_edit import run

                if not workspace["capabilities"].get("workcopy.open"):
                    raise ApiError("DATABASE_WORKCOPY_UNAVAILABLE", "当前工作区未开放 Workcopy 编辑")
                result = run(workspace, config, WORKCOPY_ACTIONS[name], args,
                             include_write_artifacts=name == "save_workcopy")
                if name == "read_workcopy":
                    content = result["content"]
                    offset = args.get("offset", 0)
                    end = offset + args.get("maxChars", 12_000)
                    more = end < len(content)
                    return {**result, "content": content[offset:end], "offset": offset,
                            "nextOffset": end if more else None, "totalChars": len(content),
                            "complete": not more, "truncated": more}
                if name == "save_workcopy":
                    changed = result["sourceHash"] != args["sourceHash"]
                    current = run(workspace, config, "edit-read", args)
                    if current["sourceHash"] != result["sourceHash"] or changed and not current["workcopy"]:
                        raise ApiError("DATABASE_WORKCOPY_READBACK_MISMATCH", "Workcopy 回读不匹配，请核对磁盘")
                    return {**result, "changed": changed, "matchesAfter": True}
                return result
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
