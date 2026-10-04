"""Explicit encrypted transfer of registered keyring entries; no plaintext files."""
from __future__ import annotations
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from common import database_readonly as readonly, database_test_artifacts as artifacts
from common.persistence import file_lock


def bindings(tool_config, config, workspace_key):
    owned={};others=set()
    for key,workspace in config.get('databaseTests',{}).items():
        for target in workspace.get('targets',[]):
            connection=config.get('connections',{}).get(target.get('connectionRef'),{})
            ref=connection.get('credentialRef')
            if not ref:continue
            if key!=workspace_key:others.add(ref);continue
            metadata={name:connection.get(name) for name in ('engine','host','port','database','schema','username','credentialRef')}
            owned.setdefault(ref,[]).append({'targetId':target['id'],'connection':metadata})
    for identifier,source in (tool_config.get('datasource',{}).get('datasource') or {}).items():
        ref=source.get('credentialRef')
        if not ref:continue
        if source.get('object')!=workspace_key:others.add(ref);continue
        metadata={name:source.get(name) for name in ('type','host','port','database','schema','username','credentialRef')}
        owned.setdefault(ref,[]).append({'datasourceId':str(identifier),'connection':metadata})
    return owned,others


def crypto(operation,payload,passphrase,node_path=''):
    from guthon_tool import bundled_bytes
    executable=node_path or shutil.which('node')
    if not executable or not Path(executable).is_absolute() or not Path(executable).is_file():
        raise readonly.DatabaseReadonlyError('DRIVER_MISSING','Credential transfer requires an explicit local Node executable')
    if not isinstance(passphrase,str) or not 12<=len(passphrase)<=4096:
        raise readonly.DatabaseReadonlyError('CONFIG_INVALID','Vault passphrase must contain 12–4096 characters')
    with tempfile.TemporaryDirectory(prefix='guthon-vault-code-') as directory:
        script=Path(directory)/'vault_crypto.mjs';script.write_bytes(bundled_bytes('scripts/vault_crypto.mjs'))
        environment={key:os.environ[key] for key in ('PATH','SystemRoot','WINDIR','TMP','TEMP') if key in os.environ}
        environment['ELECTRON_RUN_AS_NODE']='1'
        result=subprocess.run([str(executable),str(script)],input=json.dumps({'operation':operation,'payload':payload,'passphrase':passphrase}),
                              capture_output=True,text=True,encoding='utf-8',timeout=30,env=environment)
    if result.returncode or len(result.stdout)>1_048_576:
        raise readonly.DatabaseReadonlyError('VAULT_AUTHENTICATION_FAILED','Vault data or passphrase is invalid; no credentials were imported')
    return json.loads(result.stdout)


def transfer(tool_config, config, workspace, *, vault, refs, passphrase, importing=False, confirmation='', node_path=''):
    key=workspace['workspaceKey'];owned,other_refs=bindings(tool_config,config,key)
    if confirmation!=key or not refs or len(refs)>20 or len(refs)!=len(set(refs)) or any(ref not in owned for ref in refs):
        raise readonly.DatabaseReadonlyError('CONFIRMATION_REQUIRED','Select 1–20 exact registered credential refs and confirm the workspaceKey')
    file=Path(vault).expanduser().resolve()
    mapping_digest=artifacts.digest({ref:owned[ref] for ref in sorted(refs)})
    if not importing:
        from guthon_tool import SOURCE_ROOT
        if file.is_relative_to(SOURCE_ROOT):raise readonly.DatabaseReadonlyError('UNAUTHORIZED_PATH','Credential vaults cannot be exported into the public tool repository')
        entries=[]
        for ref in refs:
            password=readonly.get_password(ref)
            if not isinstance(password,str) or not 1<=len(password)<=65536:
                raise readonly.DatabaseReadonlyError('RESULT_UNSUPPORTED','Selected keyring entries must contain 1–65536 characters')
            entries.append({'credentialRef':ref,'password':password})
        value=crypto('encrypt',{'schemaVersion':1,'workspaceKey':key,'mappingDigest':mapping_digest,'entries':entries},passphrase,node_path)
        file.parent.mkdir(parents=True,exist_ok=True)
        descriptor=os.open(file,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(descriptor,'w',encoding='utf-8') as handle:json.dump(value,handle);handle.flush();os.fsync(handle.fileno())
        return {'ok':True,'workspaceKey':key,'exportedCount':len(entries),'vaultPath':str(file),'plaintextFileCreated':False}
    if any(ref in other_refs for ref in refs):
        raise readonly.DatabaseReadonlyError('CREDENTIAL_SHARED','A selected credential is shared by another workspace; import would change an unselected target')
    if file.stat().st_size>1_048_576:raise readonly.DatabaseReadonlyError('RESULT_UNSUPPORTED','Vault exceeds 1 MiB')
    value=crypto('decrypt',json.loads(file.read_text(encoding='utf-8')),passphrase,node_path)
    if (not isinstance(value,dict) or set(value)!={'schemaVersion','workspaceKey','mappingDigest','entries'} or value['schemaVersion']!=1
        or value['workspaceKey']!=key or value['mappingDigest']!=mapping_digest or not isinstance(value['entries'],list)):
        raise readonly.DatabaseReadonlyError('ENVIRONMENT_MISMATCH','Vault workspace or connection bindings changed')
    entries=value['entries']
    if (len(entries)!=len(refs) or any(not isinstance(entry,dict) or set(entry)!={'credentialRef','password'} for entry in entries)
        or {entry['credentialRef'] for entry in entries}!=set(refs)
        or any(not isinstance(entry['password'],str) or not 1<=len(entry['password'])<=65536 for entry in entries)):
        raise readonly.DatabaseReadonlyError('RESULT_UNSUPPORTED','Vault credential entries are incomplete or invalid')
    with file_lock(workspace['configDir']/'.configuration.lock'):
        store=readonly._keyring();previous={ref:store.get_password(readonly.CREDENTIAL_SERVICE,ref) for ref in refs};attempted=[]
        try:
            for entry in entries:
                ref=entry['credentialRef'];attempted.append(ref);readonly.set_password(ref,entry['password'])
        except Exception as error:
            failures=[]
            for ref in reversed(attempted):
                try:readonly.delete_password(ref) if previous[ref] is None else readonly.set_password(ref,previous[ref])
                except readonly.DatabaseReadonlyError:failures.append(ref)
            if failures:raise readonly.DatabaseReadonlyError('CREDENTIAL_ROLLBACK_FAILED','Credential import failed and rollback is incomplete; reconfigure selected entries') from error
            raise
    return {'ok':True,'workspaceKey':key,'importedCount':len(entries),'configurationChanged':False}
