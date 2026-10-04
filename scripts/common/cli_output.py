"""CLI v1 output envelopes with legacy top-level fields preserved."""
import csv
import io
import json

API_VERSION = 1


def envelope(output, *, command, workspace_key=None, exit_code=0):
    try:
        value=json.loads(output)
    except ValueError:
        value={'stdout':output}
    result=dict(value) if isinstance(value,dict) else {'data':value}
    result['apiVersion']=API_VERSION
    result.setdefault('ok',exit_code==0)
    result.setdefault('command',command)
    if workspace_key is not None:result.setdefault('workspaceKey',workspace_key)
    return result


def render(payload, format_name='json'):
    if format_name=='json':return json.dumps(payload,ensure_ascii=False,default=str)+'\n'
    if format_name=='text' and isinstance(payload.get('stdout'),str):return payload['stdout']
    value=payload.get('result',payload)
    if isinstance(value,dict) and isinstance(value.get('result'),dict):value=value['result']
    if isinstance(value,dict) and isinstance(value.get('rows'),list) and isinstance(value.get('columns'),list):
        columns=value['columns'];rows=value['rows']
        data=[[row.get(column) for column in columns] if isinstance(row,dict) else row for row in rows]
    elif isinstance(payload.get('data'),list) and all(isinstance(row,dict) for row in payload['data']):
        rows=payload['data'];columns=list(dict.fromkeys(key for row in rows for key in row))
        data=[[row.get(column) for column in columns] for row in rows]
    else:
        columns=['字段','值'];data=[[key,value] for key,value in payload.items()]
    stream=io.StringIO();writer=csv.writer(stream,delimiter=',' if format_name=='csv' else '\t')
    writer.writerow(columns)
    for row in data:
        writer.writerow([json.dumps(value,ensure_ascii=False,default=str) if isinstance(value,(dict,list)) else value for value in row])
    return stream.getvalue()
