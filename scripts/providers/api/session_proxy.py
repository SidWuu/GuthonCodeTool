"""Delegate MCP online actions to the owning Nexus session, without credentials."""
import hashlib
import http.client
import json
from pathlib import Path
from urllib.parse import urlsplit
from .client import ApiError


def descriptor_path(home, workspace_key):
    name = 'session-' + hashlib.sha256(workspace_key.encode()).hexdigest() + '.json'
    return Path(home) / 'var' / 'nexus' / 'mcp' / name


def execute(home, workspace_key, action, payload):
    path = descriptor_path(home, workspace_key)
    try:
        descriptor = json.loads(path.read_text(encoding='utf-8'))
    except FileNotFoundError as error:
        raise ApiError('API_MCP_SESSION_REQUIRED', '请打开对应项目的 Nexus 窗口并登录，再执行 MCP 在线操作') from error
    except (ValueError, OSError) as error:
        raise ApiError('API_MCP_SESSION_INVALID', 'MCP 会话登记无法读取，请刷新对应 Nexus 项目') from error
    url = urlsplit(descriptor.get('url', ''))
    if (descriptor.get('schemaVersion') != 1 or descriptor.get('workspaceKey') != workspace_key
            or url.scheme != 'http' or url.hostname != '127.0.0.1' or not url.port
            or url.path != '/mcp-api' or url.username or url.password or url.query or url.fragment
            or not isinstance(descriptor.get('token'), str) or len(descriptor['token']) != 64):
        raise ApiError('API_MCP_SESSION_INVALID', 'MCP 会话身份或地址无效，请刷新对应 Nexus 项目')
    connection = http.client.HTTPConnection('127.0.0.1', url.port, timeout=120)
    try:
        connection.request('POST', '/mcp-api', json.dumps({'workspaceKey': workspace_key, 'action': action, 'input': payload}),
                           {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + descriptor['token']})
        response = connection.getresponse()
        raw = response.read(2_097_153)
        if len(raw) > 2_097_152:
            raise ApiError('API_MCP_RESULT_TOO_LARGE', '在线结果过大，请缩小范围；请求未重放')
        result = json.loads(raw)
        if 'error' in result:
            raise ApiError(result['error'].get('code', 'API_MCP_SESSION_FAILED'), result['error'].get('message', 'MCP 在线操作失败'))
        if response.status != 200 or 'result' not in result:
            raise ApiError('API_MCP_SESSION_INVALID', 'MCP 在线操作未返回有效回执，请核对原操作')
        return result['result']
    except (OSError, http.client.HTTPException, ValueError) as error:
        raise ApiError('API_MCP_SESSION_DISCONNECTED', 'Nexus 会话连接中断；在线操作结果可能未知，请核对原操作，不直接重试') from error
    finally:
        connection.close()
