"""Actual API operation progress on stderr; never log request or response bodies."""

from contextlib import contextmanager
from contextvars import ContextVar
import json
import re
import sys
import time

_current = ContextVar("api_progress", default=None)
_ACTIONS = {
    "pull": "更新源码", "scope-apply": "更新源码范围", "refresh": "更新指定源码",
    "upload": "上传源码", "verify-upload": "回读核对上传", "create-function": "创建过程函数",
    "module-parameters-sync": "同步模块参数清单", "module-parameter-load": "读取模块参数详情", "module-upload": "上传模块参数",
}


def emit(message):
    if _current.get() is not None:
        print("[谷神 API] " + message, file=sys.stderr, flush=True)


@contextmanager
def operation(workspace_key, action):
    if action not in _ACTIONS:
        yield
        return
    token = _current.set({"seen": set()})
    started = time.monotonic()
    emit(f"开始{_ACTIONS[action]} · {workspace_key}")
    try:
        yield
    except Exception as error:
        code = getattr(error, "code", "API_OPERATION_FAILED")
        emit(f"处理失败 · {code if re.fullmatch(r'[A-Z][A-Z0-9_]{2,63}', str(code)) else 'API_OPERATION_FAILED'}")
        raise
    finally:
        emit(f"处理结束 · 耗时 {round((time.monotonic() - started) * 1000)} ms")
        _current.reset(token)


@contextmanager
def request(path):
    # Login payloads, session tokens, query strings and returned source never enter output.
    native_page = path in {"/develop/dev/pages/getPageModuleXml.htm", "/develop/dev/pages/getPageBaseInfo.htm", "/develop/dev/models/savePageModuleXml.htm"}
    if _current.get() is None or not (native_page or re.fullmatch(r"/develop/(?:vscode/source/(?:download|upload)/|procedure/admin/|systems/(?:apps|datasource)/|dev/models/config/(?:version/)?)[A-Za-z]+\.htm", path)):
        yield
        return
    started = time.monotonic()
    emit("发起平台请求 · " + path)
    try:
        yield
    except Exception as error:
        code = getattr(error, "code", "API_REQUEST_FAILED")
        emit(f"平台请求未完成 · {path} · {code if re.fullmatch(r'[A-Z][A-Z0-9_]{2,63}', str(code)) else 'API_REQUEST_FAILED'}")
        raise
    else:
        emit(f"收到平台成功应答 · {path} · {round((time.monotonic() - started) * 1000)} ms")


def receipt(record):
    state = _current.get()
    if state is None:
        return
    operation_id = record.get("operationId", "")
    if not re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", operation_id):
        return
    rows = [("", record.get("stage"))] + [
        (row.get("path", ""), row.get("stage")) for row in record.get("results", [])
    ]
    for path, stage in rows:
        if not isinstance(stage, str) or not re.fullmatch(r"[A-Z_]{1,64}", stage):
            continue
        event = (operation_id, path, stage)
        if event not in state["seen"]:
            state["seen"].add(event)
            emit(f"已记录阶段 · {operation_id} · {stage}" + (" · " + json.dumps(path, ensure_ascii=False) if path else ""))
