"""Save explicit minimal parser feedback in the private workspace, never public source."""
from __future__ import annotations
import json
import uuid
import re
from common import source_facts
from common.persistence import atomic_text


def save_feedback(workspace, payload):
    allowed={'sample','expected','actual','parser','sourceHash','redacted'}
    if not isinstance(payload,dict) or set(payload)-allowed or not {'sample','expected','actual'} <= set(payload):
        raise SystemExit('parser-feedback requires sample/expected/actual JSON')
    if payload.get('redacted') is not True:
        raise SystemExit('Confirm the sample is redacted with redacted=true before saving parser feedback')
    for key in ('sample','expected','actual'):
        if not isinstance(payload[key],str) or not 1 <= len(payload[key]) <= 8000:
            raise SystemExit('Feedback text must contain 1–8000 characters')
    parser=payload.get('parser','source-facts')
    if not isinstance(parser, str) or parser not in {'source-facts','page-nodes','page-fields','inheritance'}:
        raise SystemExit('Unknown parser feedback type')
    if "sourceHash" in payload and (not isinstance(payload["sourceHash"], str) or not re.fullmatch(r"(?:sha256:)?[a-fA-F0-9]{64}", payload["sourceHash"])):
        raise SystemExit('sourceHash must be an exact SHA-256 if supplied')
    identifier=uuid.uuid4().hex
    root=workspace['contextDir']/'parser-feedback'
    if root.is_symlink():raise SystemExit('Parser feedback directory cannot be a symlink')
    value={'schemaVersion':1,'workspaceKey':workspace['workspaceKey'],'id':identifier,'parser':parser,
           'parserVersions':{'nodes':source_facts.PAGE_NODE_PARSER_VERSION,'fields':source_facts.PAGE_FIELD_PARSER_VERSION},
           **payload,'fixtureDraft':True,'validated':False}
    file=root/(identifier+'.json')
    atomic_text(file,json.dumps(value,ensure_ascii=False,indent=2)+'\n')
    return {'ok':True,'workspaceKey':workspace['workspaceKey'],'feedbackId':identifier,'artifactPath':str(file),'fixtureDraft':True,'validated':False}
