#!/usr/bin/env python3
"""Choose a full release or component refresh from the last published source."""
import json
import os
import re
import subprocess
from pathlib import Path

MARKER = re.compile(r'<!-- guthon-release-source: ([a-f0-9]{40}) -->')


def classify(paths):
    selected = set()
    for name in paths:
        if name.startswith('plugins/GuthonBridge/'):
            selected.add('bridge')
            if name.startswith('plugins/GuthonBridge/bridge/'):
                selected.add('nexus')  # Nexus ships the local Bridge server.
        elif name.startswith('plugins/GuthonNexus/'):
            selected.add('nexus')
        elif name.startswith('skills/guthon-testing/'):
            selected.add('skill')
        elif name.startswith(('docs/', 'tests/')) or name in ('README.md', 'AGENTS.md', 'AI_CODE_INDEX.md'):
            continue
        else:
            return 'full', {'bridge', 'nexus', 'skill'}
    return ('components' if selected else 'none'), selected


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def main():
    version = Path('VERSION').read_text().strip()
    if not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise SystemExit('Invalid VERSION')
    tag = 'v' + version
    head = run('git', 'rev-parse', 'HEAD')
    mode, selected = 'full', {'bridge', 'nexus', 'skill'}
    try:
        release = json.loads(run('gh', 'release', 'view', tag, '--json', 'body,isDraft,isPrerelease', '--repo', os.environ['GITHUB_REPOSITORY']))
    except subprocess.CalledProcessError:
        # A missing release requires all assets. Authentication/API failures must
        # not silently become a new publication.
        releases = json.loads(run('gh', 'api', 'repos/' + os.environ['GITHUB_REPOSITORY'] + '/releases?per_page=100'))
        if any(item['tag_name'] == tag for item in releases):
            raise SystemExit('Existing release could not be read')
        release = None
    if release and os.environ.get('RELEASE_MODE', 'auto') != 'full':
        if release['isDraft'] or release['isPrerelease']:
            raise SystemExit('Component refresh requires an existing stable published release')
        marker = MARKER.search(release['body'] or '')
        base = marker.group(1) if marker else run('git', 'rev-list', '-n', '1', tag)
        subprocess.run(['git', 'merge-base', '--is-ancestor', base, head], check=True)
        names = subprocess.check_output(['git', 'diff', '--no-renames', '--name-only', '-z', base, head]).decode().split('\0')
        mode, selected = classify([name for name in names if name])
    output = {'mode': mode, 'version': version, 'tag': tag}
    output.update({name: str(name in selected).lower() for name in ('bridge', 'nexus', 'skill')})
    with open(os.environ['GITHUB_OUTPUT'], 'a') as stream:
        for key, value in output.items():
            stream.write(f'{key}={value}\n')
    print(json.dumps(output))


if __name__ == '__main__':
    main()
