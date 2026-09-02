"""Configuration-driven sparse SVN checkout management.

This module may manage the working-copy shape, but never edits Guthon source
content and never runs ``svn commit``.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import tempfile
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


SUPPORTED_INCLUDES = {"pages", "procedures", "system-script", "tables", "views"}
WRITABLE_INCLUDES = {"pages", "procedures", "system-script"}
TRUSTED_CERT_FAILURES = "expired,cn-mismatch,unknown-ca,not-yet-valid,other"
LEGACY_SVN_CAPABILITY_DEFAULTS = {
    "initialize": True,
    "refresh": True,
    "status": True,
    "reindex": True,
    "workcopy": True,
    "writeback": True,
    "commit": False,
    "browse": False,
    "edit": False,
    "history": False,
    "revert": False,
}
MANIFEST_SVN_CAPABILITY_DEFAULTS = {
    "initialize": True,
    "refresh": True,
    "status": True,
    "reindex": True,
    "workcopy": False,
    "writeback": False,
    "commit": False,
    "browse": True,
    "edit": True,
    "history": True,
    "revert": True,
}
SVN_CAPABILITY_DEFAULTS = LEGACY_SVN_CAPABILITY_DEFAULTS
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
ENV_REFERENCE = re.compile(r"^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$")
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
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(temp_name, path)
    except Exception:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass
        raise


def validate_config_id(config_id: str) -> None:
    if not SAFE_ID.fullmatch(str(config_id or "")) or config_id in {".", ".."}:
        raise SystemExit(f"Unsafe workspace config id: {config_id}")


def expand_config_value(value, label: str, *, allow_missing_env=False) -> str:
    """Expand one exact ``${NAME}`` reference without accepting partial templates."""

    text = str(value or "").strip()
    match = ENV_REFERENCE.fullmatch(text)
    if match:
        name = match.group(1)
        resolved = os.environ.get(name, "").strip()
        if not resolved and not allow_missing_env:
            raise SystemExit(f"Configuration environment variable is empty for {label}: {name}")
        return resolved
    if "${" in text:
        raise SystemExit(f"Configuration value must use one exact ${{NAME}} reference for {label}")
    return text


def svn_settings(
    config_id: str,
    item: dict,
    var_dir: Path,
    workspace_dir: Path | None = None,
    shared_svn: dict | None = None,
) -> dict:
    validate_config_id(config_id)
    svn = item.get("svn") or {}
    if not isinstance(svn, dict):
        raise SystemExit(f"svn must be a mapping for {config_id}")
    scope_manifest_value = str(svn.get("scope_manifest") or "").strip()
    # ``repository_url`` remains the legacy sparse checkout root. Compact
    # manifest configs use ``svn.url`` and expand child paths separately.
    scope_root_value = str(svn.get("url") or svn.get("scope_url") or "").strip()
    repository_url_value = str(svn.get("repository_url") or "").strip()
    convention_manifest = not scope_manifest_value and not repository_url_value
    checkout_layout = str(
        svn.get("checkout_layout")
        or ("manifest-working-copies" if scope_manifest_value or convention_manifest else "legacy-sparse")
    ).strip().lower()
    if checkout_layout not in {"legacy-sparse", "manifest-working-copies"}:
        raise SystemExit(f"Unsupported svn.checkout_layout for {config_id}: {checkout_layout}")
    if checkout_layout == "manifest-working-copies" and not scope_manifest_value and workspace_dir is None:
        raise SystemExit(
            f"workspace_dir is required for convention-based manifest-working-copies: {config_id}"
        )
    capability_defaults = (
        MANIFEST_SVN_CAPABILITY_DEFAULTS
        if checkout_layout == "manifest-working-copies"
        else LEGACY_SVN_CAPABILITY_DEFAULTS
    )
    configured = dict(svn.get("capabilities") or {})
    # Older configs may still contain this flag. It is intentionally ignored:
    # manifest-based SVN workspaces always support saving to Guthon.
    configured.pop("platform_save", None)
    non_boolean = [name for name, value in configured.items() if not isinstance(value, bool)]
    if non_boolean:
        raise SystemExit(f"SVN capabilities must be boolean for {config_id}: {', '.join(sorted(non_boolean))}")
    unknown = set(configured) - set(capability_defaults)
    if unknown:
        raise SystemExit(f"Unknown SVN capabilities for {config_id}: {', '.join(sorted(unknown))}")
    capabilities = {key: bool(configured.get(key, default)) for key, default in capability_defaults.items()}
    if capabilities["commit"] or configured.get("commit") is True:
        raise SystemExit(f"svn.capabilities.commit must remain false for {config_id}")
    if capabilities["writeback"] and not all(capabilities[name] for name in ("status", "reindex", "workcopy")):
        raise SystemExit(f"svn.writeback requires status, reindex and workcopy for {config_id}")
    if capabilities["edit"] and not all(capabilities[name] for name in ("browse", "status", "reindex")):
        raise SystemExit(f"svn.edit requires browse, status and reindex for {config_id}")
    if capabilities["revert"] and not all(capabilities[name] for name in ("edit", "status")):
        raise SystemExit(f"svn.revert requires edit and status for {config_id}")
    includes = svn.get("include") or ["pages", "procedures", "system-script"]
    if isinstance(includes, str):
        includes = [value.strip() for value in includes.strip("[]").split(",") if value.strip()]
    includes = list(dict.fromkeys(str(value).strip() for value in includes if str(value).strip()))
    invalid = set(includes) - SUPPORTED_INCLUDES
    if invalid:
        raise SystemExit(f"Unsupported SVN include for {config_id}: {', '.join(sorted(invalid))}")
    checkout_root_value = svn.get("checkout_root")
    checkout_root = Path(
        expand_config_value(checkout_root_value, f"svn.checkout_root for {config_id}")
        if checkout_root_value not in (None, "")
        else var_dir / "checkout"
    ).expanduser().resolve()
    if checkout_root in {Path("/").resolve(), Path.home().resolve()}:
        raise SystemExit(f"Unsafe svn.checkout_root for {config_id}: {checkout_root}")
    checkout_path = (checkout_root / config_id).resolve()
    if checkout_path.parent != checkout_root:
        raise SystemExit(f"Invalid SVN checkout path for {config_id}")
    repository_url = expand_config_value(
        repository_url_value,
        f"svn.repository_url for {config_id}",
        allow_missing_env=True,
    ).rstrip("/")
    if repository_url:
        parsed_url = urlsplit(repository_url)
        if parsed_url.scheme not in {"http", "https", "svn", "svn+ssh", "file"}:
            raise SystemExit(f"Unsupported SVN repository URL scheme for {config_id}")
        if parsed_url.username or parsed_url.password:
            raise SystemExit(f"SVN credentials must not be embedded in repository_url for {config_id}")
    scope_root_url = expand_config_value(
        scope_root_value,
        f"svn.url for {config_id}",
        allow_missing_env=True,
    ).rstrip("/")
    if scope_root_url:
        parsed_url = urlsplit(scope_root_url)
        if parsed_url.scheme not in {"http", "https", "svn", "svn+ssh", "file"}:
            raise SystemExit(f"Unsupported SVN URL scheme for {config_id}")
        if parsed_url.username or parsed_url.password:
            raise SystemExit(f"SVN credentials must not be embedded in svn.url for {config_id}")
    if not repository_url and capabilities["initialize"] and checkout_layout == "legacy-sparse":
        # Existing working copies remain usable without retaining their URL in YAML.
        if not (checkout_path / ".svn").is_dir():
            raise SystemExit(f"Missing svn.repository_url for {config_id}")
    sparse_checkout = bool(svn.get("sparse_checkout", checkout_layout == "legacy-sparse"))
    if checkout_layout == "legacy-sparse" and not sparse_checkout:
        raise SystemExit(f"SVN provider requires sparse_checkout=true for {config_id}")
    if checkout_layout == "manifest-working-copies" and sparse_checkout:
        raise SystemExit(f"manifest-working-copies does not use svn.sparse_checkout for {config_id}")
    scope_manifest_path = None
    if scope_manifest_value:
        relative_manifest = Path(scope_manifest_value)
        if relative_manifest.is_absolute() or ".." in relative_manifest.parts:
            raise SystemExit(f"svn.scope_manifest must be relative to config for {config_id}")
        config_root = (var_dir.parent / "config").resolve()
        scope_manifest_path = (config_root / relative_manifest).resolve()
        if scope_manifest_path != config_root and config_root not in scope_manifest_path.parents:
            raise SystemExit(f"svn.scope_manifest escapes config for {config_id}")
    elif checkout_layout == "manifest-working-copies":
        context_root = (workspace_dir / "context").resolve()
        scope_manifest_path = (context_root / "authorized-scope.json").resolve()
        if context_root not in scope_manifest_path.parents:
            raise SystemExit(f"Default SVN scope manifest escapes workspace context for {config_id}")
    scope_config_value = str(svn.get("scope_config") or svn.get("scope_file") or "").strip()
    scope_entries = svn.get("scope")
    if scope_entries is None:
        scope_entries = svn.get("entries")
    if scope_entries is not None and not isinstance(scope_entries, list):
        raise SystemExit(f"svn.scope/entries must be a list for {config_id}")
    scope_config_path = None
    if scope_config_value:
        config_root = (var_dir.parent / "config").resolve()
        configured_scope = Path(scope_config_value)
        if configured_scope.is_absolute() or ".." in configured_scope.parts:
            raise SystemExit(f"svn.scope_config must be relative to the config directory for {config_id}")
        scope_config_path = (config_root / configured_scope).resolve()
        if config_root not in scope_config_path.parents:
            raise SystemExit(f"svn.scope_config escapes the config directory for {config_id}")
    checkout_script_value = str(svn.get("checkout_script") or "").strip()
    legacy_checkout_bat = str(svn.get("checkout_bat") or "").strip()
    if checkout_script_value and legacy_checkout_bat:
        raise SystemExit(f"Configure only svn.checkout_script for {config_id}; checkout_bat is the legacy alias")
    configured_checkout_script = checkout_script_value or legacy_checkout_bat
    if configured_checkout_script:
        if workspace_dir is None:
            raise SystemExit(f"workspace_dir is required for svn.checkout_script: {config_id}")
        configured_script = Path(configured_checkout_script)
        if configured_script.is_absolute() or ".." in configured_script.parts:
            raise SystemExit(f"svn.checkout_script must be relative to the workspace context for {config_id}")
        context_root = (workspace_dir / "context").resolve()
        checkout_script_path = (context_root / configured_script).resolve()
        if context_root not in checkout_script_path.parents:
            raise SystemExit(f"svn.checkout_script escapes workspace context for {config_id}")
    elif workspace_dir is not None:
        context_root = (workspace_dir / "context").resolve()
        shell_script = (context_root / "svnCheckoutHere.sh").resolve()
        bat_script = (context_root / "svnCheckoutHere.bat").resolve()
        checkout_script_path = shell_script if shell_script.is_file() or not bat_script.is_file() else bat_script
        if context_root not in checkout_script_path.parents:
            raise SystemExit(f"Default SVN checkout script escapes workspace context for {config_id}")
    else:
        checkout_script_path = None
    update_policy = str(svn.get("update_policy") or "manual").strip().lower()
    if update_policy != "manual":
        raise SystemExit(f"svn.update_policy must be manual for {config_id}")
    legacy_auth_keys = {"username_env", "password_env", "no_auth_cache"} & set(svn)
    if legacy_auth_keys:
        raise SystemExit(
            "SVN 登录已统一使用 sync.yaml 的 svn.username；请删除产品/项目中的旧配置："
            + ", ".join(sorted(legacy_auth_keys))
        )
    shared_username = ""
    if shared_svn is not None:
        if not isinstance(shared_svn, dict):
            raise SystemExit("sync.yaml 的 svn 必须是对象")
        shared_username = str(shared_svn.get("username") or "").strip()
        if not shared_username:
            raise SystemExit("未配置公共 SVN 用户名：请设置 sync.yaml 的 svn.username")
    return {
        "repositoryUrl": repository_url,
        "scopeRootUrl": scope_root_url,
        "checkoutRoot": checkout_root,
        "checkoutPath": checkout_path,
        "capabilities": capabilities,
        "includes": includes,
        "sparseCheckout": sparse_checkout,
        "checkoutLayout": checkout_layout,
        "scopeManifestPath": scope_manifest_path,
        "scopeConfigPath": scope_config_path,
        "scopeConfigExplicit": bool(scope_config_value),
        "scopeEntries": scope_entries,
        "scopeManifestConvention": convention_manifest,
        "checkoutScriptPath": checkout_script_path,
        "updatePolicy": update_policy,
        "username": shared_username,
    }


def require_capability(workspace: dict, name: str) -> None:
    capability = f"svn.{name}"
    if workspace.get("sourceMode") != "svn":
        raise SystemExit(f"{capability} is only available in SVN source mode")
    if not workspace.get("capabilities", {}).get(capability, False):
        raise SystemExit(f"Capability is disabled for {workspace['workspaceKey']}: {capability}")


@contextmanager
def operation_lock(workspace: dict, action: str, shared=False):
    lock_path = workspace["contextDir"] / ".svn-operation.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+b") as handle:
        try:
            if fcntl is not None:
                mode = fcntl.LOCK_SH if shared else fcntl.LOCK_EX
                fcntl.flock(handle.fileno(), mode | fcntl.LOCK_NB)
            else:  # Windows has no shared msvcrt lock; serialize all SVN operations.
                handle.seek(0)
                if not handle.read(1):
                    handle.seek(0)
                    handle.write(b"\0")
                    handle.flush()
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        except (BlockingIOError, OSError) as error:
            raise SystemExit(f"Another SVN operation is active for {workspace['workspaceKey']}") from error
        if not shared:
            handle.seek(0)
            handle.truncate()
            handle.write(f"{os.getpid()} {action}\n".encode("utf-8"))
            handle.flush()
        try:
            yield
        finally:
            if fcntl is not None:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            else:
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)


def _svn_auth(settings: dict, *, password_from_stdin=False) -> list[str]:
    args = []
    username = str(settings.get("username") or "").strip()
    if username:
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


def run_svn_binary(args, cwd: Path | None = None, check=True) -> subprocess.CompletedProcess:
    """Run a local SVN command without decoding its stdout.

    Source files may be UTF-8, GB18030, or BOM-prefixed Unicode.  Commands such
    as ``svn cat`` therefore have to return bytes so the shared source decoder
    can apply the same lossless rules used for the working copy.
    """

    try:
        result = subprocess.run(
            ["svn", *map(str, args)],
            cwd=str(cwd) if cwd else None,
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


def run_remote_svn(
    args,
    settings: dict,
    cwd: Path | None = None,
    check=True,
    password: str | None = None,
) -> subprocess.CompletedProcess:
    auth_args = _svn_auth(settings, password_from_stdin=password is not None)
    return run_svn(
        [*args, *auth_args],
        cwd=cwd,
        check=check,
        input_text=f"{password}\n" if password is not None else None,
    )


def run_remote_svn_binary(args, settings: dict, cwd: Path | None = None, check=True) -> subprocess.CompletedProcess:
    """Run an authenticated remote SVN command while preserving source bytes."""

    return run_svn_binary([*_svn_auth(settings), *args], cwd=cwd, check=check)


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
