"""Bounded, source-hash-bound raw and semantic PAGE comparisons."""
from decimal import Decimal, DecimalException
from pathlib import PurePosixPath
import json
import math
import re

from common.page_comparison import compare_pages
from common.page_projection import extract_page_scripts
from .client import ApiError
from .content import source_name
from .index import _page_data, page_format
from .store import ApiStore, digest


def _page_views(before, after, metadata, *, conflict=False):
    def check_float(token):
        value = float(token)
        try:
            exact = Decimal(token)
        except DecimalException as error:
            raise ValueError('PAGE 浮点数无法准确比较') from error
        if not math.isfinite(value) or not exact.is_finite() or exact != Decimal(str(value)):
            raise ValueError('PAGE 浮点数无法准确比较')
        return value

    def check_source(text):
        if text.lstrip('\ufeff \t\r\n').startswith('<'):
            # Inspect exactly the scalar values the native XML decoder turns
            # into floats, including numbers inside native attribute maps.
            from .native_page import _snapshot
            pending = [_snapshot(text)[1]]
            while pending:
                item = pending.pop()
                if item.kind == 'scalar' and isinstance(item.value, float):
                    check_float(''.join(item.node.text))
                if item.inner is not None:
                    pending.append(item.inner)
                if isinstance(item.children, dict):
                    pending.extend(item.children.values())
                elif isinstance(item.children, list):
                    pending.extend(item.children)
            return
        def unique(pairs):
            result = {}
            for key, value in pairs:
                if key in result:
                    raise ValueError('PAGE JSON 存在重复属性，身份或内容不明确')
                result[key] = value
            return result
        def reject_constant(value):
            raise ValueError('PAGE JSON 数值无效：' + value)
        options = {'object_pairs_hook': unique, 'parse_constant': reject_constant, 'parse_float': check_float}
        data = json.loads(text, **options)
        if isinstance(data, str):
            json.loads(data, **options)

    check_source(before)
    check_source(after)
    original = _page_data(before, metadata['pageId'])
    current = _page_data(after, metadata['pageId'])
    if conflict:
        from .page_source import normalize_saved_model
        original = normalize_saved_model(original)
        current = normalize_saved_model(current)
    changes = compare_pages(original, current, limit=10000)
    if changes['truncated']:
        raise ValueError('语义变化超过10000项，改用原始源码对比')
    old_scripts = {item.json_pointer: item for item in extract_page_scripts(original, include_empty_inherited=True)}
    new_scripts = {item.json_pointer: item for item in extract_page_scripts(current, include_empty_inherited=True)}
    left, right = ['# PAGE 可读差异'], ['# PAGE 可读差异']
    labels = {'added': '新增', 'removed': '删除', 'modified': '修改', 'order': '排序'}

    def append(kind, label, pointer, before_text, after_text, language):
        heading = ['', '## ' + labels[kind] + ' · ' + label, '@json-pointer ' + pointer]
        for output, text in ((left, before_text), (right, after_text)):
            if language != 'json':
                text = text.replace('\r\n', '\n').replace('\r', '\n')
            longest = max([2, *[len(part) for part in re.findall(r'`+', text)]])
            fence = '`' * (longest + 1)
            output.extend([*heading, fence + language, text, fence])

    def script_language(script):
        return {'sql': 'sql', 'js': 'javascript', 'vm': 'guthon-gss'}.get(script.script_type, 'guthon-gss')

    for row in changes['rows']:
        old_script = old_scripts.get(row['beforePointer'])
        new_script = new_scripts.get(row['pointer'])
        script = new_script or old_script
        before_text = old_script.original_value if old_script else row['beforeText']
        after_text = new_script.original_value if new_script else row['afterText']
        language = script_language(script) if script else (
            'sql' if row['pointer'].rsplit('/', 1)[-1] == 'superSql' else 'json'
        )
        append(row['kind'], row['label'], row['pointer'], before_text, after_text, language)
        # Added/removed containers are one semantic row; expose their scripts as
        # separate readable fragments without guessing identities for arrays.
        if row['kind'] in {'added', 'removed'} and not script:
            scripts = new_scripts if row['kind'] == 'added' else old_scripts
            root = row['pointer'] if row['kind'] == 'added' else row['beforePointer']
            for pointer, fragment in scripts.items():
                if pointer.startswith(root + '/'):
                    append(row['kind'], fragment.display_name, pointer,
                           '（不存在）' if row['kind'] == 'added' else fragment.original_value,
                           fragment.original_value if row['kind'] == 'added' else '（已删除）',
                           script_language(fragment))
        elif row['kind'] == 'modified' and not script:
            # A whole ambiguous collection can change without safe element pairing.
            # Show each side's scripts independently, alongside the original row.
            for side, scripts, root in (('原侧', old_scripts, row['beforePointer']),
                                        ('现侧', new_scripts, row['pointer'])):
                for pointer, fragment in scripts.items():
                    if pointer.startswith(root + '/'):
                        append('modified', side + '脚本（未配对） · ' + fragment.display_name, pointer,
                               fragment.original_value if side == '原侧' else '（未配对）',
                               fragment.original_value if side == '现侧' else '（未配对）',
                               script_language(fragment))
    if not changes['rows']:
        note = ('可读内容一致。原文格式、键顺序或平台默认值写法可能不同，可选择原始源码对比。'
                if conflict else '语义内容一致；原文格式或键顺序可能不同，可选择原始源码对比。')
        left.append(note)
        right.append(note)
    return '\n'.join(left) + '\n', '\n'.join(right) + '\n', changes['total']


def read_diff(workspace, path, *, view='auto', offset=0, max_chars=50000, conflict=False):
    if view not in {'auto', 'raw', 'readable'} or type(offset) is not int or offset < 0 or type(max_chars) is not int or not 1 <= max_chars <= 50000:
        raise ApiError('API_INPUT_INVALID', '差异视图或分页参数无效')
    store = ApiStore(workspace)
    if conflict:
        record = store.conflict(path)
        before, after = record['local'], record['remote']
        if digest(after) != record['remoteHash']:
            raise ApiError('API_SOURCE_CHANGED', '冲突的平台原文与版本记录不一致，请重新同步')
        metadata = record['metadata']
        item = {'path': path, 'name': source_name(metadata), 'metadata': metadata, 'content': after}
        versions = {'sourceHash': record['sourceHash'], 'remoteHash': record['remoteHash']}
    else:
        item = store.read(path)
        before, after = store.baseline(path), item['content']
        if digest(before) != item['baseHash']:
            raise ApiError('API_SOURCE_CHANGED', '差异读取期间基线已变化，请重新比较')
        versions = {'sourceHash': item['sourceHash'], 'baseHash': item['baseHash']}
    readable, message, total_changes = False, '', None
    if view != 'raw' and item['metadata'].get('sourceType') == 'page':
        try:
            page_kind = page_format(item)
            if page_kind in {'json', 'native-xml'}:
                before, after, total_changes = _page_views(before, after, item['metadata'], conflict=conflict)
                readable = True
            elif page_kind == 'unsupported-xml':
                message = 'PAGE 格式不支持可读投影，显示原始源码'
        except (ValueError, TypeError, RecursionError) as error:
            message = 'PAGE 可读投影不可用，显示原始源码：' + str(error)
    suffix = PurePosixPath(path).suffix.lower()
    language = 'markdown' if readable else {'.json': 'json', '.xml': 'xml', '.gss': 'guthon-gss', '.js': 'javascript', '.sql': 'sql'}.get(suffix, 'plaintext')
    total = max(len(before), len(after))
    end = offset + max_chars
    return {'path': path, 'name': item['name'], 'sourceType': item['metadata'].get('sourceType'), **versions,
            'before': before[offset:end], 'after': after[offset:end], 'offset': offset,
            'nextOffset': end if end < total else None, 'totalBeforeChars': len(before),
            'totalAfterChars': len(after), 'truncated': end < total,
            'view': 'readable' if readable else 'raw', 'language': language, 'message': message,
            'totalChanges': total_changes, 'formattingIgnored': readable, 'readonly': True}
