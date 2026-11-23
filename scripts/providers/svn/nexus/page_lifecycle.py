"""Native platform PAGE lifecycle through the paired, workspace-bound Bridge.

The platform owns PAGE registration and copying. Never manufacture a new PAGE
by inventing a checkout filename. Persist dispatch intent before sending, and
never replay a possibly accepted mutation after a timeout or lost receipt.
"""
from __future__ import annotations

import hashlib
import json
import re
import time
import uuid

from common.bridge_page_session import BridgePageSession, BridgeSessionError, PAGE_ACTIONS
from providers.svn.checkout import atomic_json, operation_lock, require_capability
from .manifest import load_authorized_scope

PREFIX = "page-life:v1:"
EDIT_PREFIX = "page-life-edit:v1:"


def _digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def context(workspace, home, *, context_id="", page_id="", bridge_port=17361,
            operation="读取平台 PAGE 上下文"):
    require_capability(workspace, "browse")
    bridge = BridgePageSession(home, workspace["workspaceKey"], bridge_port, operation)
    selected = bridge.context(context_id)
    if selected.get("selectionRequired"):
        return selected
    request_id = bridge.dispatch(selected["contextId"], {"action": "inspect", "pageId": page_id})
    return {"workspaceKey": workspace["workspaceKey"], "contextId": selected["contextId"],
            "pageOrigin": selected["pageOrigin"], **bridge.receipt(request_id)}


def _lease_path(workspace, edit_token):
    identifier = edit_token.removeprefix(EDIT_PREFIX)
    if not edit_token.startswith(EDIT_PREFIX) or not re.fullmatch(r"[a-f0-9]{32}", identifier):
        raise ValueError("Invalid PAGE lifecycle edit token")
    return workspace["contextDir"] / "page-lifecycle/leases" / (identifier + ".json")


def open_edit(workspace, home, *, action, properties=None, page_id="", context_id="", bridge_port=17361):
    require_capability(workspace, "edit")
    if action not in {"create", "copy", "delete"} or action in {"copy", "delete"} and not page_id:
        raise ValueError("PAGE lifecycle needs create/copy/delete and an exact source PAGE for copy/delete")
    if action == "create" and page_id:
        raise ValueError("The platform allocates a new PAGE ID; create cannot reuse pageId")
    if not isinstance(properties or {}, dict) or len(json.dumps(properties or {})) > 10000:
        raise ValueError("PAGE properties must be a bounded object")
    operation = f"准备{PAGE_ACTIONS[action]}"
    current = context(workspace, home, context_id=context_id, page_id=page_id, bridge_port=bridge_port, operation=operation)
    if current.get("selectionRequired"):
        raise ValueError(f"“{operation}”需要选择一个当前工作区的谷神页签，请先查询平台 PAGE 上下文。")
    if current.get("state") != "SUCCEEDED":
        raise ValueError(f"“{operation}”无法读取平台 PAGE 元数据。{current.get('message', '')}")
    if action == "delete" and current.get("page", {}).get("isProduct"):
        raise ValueError("Product PAGE cannot be deleted")
    properties = properties or {}
    if action == "copy" and "pageAliasId" not in properties and current.get("page", {}).get("pageAliasId"):
        properties = {**properties, "pageAliasId": current["page"]["pageAliasId"] + ".copy"}
    allowed = {"systemId","mkId","pageType","pageName","pageAliasId","title","accessTag","bntAuth","runInTran","isCanInter","isTextResponse","pageTemplateType"}
    if set(properties) - allowed or action == "delete" and properties:
        raise ValueError("Unsupported native PAGE lifecycle properties")
    if action in {"create", "copy"}:
        proposed = {**(current.get("page", {}) if action == "copy" else {}), **properties}
        if type(proposed.get("pageType")) is not int or proposed["pageType"] not in range(7):
            raise ValueError("Native PAGE requires pageType 0–6")
        if action == "copy" and proposed["pageType"] != current["page"]["pageType"]:
            raise ValueError("Native PAGE copy cannot change the source pageType")
        for name in ("systemId", "mkId", "pageName"):
            if not isinstance(proposed.get(name), str) or not proposed[name].strip():
                raise ValueError("Native PAGE requires " + name)
        if not any(item.get("systemId") == proposed["systemId"] and item.get("mkId") == proposed["mkId"] for item in current.get("modules", [])):
            raise ValueError("Target module is not in the selected platform context")
        if proposed["pageType"] not in {1, 5} and not proposed.get("pageAliasId"):
            raise ValueError("Native PAGE requires pageAliasId for this page type")
        if proposed["pageType"] not in {0, 5} and not proposed.get("title"):
            raise ValueError("Native PAGE requires title for this page type")
    target = {"action": action, "pageId": page_id, "properties": properties or {}}
    if action in {"copy", "delete"}:
        if current.get("sourceVersion") is None:
            raise ValueError("Platform did not return a PAGE source version")
        target["expectedVersion"] = current["sourceVersion"]
        target["expectedPage"] = current["page"]
    token = EDIT_PREFIX + uuid.uuid4().hex
    lease = {"version": 1, "workspaceKey": workspace["workspaceKey"],
             "scopeDigest": load_authorized_scope(workspace).digest,
             "contextId": current["contextId"], "pageOrigin": current["pageOrigin"], "bridgePort": bridge_port,
             "target": target, "before": current.get("page", {}), "expiresAt": int(time.time()) + 1800}
    lease["candidateHash"] = _digest({key: value for key, value in lease.items() if key != "expiresAt"})
    with operation_lock(workspace, "page-lifecycle-open", blocking=True):
        atomic_json(_lease_path(workspace, token), lease)
    return {"workspaceKey": workspace["workspaceKey"], "editToken": token, "expiresAt": lease["expiresAt"],
            "candidateHash": lease["candidateHash"], "pageOrigin": lease["pageOrigin"], "target": target,
            "before": lease["before"], "platformWrite": True, "localSourceSynchronized": False}


def preview(workspace, *, edit_token):
    require_capability(workspace, "browse")
    lease = json.loads(_lease_path(workspace, edit_token).read_text())
    if lease.get("workspaceKey") != workspace["workspaceKey"] or lease.get("scopeDigest") != load_authorized_scope(workspace).digest or lease["expiresAt"] < time.time():
        raise ValueError("PAGE lifecycle lease expired or authorization changed; reopen")
    if lease["candidateHash"] != _digest({key: value for key, value in lease.items() if key not in {"candidateHash", "expiresAt", "operationId"}}):
        raise ValueError("PAGE lifecycle lease is damaged; preserve the original operation")
    return {"workspaceKey": workspace["workspaceKey"], "candidateHash": lease["candidateHash"],
            "target": lease["target"], "before": lease["before"], "pageOrigin": lease["pageOrigin"],
            "dryRun": True, "platformWrite": True, "localSourceSynchronized": False}


def _operation_path(workspace, *, operation_id="", idempotency_key=""):
    identifier = operation_id.removeprefix(PREFIX) if operation_id else _digest(idempotency_key)
    if operation_id and not operation_id.startswith(PREFIX) or not re.fullmatch(r"[a-f0-9]{64}", identifier):
        raise ValueError("Invalid PAGE lifecycle operation identity")
    if not operation_id and (not isinstance(idempotency_key, str) or not 1 <= len(idempotency_key) <= 256):
        raise ValueError("PAGE lifecycle write requires an idempotencyKey")
    return workspace["contextDir"] / "page-lifecycle/operations" / (identifier + ".json")


def status(workspace, *, operation_id="", idempotency_key=""):
    require_capability(workspace, "browse")
    record = json.loads(_operation_path(workspace, operation_id=operation_id, idempotency_key=idempotency_key).read_text())
    if record.get("workspaceKey") != workspace["workspaceKey"]:
        raise ValueError("PAGE lifecycle operation belongs to another workspace")
    return {key: record[key] for key in ("operationId", "workspaceKey", "state", "requestId", "receipt") if key in record} | {
        "platformWrite": True, "localSourceSynchronized": False, "automaticReplayAllowed": False}


def apply(workspace, home, *, edit_token, candidate_hash, idempotency_key):
    require_capability(workspace, "edit")
    path = _operation_path(workspace, idempotency_key=idempotency_key)
    with operation_lock(workspace, "page-lifecycle-write", blocking=True):
        if path.exists():
            old = json.loads(path.read_text())
            if old.get("editToken") != edit_token or old.get("candidateHash") != candidate_hash:
                raise ValueError("PAGE lifecycle idempotencyKey was used for another request")
            return status(workspace, idempotency_key=idempotency_key)
        proposed = preview(workspace, edit_token=edit_token)
        if proposed["candidateHash"] != candidate_hash:
            raise ValueError("PAGE lifecycle candidate differs from preview")
        lease = json.loads(_lease_path(workspace, edit_token).read_text())
        if lease.get("operationId"):
            raise ValueError("PAGE lifecycle lease was already consumed; inspect " + lease["operationId"])
        bridge = BridgePageSession(home, workspace["workspaceKey"], lease["bridgePort"], PAGE_ACTIONS[lease["target"]["action"]])
        selected = bridge.context(lease["contextId"])
        if selected["pageOrigin"] != lease["pageOrigin"]:
            raise ValueError("Platform origin changed after preview")
        record = {"version": 1, "operationId": PREFIX + path.stem, "workspaceKey": workspace["workspaceKey"],
                  "editToken": edit_token, "candidateHash": candidate_hash, "bridgePort": lease["bridgePort"],
                  "state": "DISPATCHING", "target": lease["target"], "createdAt": int(time.time())}
        lease["operationId"] = record["operationId"]
        atomic_json(_lease_path(workspace, edit_token), lease)
        atomic_json(path, record)
        try:
            request_id = bridge.dispatch(lease["contextId"], lease["target"])
            record.update(state="PENDING", requestId=request_id)
            atomic_json(path, record)
            receipt = bridge.receipt(request_id)
            record.update(state=receipt["state"], receipt=receipt)
        except BridgeSessionError as error:
            record.update(state="UNKNOWN", receipt=error.unknown_receipt())
        except (OSError, ValueError):
            record.update(state="UNKNOWN", receipt={"message": "Dispatch or receipt interrupted; inspect platform before any further write"})
        atomic_json(path, record)
        return status(workspace, idempotency_key=idempotency_key)


def resume(workspace, home, *, operation_id):
    require_capability(workspace, "edit")
    path = _operation_path(workspace, operation_id=operation_id)
    with operation_lock(workspace, "page-lifecycle-resume", blocking=True):
        record = json.loads(path.read_text())
        if record.get("workspaceKey") != workspace["workspaceKey"]:
            raise ValueError("PAGE lifecycle workspace mismatch")
        if record.get("requestId") and record["state"] in {"PENDING", "UNKNOWN"}:
            operation = f"核对{PAGE_ACTIONS[record['target']['action']]} 的原回执"
            try:
                bridge = BridgePageSession(home, workspace["workspaceKey"], record["bridgePort"], operation)
                receipt = bridge.receipt(record["requestId"])
            except BridgeSessionError as error:
                receipt = error.unknown_receipt()
            except (OSError, ValueError):
                receipt = {"state": "UNKNOWN", "message": "Original receipt unavailable; reconcile platform state without replaying"}
            record.update(state=receipt["state"], receipt=receipt)
            atomic_json(path, record)
        return status(workspace, operation_id=operation_id)
