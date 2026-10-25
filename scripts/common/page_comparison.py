"""Read-only semantic PAGE differences, with native identities across array moves."""
import json


def compare_pages(before, after, *, limit=1000):
    rows, paths, total = [], set(), 0
    def token(key):
        return str(key).replace('~', '~0').replace('/', '~1')
    def identity(value):
        if not isinstance(value, dict):
            return None
        for key in ('id', 'fieldId', 'guid', 'name'):
            if isinstance(value.get(key), str) and value[key].strip():
                return key + ':' + value[key]
        return identity(value.get('component'))
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
            code = old_path.rsplit('/', 1)[-1].endswith('Script') or new_path.rsplit('/', 1)[-1] == 'sql'
            display = lambda value: value if code and isinstance(value, str) else json.dumps(value, ensure_ascii=False, indent=2)
            rows.append({'kind': kind, 'pointer': new_path, 'beforePointer': old_path,
                         'anchor': parent if kind == 'removed' else new_path, 'label': label,
                         'beforeText': '（不存在）' if kind == 'added' else display(old),
                         'afterText': '（已删除）' if kind == 'removed' else display(new)})
    def walk(old, new, old_path, new_path, label='', parent=''):
        # Python compares large integers exactly; never round native IDs or opaque numbers through JS.
        if (type(old) is type(new) and old == new
                and json.dumps(old, sort_keys=True) == json.dumps(new, sort_keys=True)):
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
            left_keys, right_keys = [identity(v) for v in old], [identity(v) for v in new]
            stable = (all(left_keys) and all(right_keys) and len(set(left_keys)) == len(left_keys)
                      and len(set(right_keys)) == len(right_keys))
            if stable:
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
