"""One lexical identity contract shared by configuration, routing and providers."""
import re
import json
from importlib.resources import files
CONFIG_ID_PATTERN = json.loads(files('common').joinpath('command_metadata.json').read_text(encoding='utf-8'))['configIdPattern']
WORKSPACE_KEY_PATTERN = r'^(?:products|projects)\.' + CONFIG_ID_PATTERN + r'$'
CONFIG_ID = re.compile(r'^' + CONFIG_ID_PATTERN + r'$')
WORKSPACE_KEY = re.compile(WORKSPACE_KEY_PATTERN)


def validate_config_id(value):
    if isinstance(value,bool):raise ValueError('Workspace config IDs cannot be YAML booleans; quote the key')
    text=str(value or '')
    if not CONFIG_ID.fullmatch(text):raise ValueError(f'Unsafe workspace config id: {value}')
    return text


def validate_workspace_key(value):
    if not isinstance(value,str) or not WORKSPACE_KEY.fullmatch(value):
        raise ValueError('workspaceKey must be products.<id> or projects.<id> with a safe explicit ID')
    return value
