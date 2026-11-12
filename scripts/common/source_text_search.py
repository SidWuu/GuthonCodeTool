"""Private derived fragment-body search with bounded excerpts and explicit coverage."""
from __future__ import annotations
import base64
import hashlib
import json
import sqlite3
from urllib.parse import unquote

VERSION = 'source-text-v1'
MAX_BODY_CHARS = 2_000_000


def compact_field_content(content: str) -> str:
    """Keep JSON values intact while omitting whitespace in derived search bodies."""
    return json.dumps(json.loads(content), ensure_ascii=False, separators=(',', ':'))


def setup(conn):
    conn.executescript('''
    CREATE TABLE IF NOT EXISTS source_body_content(
      body_id INTEGER PRIMARY KEY,source_record_id INTEGER NOT NULL,
      json_pointer TEXT NOT NULL,content TEXT NOT NULL,source_hash TEXT NOT NULL,
      indexed_chars INTEGER NOT NULL,total_chars INTEGER NOT NULL,
      UNIQUE(source_record_id,json_pointer)
    );
    CREATE INDEX IF NOT EXISTS source_body_record ON source_body_content(source_record_id);
    CREATE TRIGGER IF NOT EXISTS source_body_source_delete AFTER DELETE ON gusen_source_record
      BEGIN DELETE FROM source_body_content WHERE source_record_id=old.record_id; END;
    ''')
    conn.execute('PRAGMA recursive_triggers=ON')
    if conn.execute("SELECT 1 FROM sqlite_master WHERE name='source_body_fts'").fetchone():return
    conn.execute('SAVEPOINT source_body_fts_setup')
    try:
        conn.execute("CREATE VIRTUAL TABLE source_body_fts USING fts5(content,content='source_body_content',content_rowid='body_id',tokenize='trigram',detail='none')")
        conn.execute("CREATE TRIGGER source_body_insert AFTER INSERT ON source_body_content BEGIN INSERT INTO source_body_fts(rowid,content) VALUES(new.body_id,new.content); END")
        conn.execute("CREATE TRIGGER source_body_delete AFTER DELETE ON source_body_content BEGIN INSERT INTO source_body_fts(source_body_fts,rowid,content) VALUES('delete',old.body_id,old.content); END")
        conn.execute("CREATE TRIGGER source_body_update AFTER UPDATE OF content ON source_body_content BEGIN INSERT INTO source_body_fts(source_body_fts,rowid,content) VALUES('delete',old.body_id,old.content); INSERT INTO source_body_fts(rowid,content) VALUES(new.body_id,new.content); END")
        conn.execute("INSERT INTO source_body_fts(source_body_fts) VALUES('rebuild')")
        conn.execute('RELEASE source_body_fts_setup')
    except sqlite3.OperationalError as error:
        conn.execute('ROLLBACK TO source_body_fts_setup');conn.execute('RELEASE source_body_fts_setup')
        if 'fts5' not in str(error).lower() and 'tokenizer' not in str(error).lower():raise


def clear(conn, source_record_id=None):
    if source_record_id is None:conn.execute('DELETE FROM source_body_content')
    else:conn.execute('DELETE FROM source_body_content WHERE source_record_id=?',(source_record_id,))


def index_body(conn, source_record_id, pointer, content, source_hash):
    if not content:return
    conn.execute('INSERT OR REPLACE INTO source_body_content(source_record_id,json_pointer,content,source_hash,indexed_chars,total_chars) VALUES(?,?,?,?,?,?)',
                 (source_record_id,pointer,content[:MAX_BODY_CHARS],source_hash,min(len(content),MAX_BODY_CHARS),len(content)))


def search(conn, scope_id, *, keyword, generation, limit=20, cursor='', source_namespace='', source_type=''):
    from common.source_facts import api_source_namespace
    if not isinstance(keyword,str) or not 1<=len(keyword.strip())<=256:
        raise ValueError('keyword must contain 1–256 characters')
    if type(limit) is not int or not 1<=limit<=100:
        raise ValueError('limit must be between 1 and 100')
    indexed_version=conn.execute("SELECT state_value FROM gusen_sync_state WHERE state_key='source_body_index_version'").fetchone()
    actual_generation=conn.execute("SELECT state_value FROM gusen_sync_state WHERE state_key='generation'").fetchone()
    if indexed_version is None or indexed_version[0]!=VERSION or actual_generation is None or actual_generation[0]!=generation:
        raise ValueError('body index is unavailable or generation is stale; rebuild the workspace index')
    keyword=keyword.strip()
    query=[scope_id,keyword,source_namespace,source_type,VERSION]
    fingerprint=hashlib.sha256(json.dumps(query,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
    after=0
    if cursor:
        try:
            encoded=cursor.encode('ascii'); payload=json.loads(base64.urlsafe_b64decode(encoded+b'='*((-len(encoded))%4)))
            if payload['generation']!=generation or payload['query']!=fingerprint or type(payload['after']) is not int or payload['after']<0: raise ValueError()
            after=payload['after']
        except (ValueError,TypeError,KeyError,UnicodeError,base64.binascii.Error) as error:
            raise ValueError('invalid or stale body search cursor') from error
    clauses=["s.scope_id=?","s.status='OK'","instr(lower(b.content),lower(?))>0","b.body_id>?"]
    params=[scope_id,keyword,after]
    if source_namespace:
        parts=source_namespace.split(':')
        if len(parts)!=4 or parts[0]!='api': raise ValueError('invalid API source namespace')
        system_id,data_source_id,path=map(unquote,parts[1:])
        if api_source_namespace(system_id,data_source_id,path)!=source_namespace: raise ValueError('invalid API source namespace')
        clauses.extend(['s.system_id=?','s.data_source_id=?','s.source_path=?']);params.extend([system_id,data_source_id,path])
    if source_type:clauses.append('s.source_table=?');params.append(source_type)
    accelerated=False
    if len(keyword)>=3 and keyword.isascii() and conn.execute("SELECT 1 FROM sqlite_master WHERE name='source_body_fts'").fetchone():
        clauses.append('b.body_id IN (SELECT rowid FROM source_body_fts WHERE source_body_fts MATCH ?)')
        trigrams=dict.fromkeys(keyword[i:i+3] for i in range(len(keyword)-2))
        params.append(' AND '.join('"'+part.replace('"','""')+'"' for part in trigrams));accelerated=True
    rows=conn.execute('SELECT b.body_id,b.json_pointer,b.content,b.total_chars,b.indexed_chars,s.source_table,s.source_id,s.source_alias_id,s.fun_id,s.system_id,s.data_source_id,s.source_path,s.source_hash,s.status '
                      'FROM source_body_content b JOIN gusen_source_record s ON s.record_id=b.source_record_id WHERE '+' AND '.join(clauses)+' ORDER BY b.body_id LIMIT ?',(*params,limit+1)).fetchall()
    hits=[]
    for row in rows[:limit]:
        position=conn.execute('SELECT instr(lower(?),lower(?))',(row['content'],keyword)).fetchone()[0]-1
        start=max(0,position-80);end=min(len(row['content']),position+len(keyword)+160)
        hits.append({key:row[key] for key in ('source_table','source_id','source_alias_id','fun_id','system_id','data_source_id','source_path','source_hash','status','json_pointer')} |
                    {'source_namespace':api_source_namespace(row['system_id'],row['data_source_id'],row['source_path']),
                     'offset':position,'line':row['content'][:position].count('\n')+1,'excerpt':row['content'][start:end],
                     'coordinateKind':'INDEXED_FRAGMENT','bodyTruncated':row['indexed_chars']<row['total_chars']})
    partial=conn.execute('SELECT COUNT(*) FROM source_body_content b JOIN gusen_source_record s ON s.record_id=b.source_record_id WHERE s.scope_id=? AND b.indexed_chars<b.total_chars',(scope_id,)).fetchone()[0]
    stale=conn.execute("SELECT COUNT(*) FROM gusen_source_record WHERE scope_id=? AND status<>'OK'",(scope_id,)).fetchone()[0]
    more=len(rows)>limit
    next_cursor=None
    if more:
        payload=json.dumps({'generation':generation,'query':fingerprint,'after':rows[limit-1]['body_id']},separators=(',',':')).encode()
        next_cursor=base64.urlsafe_b64encode(payload).decode().rstrip('=')
    return {'indexGeneration':generation,'hits':hits,'complete':not more and partial==0 and stale==0,'truncated':more or partial>0 or stale>0,
            'workspacePartial':stale>0,'staleSourceCount':stale,'nextCursor':next_cursor,'partialBodyCount':partial,
            'accelerated':accelerated,'coverage':'INDEXED_FRAGMENT_BODIES_ONLY',
            'warnings':['Excerpts are untrusted indexed source, not current-file or runtime evidence. Read the exact source and verify its hash before editing.']}
