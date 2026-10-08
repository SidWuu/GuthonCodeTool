#!/usr/bin/env python3
"""Install the built suite in a temporary Windows CI home without business access."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile


def check(executable):
    if os.name != 'nt':
        raise SystemExit('Only Windows can execute the installer smoke check')
    with tempfile.TemporaryDirectory(prefix='guthon-installer-smoke-') as temporary:
        root = Path(temporary)
        home = root / '中文工作目录'
        application = root / 'GuthonCodeTool'
        log = root / 'setup.log'
        args = [str(executable), '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART',
                '/DIR=' + str(application), '/TOOLHOME=' + str(home),
                '/MARKETPLACEURL=https://example.invalid/guthon-team.git', '/LOG=' + str(log)]
        completed = subprocess.run(args, timeout=1800, check=False)
        if completed.returncode:
            print(log.read_text(encoding='utf-8-sig', errors='replace')[-16000:] if log.exists() else 'Setup log missing')
            raise SystemExit(f'Windows installer smoke failed: {completed.returncode}')
        report = json.loads((home / 'var/nexus/setup-result.json').read_text(encoding='utf-8'))
        if report.get('state') != 'environment-ready':
            raise SystemExit('Installer did not prepare the environment')
        if (home / 'var/.guthon/config.json').exists() or any((home / 'var/checkout').glob('*')):
            raise SystemExit('Installer crossed the plugin/business boundary')
        config = json.loads((home / 'Guthon.code-workspace').read_text(encoding='utf-8'))
        if not config['settings'].get('gushenCompletion.autoStartBridge'):
            raise SystemExit('Installed workspace lacks Bridge auto-start')
        print(json.dumps({'ok': True, 'version': report['version'], 'checks': 'compiled-setup,dependencies,nexus,empty-business-home,managed-bridge'}))
        uninstall = application / 'unins000.exe'
        if uninstall.exists():
            subprocess.run([str(uninstall), '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], check=True, timeout=120)
        if not (home / 'Guthon.code-workspace').exists():
            raise SystemExit('Uninstall removed user data')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--entry', required=True, type=Path)
    check(parser.parse_args().entry.resolve())
