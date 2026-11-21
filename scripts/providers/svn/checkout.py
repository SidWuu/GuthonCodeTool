"""Configuration-driven sparse SVN checkout management.

This module may manage the working-copy shape, but never edits Guthon source
content and never runs ``svn commit``.
"""

from __future__ import annotations

from common.svn_workspace_config import (ENV_REFERENCE, LEGACY_SVN_CAPABILITY_DEFAULTS, MANIFEST_SVN_CAPABILITY_DEFAULTS, SUPPORTED_INCLUDES, expand_config_value, svn_settings, validate_config_id)

import hashlib
import json
import os
import re
import subprocess
import sys
from datetime import datetime
import threading
import time
import xml.etree.ElementTree as ET
from contextlib import contextmanager
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlsplit

try:
    import fcntl
except ImportError:  # pragma: no cover - exercised by Windows builds
    fcntl = None
    import msvcrt


from common.persistence import atomic_text
from common.workspace_identity import CONFIG_ID as SAFE_ID, validate_config_id as validate_identity_id

WRITABLE_INCLUDES = {"pages", "procedures", "system-script", "views"}
# GuShen SVN uses legacy self-signed HTTPS certificates, including expired and
# hostname-mismatched certificates. Keep checkout, update and commit compatible
# with that service; operators can explicitly narrow the accepted failures.
TRUSTED_CERT_FAILURES = os.environ.get(
    "GUTHON_SVN_TRUSTED_CERT_FAILURES",
    "expired,cn-mismatch,unknown-ca,not-yet-valid,other",
)


_OPERATION_LOCK_STATE = threading.local()
SVN_CAPABILITY_DEFAULTS = LEGACY_SVN_CAPABILITY_DEFAULTS
SCOPE_FILE = "checkout-scope.json"
SCOPE_VERSION = 2
EXPECTED_WRITEBACK_FILE = "svn-writeback-state.json"
MIN_SVN_VERSION = (1, 10)


def _progress(callback, message: str) -> None:
    if callback is not None:
        callback(message)


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def json_hash(value) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()


def atomic_json(path: Path, value) -> None:
    atomic_text(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")








def require_capability(workspace: dict, name: str) -> None:
    capability = f"svn.{name}"
    if workspace.get("sourceMode") != "svn":
        raise SystemExit(f"{capability} is only available in SVN source mode")
    if not workspace.get("capabilities", {}).get(capability, False):
        raise SystemExit(f"Capability is disabled for {workspace['workspaceKey']}: {capability}")


@contextmanager
def operation_lock(
    workspace: dict,
    action: str,
    shared=False,
    blocking=False,
    timeout_seconds: float | None = None,
):
    if blocking and timeout_seconds is None:
        timeout_seconds = 60
    if timeout_seconds is not None and timeout_seconds <= 0:
        raise ValueError("SVN operation lock timeout must be positive")
    lock_path = workspace["contextDir"] / ".svn-operation.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    lock_key = str(lock_path.resolve())
    held_locks = getattr(_OPERATION_LOCK_STATE, "held", None)
    if held_locks is None:
        held_locks = {}
        _OPERATION_LOCK_STATE.held = held_locks
    held = held_locks.get(lock_key)
    if held is not None:
        if held["shared"] and not shared:
            raise SystemExit(
                f"Cannot upgrade nested SVN operation lock for {workspace['workspaceKey']}"
            )
        held["depth"] += 1
        try:
            yield
        finally:
            held["depth"] -= 1
            if held["depth"] == 0:
                held_locks.pop(lock_key, None)
        return
    # ``msvcrt.locking`` requires a stable seekable descriptor.  Opening the
    # file in append mode lets Windows move the CRT file position on writes,
    # which can make the matching unlock fail with PermissionError.
    if not lock_path.exists():
        lock_path.touch()
    # A POSIX shared flock needs only a readable descriptor.  Keep exclusive
    # operations and Windows on the seekable writable descriptor they require.
    open_mode = "rb" if shared and fcntl is not None else "r+b"
    with lock_path.open(open_mode) as handle:
        deadline = time.monotonic() + timeout_seconds if timeout_seconds is not None else None
        waiting = False
        while True:
            from common.operation_control import checkpoint
            checkpoint()
            try:
                if fcntl is not None:
                    mode = fcntl.LOCK_SH if shared else fcntl.LOCK_EX
                    if not blocking or deadline is not None:
                        mode |= fcntl.LOCK_NB
                    fcntl.flock(handle.fileno(), mode)
                else:  # Windows has no shared msvcrt lock; serialize all SVN operations.
                    handle.seek(0)
                    if not handle.read(1):
                        handle.seek(0)
                        handle.write(b"\0")
                        handle.flush()
                    handle.seek(0)
                    lock_mode = msvcrt.LK_LOCK if blocking and deadline is None else msvcrt.LK_NBLCK
                    msvcrt.locking(handle.fileno(), lock_mode, 1)
                break
            except (BlockingIOError, OSError) as error:
                if not waiting and deadline is not None:
                    waiting = True
                    timestamp = datetime.now().strftime('%H:%M:%S.%f')[:-3]
                    print(f"[{timestamp}] [SVN] 等待工作区操作锁 · {workspace['workspaceKey']} · {action} · 最多 {timeout_seconds:g} 秒", file=sys.stderr, flush=True)
                if deadline is None:
                    raise SystemExit(
                        f"Another SVN operation is active for {workspace['workspaceKey']}"
                    ) from error
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise SystemExit(
                        f"Timed out waiting for another SVN operation to finish for "
                        f"{workspace['workspaceKey']} ({timeout_seconds:g}s)"
                    ) from error
                time.sleep(min(0.05, remaining))
        held_locks[lock_key] = {"shared": bool(shared), "depth": 1}
        try:
            if not shared:
                binding = workspace.get("workspaceBinding")
                if binding is not None:
                    from common.workspace_registry import require_workspace_binding

                    require_workspace_binding(workspace, binding)
                handle.seek(0)
                handle.truncate()
                handle.write(f"{os.getpid()} {action}\n".encode("utf-8"))
                handle.flush()
            yield
        finally:
            held_locks.pop(lock_key, None)
            if fcntl is not None:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            else:
                try:
                    handle.flush()
                    handle.seek(0)
                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                except OSError:
                    # Closing the descriptor immediately afterwards releases
                    # the Windows byte-range lock.  Do not mask the operation
                    # result with a cleanup-only PermissionError (Errno 13).
                    pass


def _svn_auth(settings: dict, *, password_from_stdin=False) -> list[str]:
    args = []
    username = str(settings.get("username") or "").strip()
    if not username:
        raise SystemExit("未配置 SVN 用户名，请在 Nexus 的项目设置中配置 SVN 登录")
    args.extend(["--username", username])
    if password_from_stdin:
        args.append("--password-from-stdin")
    return [
        *args,
        "--non-interactive",
        "--trust-server-cert",
        f"--trust-server-cert-failures={TRUSTED_CERT_FAILURES}",
    ]


def run_svn(args, cwd: Path | None = None, check=True, input_text=None, show_stderr=False) -> subprocess.CompletedProcess:
    try:
        result = subprocess.run(
            ["svn", *map(str, args)],
            cwd=str(cwd) if cwd else None,
            input=input_text,
            stdout=subprocess.PIPE,
            stderr=None if show_stderr else subprocess.PIPE,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
    except FileNotFoundError as error:
        raise SystemExit("SVN client is not installed or not on PATH") from error
    if check and result.returncode:
        message = (result.stderr or result.stdout).strip()
        raise SystemExit(message or f"svn command failed: {' '.join(map(str, args))}")
    return result


def run_svn_binary(args, cwd: Path | None = None, check=True, input_text=None) -> subprocess.CompletedProcess:
    """Run a local SVN command without decoding its stdout.

    Source files may be UTF-8, GB18030, or BOM-prefixed Unicode.  Commands such
    as ``svn cat`` therefore have to return bytes so the shared source decoder
    can apply the same lossless rules used for the working copy.
    """

    try:
        result = subprocess.run(
            ["svn", *map(str, args)],
            cwd=str(cwd) if cwd else None,
            input=input_text.encode("utf-8") if input_text is not None else None,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    except FileNotFoundError as error:
        raise SystemExit("SVN client is not installed or not on PATH") from error
    if check and result.returncode:
        message = (result.stderr or result.stdout).decode("utf-8", errors="replace").strip()
        raise SystemExit(message or f"svn command failed: {' '.join(map(str, args))}")
    return result


SVN_CREDENTIAL_SERVICE = "GuthonCodeTool.SVN"


def _saved_password(settings):
    ref = settings.get("credentialRef")
    if ref:
        from common.database_readonly import get_password

        return get_password(ref, service=SVN_CREDENTIAL_SERVICE)
    return None


def run_remote_svn(
    args,
    settings: dict,
    cwd: Path | None = None,
    check=True,
    password: str | None = None,
) -> subprocess.CompletedProcess:
    if password is None:
        password = _saved_password(settings)
    auth_args = _svn_auth(settings, password_from_stdin=password is not None)
    return run_svn(
        [*args, *auth_args],
        cwd=cwd,
        check=check,
        input_text=f"{password}\n" if password is not None else None,
    )


def run_remote_svn_binary(args, settings: dict, cwd: Path | None = None, check=True) -> subprocess.CompletedProcess:
    """Run an authenticated remote SVN command while preserving source bytes."""

    password = _saved_password(settings)
    auth_args = _svn_auth(settings, password_from_stdin=password is not None)
    if password is None:
        return run_svn_binary([*auth_args, *args], cwd=cwd, check=check)
    return run_svn_binary([*auth_args, *args], cwd=cwd, check=check, input_text=f"{password}\n")


@lru_cache(maxsize=1)
def client_version() -> str:
    version = run_svn(["--version", "--quiet"]).stdout.strip()
    match = re.match(r"^(\d+)\.(\d+)", version)
    if not match or tuple(map(int, match.groups())) < MIN_SVN_VERSION:
        raise SystemExit(f"SVN client 1.10 or newer is required; found: {version or 'unknown'}")
    return version


def working_copy_version(path: Path) -> str:
    try:
        result = subprocess.run(
            ["svnversion", str(path)],
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
    except FileNotFoundError as error:
        raise SystemExit("svnversion is not installed or not on PATH") from error
    if result.returncode:
        raise SystemExit((result.stderr or result.stdout).strip() or f"svnversion failed for {path}")
    return result.stdout.strip()


def svn_info(path: Path) -> dict:
    result = run_svn(["info", "--xml", str(path)])
    root = ET.fromstring(result.stdout)
    entry = root.find("entry")
    if entry is None:
        raise SystemExit(f"Invalid svn info output for {path}")
    repository = entry.find("repository")
    return {
        "path": str(path.resolve()),
        "url": (entry.findtext("url") or "").rstrip("/"),
        "relativeUrl": entry.findtext("relative-url") or "",
        "repositoryRoot": (repository.findtext("root") if repository is not None else "") or "",
        "repositoryUuid": (repository.findtext("uuid") if repository is not None else "") or "",
        "revision": entry.get("revision") or "",
        "clientVersion": client_version(),
    }


def _status_changes(root: ET.Element, checkout_path: Path) -> tuple[list[dict], list[dict]]:
    changes = []
    remote_changes = []
    for entry in root.findall(".//entry"):
        wc = entry.find("wc-status")
        repos = entry.find("repos-status")
        item = wc.get("item", "") if wc is not None else ""
        props = wc.get("props", "") if wc is not None else ""
        switched = wc.get("switched", "false") == "true" if wc is not None else False
        copied = wc.get("copied", "false") == "true" if wc is not None else False
        tree_conflicted = wc.get("tree-conflicted", "false") == "true" if wc is not None else False
        wc_locked = wc.get("wc-locked", "false") == "true" if wc is not None else False
        raw_path = Path(entry.get("path") or "")
        try:
            relative = raw_path.resolve().relative_to(checkout_path.resolve()).as_posix()
        except ValueError:
            relative = raw_path.as_posix()
        repos_item = repos.get("item", "") if repos is not None else ""
        repos_props = repos.get("props", "") if repos is not None else ""
        if repos_item not in {"", "none", "normal"} or repos_props not in {"", "none", "normal"}:
            remote_changes.append({"path": relative, "item": repos_item, "properties": repos_props})
        if item in {"", "normal", "none", "ignored", "external"} and props in {"", "normal", "none"} and not (switched or copied or tree_conflicted or wc_locked):
            continue
        changes.append({
            "path": relative,
            "item": item,
            "properties": props,
            "revision": wc.get("revision", "") if wc is not None else "",
            "treeConflicted": tree_conflicted,
            "switched": switched,
            "copied": copied,
            "wcLocked": wc_locked,
        })
    return changes, remote_changes


def svn_path_changes(checkout_path: Path, source_path: Path) -> list[dict]:
    checkout_root = checkout_path.resolve()
    target = source_path.resolve()
    if target != checkout_root and checkout_root not in target.parents:
        raise SystemExit(f"SVN status target escaped its working copy: {source_path}")
    result = run_svn(["status", "--xml", "--depth", "empty", str(target)])
    changes, _remote_changes = _status_changes(ET.fromstring(result.stdout), checkout_root)
    return changes


def svn_status(checkout_path: Path, include_diff=False, remote=False, settings=None) -> dict:
    info = svn_info(checkout_path)
    status_args = ["status", "--xml"]
    if remote:
        status_args.append("--show-updates")
        result = run_remote_svn([*status_args, str(checkout_path)], settings or {})
    else:
        result = run_svn([*status_args, str(checkout_path)])
    root = ET.fromstring(result.stdout)
    changes, remote_changes = _status_changes(root, checkout_path)
    summary = run_svn(["diff", "--summarize", str(checkout_path)]).stdout.splitlines()
    svn_version = working_copy_version(checkout_path)
    output = {
        **info,
        "svnVersion": svn_version,
        "mixedRevision": ":" in svn_version,
        "switched": "S" in svn_version,
        "partial": "P" in svn_version,
        "clean": not changes,
        "changes": changes,
        "remoteChecked": bool(remote),
        "remoteChanges": remote_changes,
        "outOfDate": bool(remote_changes),
        "diffSummary": [line for line in summary if line.strip()],
    }
    if include_diff:
        output["diff"] = run_svn(["diff", str(checkout_path)]).stdout
    return output


def svn_scm_status_lightweight(checkout_path: Path, *, remote=False, settings=None) -> dict:
    """Read only the fields consumed by the Nexus SCM display."""
    info_xml = ET.fromstring(run_svn(["info", "--xml", str(checkout_path)]).stdout)
    entry = info_xml.find("entry")
    if entry is None:
        raise SystemExit(f"Invalid svn info output for {checkout_path}")
    status_args = ["status", "--xml"]
    if remote:
        status_args.append("--show-updates")
        status_result = run_remote_svn([*status_args, str(checkout_path)], settings or {})
    else:
        status_result = run_svn([*status_args, str(checkout_path)])
    changes, remote_changes = _status_changes(ET.fromstring(status_result.stdout), checkout_path)
    return {
        "revision": entry.get("revision") or "",
        "clean": not changes,
        "changes": changes,
        "remoteChecked": bool(remote),
        "remoteChanges": remote_changes,
        "outOfDate": bool(remote_changes),
    }


def _values(record: dict, *keys) -> set[str]:
    output = set()
    for key in keys:
        value = record.get(key)
        values = value if isinstance(value, (list, tuple, set)) else [value]
        output.update(str(item).strip() for item in values if item not in (None, ""))
    return output


def resolve_configured_scope(workspace: dict) -> dict:
    """Resolve SVN IDs only from the selected workspace's YAML mapping."""

    aliases = workspace.get("systemAliases") or []
    mappings = workspace.get("systemMappings") or {}
    missing = []
    invalid = []
    selected = []
    for alias in aliases:
        mapping = mappings.get(alias)
        if not isinstance(mapping, dict):
            missing.append(alias)
            continue
        system_id = mapping.get("system_id")
        data_source_id = mapping.get("data_source_id")
        if (
            not isinstance(system_id, str)
            or not system_id.strip()
            or not isinstance(data_source_id, str)
            or not data_source_id.strip()
        ):
            invalid.append(alias)
            continue
        selected.append({
            "systemAlias": alias,
            "systemId": system_id.strip(),
            "dataSourceId": data_source_id.strip(),
        })
    system_ids = set()
    data_source_ids = set()
    system_names = {}
    system_names_by_data_source = {}
    data_source_ids_by_system = {}
    for mapping in selected:
        system_id = mapping["systemId"]
        data_id = mapping["dataSourceId"]
        name = mapping["systemAlias"]
        system_ids.add(system_id)
        data_source_ids.add(data_id)
        system_names[system_id] = name
        data_source_ids_by_system[system_id] = {data_id}
        system_names_by_data_source.setdefault(data_id, name)
    return {
        "complete": not missing and not invalid and bool(aliases),
        "missingAliases": missing,
        "invalidAliases": invalid,
        "systemIds": sorted(system_ids),
        "dataSourceIds": sorted(data_source_ids),
        "systemNames": system_names,
        "systemNamesByDataSource": system_names_by_data_source,
        "dataSourceIdsBySystem": {
            system_id: sorted(values) for system_id, values in data_source_ids_by_system.items()
        },
        "mappingHash": json_hash(selected) if selected else "",
    }


def scope_manifest(workspace: dict, _config_dir: Path | None = None) -> dict:
    aliases = workspace.get("systemAliases") or []
    scope = resolve_configured_scope(workspace)
    includes = workspace["svn"]["includes"]
    mapping_errors = []
    if {"pages", "system-script"}.intersection(includes) and not scope["systemIds"]:
        mapping_errors.append("selected aliases have no SYSTEM_ID")
    if {"procedures", "tables", "views"}.intersection(includes) and not scope["dataSourceIds"]:
        mapping_errors.append("selected aliases have no DATA_SOURCE_ID")
    paths = ["info.json"]
    if "pages" in includes:
        paths.append("pages/index.md")
        paths.extend(f"pages/{system_id}" for system_id in scope["systemIds"])
    if "system-script" in includes:
        paths.extend(f"system-script/{system_id}" for system_id in scope["systemIds"])
    for include in ("procedures", "tables", "views"):
        if include in includes:
            paths.extend(f"{include}/{data_source_id}" for data_source_id in scope["dataSourceIds"])
    return {
        "version": SCOPE_VERSION,
        "workspaceKey": workspace["workspaceKey"],
        "systemAliases": aliases,
        "includes": includes,
        "systemIds": scope["systemIds"],
        "dataSourceIds": scope["dataSourceIds"],
        "systemNames": scope["systemNames"],
        "systemNamesByDataSource": scope["systemNamesByDataSource"],
        "dataSourceIdsBySystem": scope["dataSourceIdsBySystem"],
        "paths": sorted(dict.fromkeys(paths)),
        "mappingHash": scope["mappingHash"],
        "missingAliases": scope["missingAliases"],
        "invalidAliases": scope["invalidAliases"],
        "mappingErrors": mapping_errors,
        "complete": scope["complete"] and not mapping_errors,
    }


def scope_path(workspace: dict) -> Path:
    return workspace["contextDir"] / SCOPE_FILE


def load_scope(workspace: dict, required=True) -> dict:
    path = scope_path(workspace)
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        if not required:
            return {}
        raise SystemExit(f"Missing or invalid SVN scope manifest: {path}") from error
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit(f"Missing or invalid SVN scope manifest: {path}") from error
    if value.get("version") != SCOPE_VERSION or value.get("workspaceKey") != workspace["workspaceKey"]:
        raise SystemExit(f"SVN scope manifest does not match workspace: {workspace['workspaceKey']}")
    return value


def validate_expected_changes(workspace: dict, status: dict) -> list[dict]:
    expected_path = workspace["contextDir"] / EXPECTED_WRITEBACK_FILE
    try:
        expected_state = json.loads(expected_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        expected_state = {}
    expected = expected_state.get("files") or {} if expected_state.get("workspaceKey") == workspace["workspaceKey"] else {}
    errors = []
    for change in status.get("changes") or []:
        relative = change["path"]
        path = workspace["checkoutPath"] / relative
        expected_hash = (expected.get(relative) or {}).get("hash")
        safe = (
            change.get("item") == "modified"
            and change.get("properties") in {"", "normal", "none"}
            and not any(change.get(key) for key in ("treeConflicted", "switched", "copied"))
            and path.is_file()
            and expected_hash
            and file_hash(path) == expected_hash
        )
        if not safe:
            errors.append({"path": relative, "error": f"unexpected SVN {change.get('item') or 'status'} change"})
    return errors


def _clear_expected_changes(workspace: dict) -> None:
    atomic_json(
        workspace["contextDir"] / EXPECTED_WRITEBACK_FILE,
        {"workspaceKey": workspace["workspaceKey"], "files": {}},
    )


def _ensure_scope(workspace: dict, config_dir: Path, bootstrap=None) -> dict:
    manifest = scope_manifest(workspace, config_dir)
    if not manifest["complete"]:
        problems = []
        if manifest["missingAliases"]:
            problems.append("missing aliases: " + ", ".join(manifest["missingAliases"]))
        if manifest["invalidAliases"]:
            problems.append("invalid aliases: " + ", ".join(manifest["invalidAliases"]))
        problems.extend(manifest.get("mappingErrors") or [])
        raise SystemExit("Cannot resolve SVN sparse scope (" + "; ".join(problems) + ")")
    return manifest


def _verify_checkout(workspace: dict) -> dict:
    checkout_path = workspace["checkoutPath"]
    if not (checkout_path / ".svn").is_dir():
        raise SystemExit(f"Not an SVN working copy: {checkout_path}")
    info = svn_info(checkout_path)
    configured = workspace["svn"].get("repositoryUrl") or ""
    if configured and info["url"] != configured.rstrip("/"):
        raise SystemExit(f"SVN URL mismatch for {workspace['workspaceKey']}: {info['url']}")
    return info


def _repository_fingerprint(workspace: dict, info: dict) -> tuple[str, dict]:
    product_metadata = {}
    info_path = workspace["checkoutPath"] / "info.json"
    try:
        value = json.loads(info_path.read_text(encoding="utf-8"))
        product_metadata = {"proId": str(value.get("proId") or "")} if isinstance(value, dict) else {}
    except (OSError, json.JSONDecodeError):
        pass
    if not product_metadata.get("proId"):
        raise SystemExit(f"SVN info.json has no proId for {workspace['workspaceKey']}")
    identity = {
        "workspaceKey": workspace["workspaceKey"],
        "url": info.get("url") or "",
        "repositoryUuid": info.get("repositoryUuid") or "",
        "relativeUrl": info.get("relativeUrl") or "",
        "proId": product_metadata.get("proId") or "",
    }
    return json_hash(identity), product_metadata


def _remote_repository_fingerprint(workspace: dict, info: dict) -> str:
    info_url = f"{info['url'].rstrip('/')}/info.json"
    result = run_remote_svn(["cat", info_url], workspace["svn"])
    try:
        value = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise SystemExit(f"Invalid repository info.json: {info_url}") from error
    pro_id = str(value.get("proId") or "") if isinstance(value, dict) else ""
    if not pro_id:
        raise SystemExit(f"Repository info.json has no proId: {info_url}")
    identity = {
        "workspaceKey": workspace["workspaceKey"],
        "url": info.get("url") or "",
        "repositoryUuid": info.get("repositoryUuid") or "",
        "relativeUrl": info.get("relativeUrl") or "",
        "proId": pro_id,
    }
    return json_hash(identity)


def verify_repository_fingerprint(workspace: dict, expected: str) -> None:
    if not expected:
        raise SystemExit("SVN repository fingerprint is missing")
    info = _verify_checkout(workspace)
    current, _metadata = _repository_fingerprint(workspace, info)
    if current != expected:
        raise SystemExit(f"SVN repository fingerprint changed for {workspace['workspaceKey']}")


def _require_refreshable(status: dict) -> None:
    if not status["clean"]:
        raise SystemExit("SVN refresh is blocked because the working copy has local changes")
    if status.get("mixedRevision") or status.get("switched"):
        raise SystemExit(f"SVN refresh is blocked by unsupported working-copy state: {status.get('svnVersion')}")


def _update_path(checkout_path: Path, relative: str, settings: dict, on_progress=None) -> None:
    target = checkout_path / relative
    args = ["update", "--parents"]
    if Path(relative).suffix == "":
        args.extend(["--set-depth", "infinity"])
    args.append(str(target))
    _progress(on_progress, f"更新路径：{relative}")
    run_remote_svn(args, settings)


def _initialize(workspace: dict, config_dir: Path, bootstrap=None, on_progress=None) -> dict:
    require_capability(workspace, "initialize")
    settings = workspace["svn"]
    checkout_path = workspace["checkoutPath"]
    _progress(on_progress, f"{workspace['displayName']}｜初始化｜读取 SVN 范围配置")
    manifest = _ensure_scope(workspace, config_dir, bootstrap)
    if checkout_path.exists() and not checkout_path.is_dir():
        raise SystemExit(f"Checkout target is not a directory: {checkout_path}")
    if checkout_path.exists() and not (checkout_path / ".svn").is_dir():
        if any(checkout_path.iterdir()):
            raise SystemExit(f"Checkout target exists and is not empty: {checkout_path}")
        checkout_path.rmdir()
    if not checkout_path.exists():
        repository_url = settings.get("repositoryUrl") or ""
        if not repository_url:
            raise SystemExit(f"Missing svn.repository_url for {workspace['workspaceKey']}")
        checkout_path.parent.mkdir(parents=True, exist_ok=True)
        _progress(on_progress, f"{workspace['displayName']}｜初始化｜执行 SVN checkout")
        run_remote_svn(["checkout", "--depth", "empty", repository_url, str(checkout_path)], settings)
    info = _verify_checkout(workspace)
    _progress(on_progress, f"{workspace['displayName']}｜初始化｜检查 working copy 状态")
    current = svn_status(checkout_path)
    _require_refreshable(current)
    total = len(manifest["paths"])
    for index, relative in enumerate(manifest["paths"], 1):
        _progress(on_progress, f"{workspace['displayName']}｜初始化｜[{index}/{total}] 扩展 SVN 路径 · {relative}")
        _update_path(checkout_path, relative, settings, on_progress=on_progress)
    info = _verify_checkout(workspace)
    fingerprint, product_metadata = _repository_fingerprint(workspace, info)
    manifest.update({"revision": info["revision"], "repository": info, "repositoryFingerprint": fingerprint, "productMetadata": product_metadata})
    atomic_json(scope_path(workspace), manifest)
    _clear_expected_changes(workspace)
    _progress(on_progress, f"{workspace['displayName']}｜初始化｜完成 · r{info.get('revision') or '-'}")
    return {"ok": True, "action": "initialized", "scope": manifest, "status": svn_status(checkout_path)}


def initialize(workspace: dict, config_dir: Path, bootstrap=None, on_progress=None) -> dict:
    with operation_lock(workspace, "init"):
        return _initialize(workspace, config_dir, bootstrap, on_progress=on_progress)


def _refresh(workspace: dict, config_dir: Path, bootstrap=None, prune=False, on_progress=None) -> dict:
    require_capability(workspace, "refresh")
    checkout_path = workspace["checkoutPath"]
    if not (checkout_path / ".svn").is_dir():
        return _initialize(workspace, config_dir, bootstrap, on_progress=on_progress)
    _progress(on_progress, f"{workspace['displayName']}｜更新｜检查 working copy 状态")
    info_before = _verify_checkout(workspace)
    before = svn_status(checkout_path)
    _require_refreshable(before)
    previous = load_scope(workspace, required=False)
    fingerprint_before, _metadata = _repository_fingerprint(workspace, info_before)
    if previous.get("repositoryFingerprint") and previous["repositoryFingerprint"] != fingerprint_before:
        raise SystemExit(f"SVN repository fingerprint changed for {workspace['workspaceKey']}")
    if previous.get("repositoryFingerprint"):
        remote_fingerprint = _remote_repository_fingerprint(workspace, info_before)
        if previous["repositoryFingerprint"] != remote_fingerprint:
            raise SystemExit(f"SVN repository fingerprint changed remotely for {workspace['workspaceKey']}")
    _progress(on_progress, f"{workspace['displayName']}｜更新｜读取 SVN 范围配置")
    manifest = _ensure_scope(workspace, config_dir, bootstrap)
    stale = sorted(set(previous.get("paths") or []) - set(manifest["paths"]))
    total = len(manifest["paths"])
    for index, relative in enumerate(manifest["paths"], 1):
        _progress(on_progress, f"{workspace['displayName']}｜更新｜[{index}/{total}] 执行 SVN update · {relative}")
        _update_path(checkout_path, relative, workspace["svn"], on_progress=on_progress)
    if prune:
        for relative in stale:
            if relative in {"info.json", "pages/index.md"}:
                continue
            _progress(on_progress, f"{workspace['displayName']}｜更新｜移除过期稀疏路径 · {relative}")
            run_remote_svn(["update", "--set-depth", "exclude", str(checkout_path / relative)], workspace["svn"])
    info = _verify_checkout(workspace)
    fingerprint, product_metadata = _repository_fingerprint(workspace, info)
    if previous.get("repositoryFingerprint") and previous["repositoryFingerprint"] != fingerprint:
        raise SystemExit(f"SVN repository fingerprint changed during refresh for {workspace['workspaceKey']}")
    manifest.update({
        "revision": info["revision"],
        "repository": info,
        "repositoryFingerprint": fingerprint,
        "productMetadata": product_metadata,
        "residualPaths": [] if prune else stale,
    })
    atomic_json(scope_path(workspace), manifest)
    _clear_expected_changes(workspace)
    _progress(on_progress, f"{workspace['displayName']}｜更新｜完成 · r{info.get('revision') or '-'}")
    return {
        "ok": True,
        "action": "refreshed",
        "scope": manifest,
        "residualPaths": [] if prune else stale,
        "status": svn_status(checkout_path),
    }


def refresh(workspace: dict, config_dir: Path, bootstrap=None, prune=False, on_progress=None) -> dict:
    with operation_lock(workspace, "refresh"):
        return _refresh(workspace, config_dir, bootstrap, prune, on_progress=on_progress)
