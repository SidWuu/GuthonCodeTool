"""Three-way text merge shared by source providers."""

from difflib import SequenceMatcher


def merge_text(base, local, remote, conflicts=None):
    if local == base or local == remote:
        return remote
    if remote == base:
        return local
    original = base.splitlines(keepends=True)
    edits = []
    for text in (local, remote):
        lines = text.splitlines(keepends=True)
        for tag, a, b, c, d in SequenceMatcher(None, original, lines, autojunk=False).get_opcodes():
            candidate = (a, b, lines[c:d])
            if tag != "equal" and candidate not in edits:
                edits.append(candidate)
    edits.sort(key=lambda edit: (edit[0], edit[1]))
    overlaps = [right[0] + 1 for left, right in zip(edits, edits[1:])
                if right[0] < left[1] or right[0] == left[0]]
    if overlaps:
        if conflicts is not None:
            conflicts.extend(dict.fromkeys(overlaps))
        return None
    result = []
    cursor = 0
    for start, end, lines in edits:
        result.extend(original[cursor:start])
        result.extend(lines)
        cursor = end
    result.extend(original[cursor:])
    return "".join(result)
