"""SVN configuration normalization shared by workspace adapters.

Extracted from the existing SVN provider configuration contract. This module only
reads settings and paths; it does not load the SVN runtime or run SVN commands.
"""
from __future__ import annotations

import os
import re
from pathlib import Path
from urllib.parse import urlsplit
from common.workspace_identity import validate_config_id as validate_identity_id

SUPPORTED_INCLUDES = {"pages", "procedures", "system-script", "tables", "views"}


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
    "platform_save": False,
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
    "platform_save": True,
}


ENV_REFERENCE = re.compile(r"^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$")


def validate_config_id(config_id: str) -> None:
    try:
        validate_identity_id(config_id)
    except ValueError as error:
        raise SystemExit(str(error)) from error


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
    *,
    default_checkout_path: Path | None = None,
) -> dict:
    validate_config_id(config_id)
    svn = item.get("svn") or {}
    if not isinstance(svn, dict):
        raise SystemExit(f"svn must be a mapping for {config_id}")
    scope_manifest_value = str(svn.get("scope_manifest") or "").strip()
    # ``repository_url`` remains the legacy sparse checkout root. Manifest
    # configs use ``svn.url``; the default is one complete root working copy.
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
    if capabilities["platform_save"] and not all(capabilities[name] for name in ("edit", "status")):
        raise SystemExit(f"svn.platform_save requires edit and status for {config_id}")
    includes = svn.get("include") or ["pages", "procedures", "system-script"]
    if isinstance(includes, str):
        includes = [value.strip() for value in includes.strip("[]").split(",") if value.strip()]
    includes = list(dict.fromkeys(str(value).strip() for value in includes if str(value).strip()))
    invalid = set(includes) - SUPPORTED_INCLUDES
    if invalid:
        raise SystemExit(f"Unsupported SVN include for {config_id}: {', '.join(sorted(invalid))}")
    checkout_root_value = svn.get("checkout_root")
    if checkout_root_value in (None, "") and default_checkout_path is not None:
        checkout_root = default_checkout_path.parent.resolve()
        checkout_path = default_checkout_path.resolve()
    else:
        checkout_root = Path(
            expand_config_value(checkout_root_value, f"svn.checkout_root for {config_id}")
            if checkout_root_value not in (None, "")
            else var_dir / "checkout"
        ).expanduser().resolve()
        checkout_path = (checkout_root / config_id).resolve()
    if checkout_root in {Path("/").resolve(), Path.home().resolve()}:
        raise SystemExit(f"Unsafe svn.checkout_root for {config_id}: {checkout_root}")
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
    else:
        checkout_script_path = None
    update_policy = str(svn.get("update_policy") or "manual").strip().lower()
    if update_policy != "manual":
        raise SystemExit(f"svn.update_policy must be manual for {config_id}")
    legacy_auth_keys = {"username_env", "password_env", "no_auth_cache"} & set(svn)
    if legacy_auth_keys:
        raise SystemExit(
            "SVN 登录使用 svn.username，请删除以下旧配置："
            + ", ".join(sorted(legacy_auth_keys))
        )
    shared_username = ""
    if shared_svn is not None:
        if not isinstance(shared_svn, dict):
            raise SystemExit("sync.yaml 的 svn 必须是对象")
        shared_username = str(shared_svn.get("username") or "").strip()
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
        "credentialRef": str(svn.get("credential_ref") or ""),
        "username": expand_config_value(svn.get("username"), f"svn.username for {config_id}", allow_missing_env=True) or shared_username,
    }
