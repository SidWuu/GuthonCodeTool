#!/usr/bin/env python3
"""Prepare checksum metadata and record the exact published source revision."""
import argparse
import hashlib
import re
from pathlib import Path

MARKER = re.compile(r'<!-- guthon-release-source: [a-f0-9]{40} -->')
CHECKSUMS = 'GuthonCodeTool-checksums.txt'
SIGNATURE = 'GuthonCodeTool-checksums.signature.json'


def refresh_checksums(root):
    old = (root / CHECKSUMS).read_text()
    names = []
    for line in old.splitlines():
        match = re.fullmatch(r'[a-f0-9]{64}  ([A-Za-z0-9][A-Za-z0-9_.-]{0,199})', line)
        if not match or match[1] in names or match[1] in (CHECKSUMS, SIGNATURE):
            raise ValueError('Invalid existing checksum metadata')
        names.append(match[1])
    expected = {'GuthonCodeTool-release.json', 'GuthonCodeTool-chrome.zip', 'guthon-nexus-vscode.vsix', 'guthon-testing.zip'}
    if not expected.issubset(names):
        raise ValueError('Current release lacks component metadata; run a full release first')
    lines = []
    for name in names:
        file = root / name
        if file.is_symlink() or not file.is_file():
            raise ValueError('Invalid asset: ' + name)
        with file.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        lines.append(f'{digest}  {name}\n')
    (root / CHECKSUMS).write_text(''.join(lines))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--release-dir', type=Path)
    parser.add_argument('--notes', type=Path, required=True)
    parser.add_argument('--sha', required=True)
    parser.add_argument('--components', default='')
    args = parser.parse_args()
    if not re.fullmatch(r'[a-f0-9]{40}', args.sha):
        raise ValueError('Invalid commit SHA')
    if args.release_dir:
        refresh_checksums(args.release_dir)
    notes = MARKER.sub('', args.notes.read_text()).rstrip()
    if args.components:
        notes += '\n\n组件更新：' + args.components + '（应用和安装器保持原附件）。'
    args.notes.write_text(notes + '\n\n<!-- guthon-release-source: ' + args.sha + ' -->\n')


if __name__ == '__main__':
    main()
