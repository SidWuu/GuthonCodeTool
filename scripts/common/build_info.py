"""Deterministic backend build identity from public inputs only."""
from __future__ import annotations
import hashlib
from pathlib import Path


def source_build_info(root):
    root=Path(root)
    digest=hashlib.sha256()
    inputs=[]
    for directory in ('scripts','config/example'):
        for path in (root/directory).rglob('*'):
            if path.is_file() and path.suffix in {'.py','.json','.yaml','.mjs'} and '__pycache__' not in path.parts:
                inputs.append(path)
    for path in sorted(inputs):
        digest.update(path.relative_to(root).as_posix().encode('utf-8'));digest.update(b'\0');digest.update(path.read_bytes())
    digest.update((root/'VERSION').read_bytes())
    return {'buildId':'sha256:'+digest.hexdigest(),'component':'tool-backend','inputCount':len(inputs),'coverage':'PUBLIC_BACKEND_CODE_AND_TEMPLATES'}
