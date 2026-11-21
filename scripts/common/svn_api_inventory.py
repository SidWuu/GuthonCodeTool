"""Compare stable identities across the SVN and API source representations."""

from __future__ import annotations

import hashlib
from collections import defaultdict
from pathlib import Path

from providers.svn import checkout


def svn_objects(workspace, checked):
    if workspace['svn']['checkoutLayout'] == 'manifest-working-copies':
        from providers.svn.nexus import catalog
        scan = catalog.scan(workspace, collect_modules=False)
        if {item['id'] for item in scan['status']['workingCopies']} != {
            item['id'] for item in checked['workingCopies']
        }:
            raise ValueError('SVN 索引扫描跳过了部分授权 working copy')
    else:
        from providers.svn import scanner
        scan = scanner.scan(workspace['checkoutPath'], checkout.load_scope(workspace))
    if scan['errors']:
        raise ValueError('SVN 全范围源码清单有错误：' + str(scan['errors'][0]))
    output = {}
    for row in scan['objects']:
        kind, path = row['source_table'], row['source_path']
        if (kind == 'procedure' and path.casefold().endswith('.inherit.gss')
                and workspace['svn']['checkoutLayout'] == 'legacy-sparse'):
            from providers.svn.nexus import catalog
            from common.svn_scope import ScopeEntry

            root = workspace['checkoutPath']
            entry = ScopeEntry(id='sparse', category='root', url='', local_subdir='.',
                               root=root, writable=False)
            row = catalog._procedure_object(entry, root / path, {}, {})
            kind = row['source_table']
        if row['status'] != 'OK':
            raise ValueError(f'SVN 清单存在待处理对象：{path} ({row["status"]})')
        if kind in {'page', 'page-inherit'}:
            owner, name = row['system_id'], (row['source_id'],)
        elif kind.startswith('procedure'):
            owner = row['data_source_id']
            name = (row['source_alias_id'], row['fun_id'])
        elif kind in {'table', 'view'}:
            owner, name = row['data_source_id'], (row['source_id'],)
        elif kind == 'system-script':
            script_type = Path(path).stem
            if script_type.endswith('.inherit'):
                kind = 'system-script-inherit'
                script_type = script_type.removesuffix('.inherit')
            owner, name = row['system_id'], (script_type,)
        elif kind in {'skill', 'public'}:
            owner, name = 'project', (path,)
        else:
            raise ValueError(f'SVN 对象类型缺少已核验的 API 映射：{kind} {path}')
        identity = (kind, owner, *name)
        # Procedures at the data-source root have an empty package alias.
        if not owner or not name[-1] or identity in output:
            raise ValueError(f'SVN 对象身份缺失或有歧义：{path}')
        output[identity] = {'path': path, 'sha256': row['source_hash']}
    return output


def api_identity(file):
    meta, kind = file.metadata, file.kind
    if kind in {'page', 'page-inherit'}:
        return kind, str(meta['systemId']), str(meta['pageId'])
    if kind in {'procedure', 'procedure-inherit'}:
        return kind, str(meta['dataSourceId']), str(meta['procedureAliasId']), str(meta['funId'])
    if kind in {'table', 'view'}:
        return kind, str(meta['dataSourceId']), str(meta[kind + 'Id'])
    if kind in {'system-script', 'system-script-inherit'}:
        return kind, str(meta['systemId']), str(meta['scriptType'])
    if kind in {'skill', 'config'}:
        return ('public' if kind == 'config' and file.path.startswith('public/') else kind,
                'project', file.path)
    return None


def compare(old_objects, files):
    targets = defaultdict(list)
    for file in files:
        identity = api_identity(file)
        if identity:
            targets[identity].append(file)
    exact, manual, blockers, additional = [], [], [], []
    for identity, old in sorted(old_objects.items()):
        matches = targets.pop(identity, [])
        entry = {'identity': list(identity), 'svn': old}
        if len(matches) != 1:
            blockers.append({**entry, 'code': 'API_OBJECT_MISSING' if not matches else 'API_OBJECT_AMBIGUOUS',
                             'apiPaths': [file.path for file in matches]})
            continue
        file = matches[0]
        entry['api'] = {'path': file.path, 'sha256': hashlib.sha256(file.content.encode()).hexdigest()}
        (exact if old['sha256'] == entry['api']['sha256'] else manual).append(entry)
    for identity, matches in sorted(targets.items()):
        entry = {'identity': list(identity), 'apiPaths': [file.path for file in matches]}
        if len(matches) == 1:
            additional.append(entry)
        else:
            blockers.append({**entry, 'code': 'API_OBJECT_AMBIGUOUS'})
    return {'byteIdentical': exact, 'requiresManualReview': manual, 'apiOnlyObjects': additional,
            'blockers': blockers}
