"""Native platform PAGE lifecycle through the paired, workspace-bound Bridge.

The platform owns PAGE registration and copying. Never manufacture a new PAGE
by inventing a checkout filename. Persist dispatch intent before sending, and
never replay a possibly accepted mutation after a timeout or lost receipt.
"""
from __future__ import annotations

import hashlib
import http.client
import json
from pathlib import Path
import re
import time
import uuid
from urllib.parse import urlencode

from providers.svn.checkout import atomic_json, operation_lock, require_capability
from .manifest import load_authorized_scope

PREFIX = "page-life:v1:"
EDIT_PREFIX = "page-life-edit:v1:"


def _digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _request(home, port, path, body=None):
    if type(port) is not int or not 1 <= port <= 65535:
        raise ValueError("Invalid local Bridge port")
    token = (Path(home) / "var/nexus/bridge/token").read_text().strip()
    if not re.fullmatch(r"[a-f0-9]{64}", token):
        raise ValueError("Bridge pairing token is invalid; start Bridge in Nexus")
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        headers = {"Authorization": "Bearer " + token, "Content-Type": "application/json"}
        connection.request("POST" if body is not None else "GET", path,
                           body=json.dumps(body).encode() if body is not None else None, headers=headers)
        response = connection.getresponse()
        raw = response.read(131073)
        if len(raw) > 131072:
            raise ValueError("Bridge response exceeds PAGE lifecycle budget")
        data = json.loads(raw)
        if response.status not in {200, 202} or not data.get("ok"):
            raise ValueError(str(data.get("message") or "Bridge rejected PAGE lifecycle request")[:512])
        return data
    finally:
        connection.close()


def _context(workspace, home, port, context_id):
    result = _request(home, port, "/pageContext?" + urlencode({"workspaceKey": workspace["workspaceKey"]}))
    contexts = [item for item in result.get("contexts", []) if item.get("workspaceKey") == workspace["workspaceKey"]]
    if context_id:
        contexts = [item for item in contexts if item.get("contextId") == context_id]
    if len(contexts) != 1:
        raise ValueError("Select exactly one paired platform context using get_page_lifecycle_context")
    return contexts[0]


def _dispatch(workspace, home, port, context_id, target):
    return _request(home, port, "/pageLifecycle", {"workspaceKey": workspace["workspaceKey"],
        "contextId": context_id, "target": target})["requestId"]


def _receipt(workspace, home, port, request_id, wait_seconds=20):
    deadline = time.monotonic() + wait_seconds
    while True:
        result = _request(home, port, "/navigationResult?" + urlencode({"workspaceKey": workspace["workspaceKey"], "requestId": request_id}))
        if result["state"] != "PENDING":
            if result["state"] != "SUCCEEDED" or not isinstance(result.get("data"), dict):
                return {"state": "UNKNOWN", "message": result.get("message") or "Platform receipt unavailable; do not replay"}
            return result["data"]
        if time.monotonic() >= deadline:
            return {"state": "PENDING", "message": "Wait for the original receipt; do not replay"}
        time.sleep(0.2)


def context(workspace, home, *, context_id="", page_id="", bridge_port=17361):
    require_capability(workspace, "browse")
    result = _request(home, bridge_port, "/pageContext?" + urlencode({"workspaceKey": workspace["workspaceKey"]}))
    contexts = result.get("contexts", [])
    if not context_id and len(contexts) != 1:
        return {"workspaceKey": workspace["workspaceKey"], "contexts": contexts, "selectionRequired": True}
    selected = _context(workspace, home, bridge_port, context_id)
    request_id = _dispatch(workspace, home, bridge_port, selected["contextId"], {"action": "inspect", "pageId": page_id})
    return {"workspaceKey": workspace["workspaceKey"], "contextId": selected["contextId"],
            "pageOrigin": selected["pageOrigin"], **_receipt(workspace, home, bridge_port, request_id)}


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
    current = context(workspace, home, context_id=context_id, page_id=page_id, bridge_port=bridge_port)
    if current.get("state") != "SUCCEEDED":
        raise ValueError("Platform PAGE metadata is unavailable; select a live paired context")
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
        selected = _context(workspace, home, lease["bridgePort"], lease["contextId"])
        if selected["pageOrigin"] != lease["pageOrigin"]:
            raise ValueError("Platform origin changed after preview")
        record = {"version": 1, "operationId": PREFIX + path.stem, "workspaceKey": workspace["workspaceKey"],
                  "editToken": edit_token, "candidateHash": candidate_hash, "bridgePort": lease["bridgePort"],
                  "state": "DISPATCHING", "target": lease["target"], "createdAt": int(time.time())}
        lease["operationId"] = record["operationId"]
        atomic_json(_lease_path(workspace, edit_token), lease)
        atomic_json(path, record)
        try:
            request_id = _dispatch(workspace, home, lease["bridgePort"], lease["contextId"], lease["target"])
            record.update(state="PENDING", requestId=request_id)
            atomic_json(path, record)
            receipt = _receipt(workspace, home, lease["bridgePort"], request_id)
            record.update(state=receipt["state"], receipt=receipt)
        except (OSError, ValueError, http.client.HTTPException):
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
            try:
                receipt = _receipt(workspace, home, record["bridgePort"], record["requestId"])
            except (OSError, ValueError, http.client.HTTPException):
                receipt = {"state": "UNKNOWN", "message": "Original receipt unavailable; reconcile platform state without replaying"}
            record.update(state=receipt["state"], receipt=receipt)
            atomic_json(path, record)
        return status(workspace, operation_id=operation_id)
