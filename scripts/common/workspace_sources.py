"""Resolve provider source locations without loading or executing a provider."""
from __future__ import annotations

import json
from pathlib import Path
from common.svn_workspace_config import svn_settings
from common.svn_scope import load_authorized_scope
from common.runtime_paths import workspace_root


SOURCE_MODES = {'api', 'svn', 'database'}
DATABASE_CAPABILITIES = {
    'database.sourceSync': True, 'database.schemaExport': True,
    'database.billTypeExport': True, 'database.systemScriptExport': True,
    'database.viewExport': True, 'database.diagnose': True,
    'source.reindex': True, 'workcopy.open': True,
}


def legacy_mode(root, key, item):
    path = root / 'context/source-mode.json'
    if path.is_file():
        value = json.loads(path.read_text(encoding='utf-8'))
        if (not isinstance(value, dict) or type(value.get('version')) is not int
                or value['version'] != 1 or value.get('workspaceKey') != key):
            raise ValueError('source mode identity/version mismatch')
        mode, source = value.get('sourceMode'), 'workspace-context'
    else:
        mode = str(item.get('source_mode') or 'database').strip().lower()
        source = 'legacy-config' if item.get('source_mode') else 'default'
    if mode not in {'svn', 'database'}:
        raise ValueError('旧配置 sourceMode 必须为 svn 或 database')
    return mode, source


def resolve_sources(home, root, key, config_id, item, mode, config, *, project_checkout=False):
    """Keep physical SVN/readonly/workcopy paths and configured capabilities distinct."""
    if mode == 'api':
        checkout = root / 'checkout'
        return {'providerSourceRoot': checkout, 'checkoutPath': checkout,
                'sourceRoots': [{'role': 'api-checkout', 'path': checkout}],
                'providerCapabilities': {name: True for name in (
                    'api.configure', 'api.pull', 'api.status', 'api.edit', 'api.upload',
                    'source.read', 'source.index', 'source.reindex', 'source.edit', 'database.diagnose')}}
    if mode == 'database':
        readonly, workcopy = root / 'source/readonly', root / 'source/workcopy'
        return {'providerSourceRoot': readonly, 'checkoutPath': None,
                'sourceDir': root / 'source', 'readonlyDir': readonly,
                'workcopyDir': workcopy, 'databaseDir': root / 'database',
                'sourceRoots': [{'role': 'readonly', 'path': readonly},
                                {'role': 'workcopy', 'path': workcopy}],
                'providerCapabilities': dict(DATABASE_CAPABILITIES)}
    settings = svn_settings(config_id, item, workspace_root(home), root, config.get('sync', {}).get('svn', {}),
                            default_checkout_path=root / 'checkout' if project_checkout else None)
    checkout = settings['checkoutPath']
    # Explicit storage overrides are not inferred from a neutral key or a directory name.
    paths = item.get('paths', {})
    if paths.get('checkoutPath'):
        checkout = Path(paths['checkoutPath']).expanduser().resolve()
        settings['checkoutPath'] = checkout
    if checkout == root or checkout in root.parents or (root in checkout.parents and checkout != root / 'checkout'):
        raise ValueError('SVN checkout 与项目元数据目录必须分开')
    roots = [{'role': 'svn-checkout', 'path': checkout}]
    manifest = settings['scopeManifestPath']
    if manifest and manifest.is_file():
        scope = load_authorized_scope({'workspaceKey': key, 'svn': settings, 'checkoutPath': checkout})
        roots = [{'role': 'svn-working-copy', 'id': entry.id, 'path': entry.root} for entry in scope.entries]
        settings['scopeDigest'] = scope.digest
    return {'providerSourceRoot': checkout, 'checkoutPath': checkout, 'svn': settings,
            'sourceRoots': roots,
            'providerCapabilities': {f'svn.{name}': enabled for name, enabled in settings['capabilities'].items()}}
