"""Read-only semantic PAGE differences, with native identities across array moves."""
import json

from common.page_projection import json_pointer, pointer_parts


def _identity(value):
    if not isinstance(value, dict):
        return None
    for key in ('id', 'fieldId', 'guid', 'name'):
        if isinstance(value.get(key), str) and value[key].strip():
            return key + ':' + value[key]
    return _identity(value.get('component'))


def _array_keys(before, after):
    left, right = [_identity(value) for value in before], [_identity(value) for value in after]
    if all(left) and all(right) and len(set(left)) == len(left) and len(set(right)) == len(right):
        return left, right
    return None


def baseline_pointer(before, after, pointer):
    """Resolve a current PAGE pointer against the same native node in the baseline."""
    parts = []
    for part in pointer_parts(pointer):
        if isinstance(before, list) and isinstance(after, list):
            index = int(part)
            keys = _array_keys(before, after)
            if keys:
                left, right = keys
                if right[index] not in left:
                    return None
                old_index = left.index(right[index])
            elif len(before) == len(after):
                old_index = index
            else:
                return None
            parts.append(old_index)
            before, after = before[old_index], after[index]
        elif isinstance(before, dict) and isinstance(after, dict) and part in before:
            parts.append(part)
            before, after = before[part], after[part]
        else:
            return None
    return json_pointer(parts)


def same_json_value(before, after):
    """Ignore object key order while keeping JSON types and exact integers."""
    return (type(before) is type(after) and before == after
            and json.dumps(before, sort_keys=True) == json.dumps(after, sort_keys=True))


def compare_pages(before, after, *, limit=1000):
    rows, paths, total = [], set(), 0
    def token(key):
        return str(key).replace('~', '~0').replace('/', '~1')
    def caption(value):
        if not isinstance(value, dict):
            return ''
        return next((value[key] for key in ('label', 'disName', 'name', 'fieldId')
                     if isinstance(value.get(key), str) and value[key].strip()), '')
    def emit(kind, old, new, old_path, new_path, label, parent):
        nonlocal total
        total += 1
        paths.add(parent if kind == 'removed' else new_path)
        if len(rows) < limit:
            key = new_path.rsplit('/', 1)[-1]
            code = key.endswith('Script') or key in {'sql', 'superSql'}
            display = lambda value: value if code and isinstance(value, str) else json.dumps(value, ensure_ascii=False, indent=2)
            rows.append({'kind': kind, 'pointer': new_path, 'beforePointer': old_path,
                         'anchor': parent if kind == 'removed' else new_path, 'label': label,
                         'beforeText': '（不存在）' if kind == 'added' else display(old),
                         'afterText': '（已删除）' if kind == 'removed' else display(new)})
    def walk(old, new, old_path, new_path, label='', parent=''):
        if same_json_value(old, new):
            return
        label = caption(new) or caption(old) or label
        if isinstance(old, dict) and isinstance(new, dict):
            for key in dict.fromkeys([*old, *new]):
                left, right = old_path+'/'+token(key), new_path+'/'+token(key)
                name = f'{label} / {key}' if label else key
                if key not in old:
                    emit('added', None, new[key], left, right, name, new_path)
                elif key not in new:
                    emit('removed', old[key], None, left, right, name, new_path)
                else:
                    walk(old[key], new[key], left, right, name, new_path)
        elif isinstance(old, list) and isinstance(new, list):
            keys = _array_keys(old, new)
            if keys:
                left_keys, right_keys = keys
                left_map = {key: i for i, key in enumerate(left_keys)}
                right_map = {key: i for i, key in enumerate(right_keys)}
                common = set(left_keys) & set(right_keys)
                if [k for k in left_keys if k in common] != [k for k in right_keys if k in common]:
                    # Display captions instead of internal button GUIDs in the order summary.
                    emit('order', [caption(v) or f'第 {i+1} 项' for i, v in enumerate(old)],
                         [caption(v) or f'第 {i+1} 项' for i, v in enumerate(new)], old_path, new_path, label+' / 顺序', parent)
                    for key in common:
                        if left_map[key] != right_map[key]:
                            paths.add(new_path+'/'+str(right_map[key]))
                for key in dict.fromkeys([*left_keys, *right_keys]):
                    i, j = left_map.get(key), right_map.get(key)
                    left = old_path+'/'+str(i) if i is not None else old_path
                    right = new_path+'/'+str(j) if j is not None else new_path
                    if i is None:
                        emit('added', None, new[j], left, right, caption(new[j]) or label, new_path)
                    elif j is None:
                        emit('removed', old[i], None, left, right, caption(old[i]) or label, new_path)
                    else:
                        walk(old[i], new[j], left, right, label, new_path)
            elif len(old) == len(new):
                for i, (left, right) in enumerate(zip(old, new)):
                    walk(left, right, old_path+'/'+str(i), new_path+'/'+str(i), label, new_path)
            else:
                # Anonymous/ambiguous arrays are compared as a unit, never paired by guessed identity.
                emit('modified', old, new, old_path, new_path, label+' / 集合', parent)
        else:
            emit('modified', old, new, old_path, new_path, label, parent)
    walk(before, after, '', '')
    return {'rows': rows, 'paths': sorted(paths), 'total': total, 'truncated': total > len(rows)}
