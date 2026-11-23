"""Browser-session transport for platform PAGE operations."""

import http.client
import json
import re
import time
from urllib.parse import urlencode

from common.runtime_paths import workspace_root


PAGE_ACTIONS = {"create": "新建整张 PAGE", "copy": "复制整张 PAGE", "delete": "删除整张 PAGE"}
PAIR_TAB = "请在 Chrome 的 GuthonBridge 扩展中完成配对，打开并登录当前工作区的谷神页签。"


class BridgeSessionError(ValueError):
    def __init__(self, code, operation, next_action):
        super().__init__(f"“{operation}”需要浏览器会话。{next_action}")
        self.code = code
        self.next_action = next_action

    def unknown_receipt(self):
        return {"state": "UNKNOWN", "code": self.code,
                "message": f"{self} 恢复连接后核对原操作，勿重新派发。"}


class BridgePageSession:
    def __init__(self, home, workspace_key, port, operation):
        if type(port) is not int or not 1 <= port <= 65535:
            raise ValueError("Invalid local Bridge port")
        self.home = home
        self.workspace_key = workspace_key
        self.port = port
        self.operation = operation

    def _request(self, path, body=None):
        token_path = workspace_root(self.home) / "nexus/bridge/token"
        try:
            token = token_path.read_text(encoding="utf-8").strip()
        except FileNotFoundError as error:
            raise BridgeSessionError("BRIDGE_PAIRING_REQUIRED", self.operation,
                                     "请在 Nexus 启动浏览器增强。" + PAIR_TAB) from error
        except (OSError, UnicodeError) as error:
            raise BridgeSessionError("BRIDGE_UNAVAILABLE", self.operation,
                                     "无法读取 Bridge 令牌，请检查 Nexus 浏览器增强服务。") from error
        if not re.fullmatch(r"[a-f0-9]{64}", token):
            raise BridgeSessionError("BRIDGE_PAIRING_REQUIRED", self.operation,
                                     "请在 Nexus 重新启动浏览器增强。" + PAIR_TAB)

        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            headers = {"Authorization": "Bearer " + token, "Content-Type": "application/json"}
            connection.request("POST" if body is not None else "GET", path,
                               body=json.dumps(body).encode() if body is not None else None, headers=headers)
            response = connection.getresponse()
            if response.status == 401:
                raise BridgeSessionError("BRIDGE_PAIRING_REQUIRED", self.operation,
                                         "Bridge 未接受当前工作区的令牌，请在 Nexus 核对服务和连接端口。" + PAIR_TAB)
            raw = response.read(131073)
        except (OSError, http.client.HTTPException) as error:
            raise BridgeSessionError("BRIDGE_UNAVAILABLE", self.operation,
                                     "无法连接 Bridge，请在 Nexus 检查浏览器增强服务和连接端口。") from error
        finally:
            connection.close()
        if len(raw) > 131072:
            raise ValueError("Bridge response exceeds PAGE lifecycle budget")
        data = json.loads(raw)
        if not isinstance(data, dict):
            raise ValueError("Invalid Bridge PAGE lifecycle response")
        if response.status not in {200, 202} or not data.get("ok"):
            raise ValueError(str(data.get("message") or "Bridge rejected PAGE lifecycle request")[:512])
        return data

    def context(self, context_id):
        params = urlencode({"workspaceKey": self.workspace_key})
        result = self._request("/pageContext?" + params)
        contexts = [item for item in result.get("contexts", []) if item.get("workspaceKey") == self.workspace_key]
        if not contexts:
            raise BridgeSessionError("BRIDGE_CONTEXT_REQUIRED", self.operation,
                                     "未找到当前工作区的谷神页签。请核对 Chrome 扩展已配对，打开并登录该页签。")
        if not context_id and len(contexts) > 1:
            return {"workspaceKey": self.workspace_key, "contexts": contexts, "selectionRequired": True}
        selected = [item for item in contexts if not context_id or item.get("contextId") == context_id]
        if len(selected) != 1:
            raise BridgeSessionError("BRIDGE_CONTEXT_REQUIRED", self.operation,
                                     "原谷神页签已不可用，请检查当前工作区的平台页签与原操作记录。")
        return selected[0]

    def dispatch(self, context_id, target):
        return self._request("/pageLifecycle", {
            "workspaceKey": self.workspace_key, "contextId": context_id, "target": target,
        })["requestId"]

    def receipt(self, request_id, wait_seconds=20):
        deadline = time.monotonic() + wait_seconds
        params = urlencode({"workspaceKey": self.workspace_key, "requestId": request_id})
        while True:
            result = self._request("/navigationResult?" + params)
            if result["state"] != "PENDING":
                if result["state"] != "SUCCEEDED" or not isinstance(result.get("data"), dict):
                    return {"state": "UNKNOWN", "message": result.get("message") or "Platform receipt unavailable; do not replay"}
                return result["data"]
            if time.monotonic() >= deadline:
                return {"state": "PENDING", "message": "Wait for the original receipt; do not replay"}
            time.sleep(0.2)
