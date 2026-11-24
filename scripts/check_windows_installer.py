#!/usr/bin/env python3
"""Install the built suite in a temporary Windows CI home without business access."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import zipfile

from common.installer_downloads import fetch
from installer.engine import NEXUS_ID
from installer.ide import find_ides

# Microsoft's stable Windows ZIP and SHA-256 from the VS Code update API.
VSCODE_URL = ('https://vscode.download.prss.microsoft.com/dbazure/download/stable/'
              '8a14f0cc1b08d531eb83255ea3764ae22aa932b5/VSCode-win32-x64-1.147.0.zip')
VSCODE_SHA256 = '42d65f18009959964d7cff8ca6f33149a195d52c08622821c8c681a08469c26e'


def check(executable):
    if os.name != 'nt':
        raise SystemExit('Only Windows can execute the installer smoke check')
    with tempfile.TemporaryDirectory(prefix='guthon-') as temporary:
        root = Path(temporary)
        archive = root / 'vscode.zip'
        ide_root = root / 'VS Code 测试'
        fetch(VSCODE_URL, VSCODE_SHA256, archive, limit=512 * 1024 * 1024)
        with zipfile.ZipFile(archive) as package:
            package.extractall(ide_root)
        (ide_root / 'data').mkdir()
        ide, cli = find_ides(ide_root)['vscode']
        if ide.parent != ide_root:
            raise SystemExit('The portable VS Code was not detected')
        home = root / '中文工作目录'
        application = root / 'GuthonCodeTool'
        log = root / 'setup.log'
        rules = home / 'var/rules'
        rules.mkdir(parents=True)
        manual = {rules.parent / 'AGENTS.md': '# 部门规则\n', rules / 'department.md': '# 部门开发规范\n'}
        for file, content in manual.items():
            file.write_text(content, encoding='utf-8')
        args = [str(executable), '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART',
                '/DIR=' + str(application), '/TOOLHOME=' + str(home), '/IDEROOT=' + str(ide_root),
                '/LOG=' + str(log)]
        env = os.environ.copy()
        env.pop('GUTHON_TEAM_MARKETPLACE_URL', None)
        completed = subprocess.run(args, timeout=1800, check=False, env=env)
        if completed.returncode:
            print(log.read_text(encoding='utf-8-sig', errors='replace')[-16000:] if log.exists() else 'Setup log missing')
            raise SystemExit(f'Windows installer smoke failed: {completed.returncode}')
        report = json.loads((home / 'var/nexus/setup-result.json').read_text(encoding='utf-8'))
        if report.get('state') != 'environment-ready':
            raise SystemExit('Installer did not prepare the environment')
        if [item['id'] for item in report['ides']] != ['vscode'] or Path(report['ides'][0]['executable']) != ide:
            raise SystemExit('Setup did not select the portable VS Code')
        listing = subprocess.check_output(
            [str(ide), str(cli), '--list-extensions', '--show-versions'],
            text=True, encoding='utf-8', timeout=60, env={**env, 'ELECTRON_RUN_AS_NODE': '1'},
        )
        expected = f"{NEXUS_ID}@{report['nexusVersion']}"
        if expected.lower() not in {line.strip().lower() for line in listing.splitlines()}:
            raise SystemExit('Portable VS Code did not report the expected Nexus version')
        settings = json.loads((home / 'var/.codebuddy/settings.json').read_text(encoding='utf-8'))
        if (report.get('marketplaceUrl') or 'guthon-team' in settings.get('extraKnownMarketplaces', {})
                or 'guthon-guard@guthon-team' in settings.get('enabledPlugins', {})):
            raise SystemExit('Blank marketplace address must not configure guthon-team')
        if any(file.read_text(encoding='utf-8') != content for file, content in manual.items()):
            raise SystemExit('Installation changed manually supplied department rules')
        if (home / 'var/.guthon/config.json').exists() or any((home / 'var').glob('*/checkout/*')):
            raise SystemExit('Installer crossed the plugin/business boundary')
        config = json.loads((home / 'Guthon.code-workspace').read_text(encoding='utf-8'))
        if config['settings'].get('gushenCompletion.autoStartBridge') is not False:
            raise SystemExit('Installed workspace must keep Bridge opt-in')
        if (home / 'var/.mcp.json').exists():
            raise SystemExit('Installer unexpectedly configured a source MCP for a workspace without projects')
        print(json.dumps({'ok': True, 'version': report['version'],
                          'checks': 'compiled-setup,dependencies,vscode-nexus,skip-marketplace,preserve-manual-rules,empty-business-home,opt-in-bridge'}))
        uninstall = application / 'unins000.exe'
        if uninstall.exists():
            subprocess.run([str(uninstall), '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], check=True, timeout=120)
        if not (home / 'Guthon.code-workspace').exists():
            raise SystemExit('Uninstall removed user data')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--entry', required=True, type=Path)
    check(parser.parse_args().entry.resolve())
