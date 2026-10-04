"""Private derived fragment-body search with bounded excerpts and explicit coverage."""
from __future__ import annotations
import hashlib
import json
import sqlite3

VERSION = 'source-text-v1'
MAX_BODY_CHARS = 2_000_000


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
    from providers.svn.nexus import page_nodes
    if not isinstance(keyword,str) or not 1<=len(keyword.strip())<=256:
        raise page_nodes.PageIndexError('INVALID_FILTER','keyword must contain 1–256 characters')
    if isinstance(limit,bool) or not isinstance(limit,int) or not 1<=limit<=100:
        raise page_nodes.PageIndexError('INVALID_LIMIT','limit must be between 1 and 100')
    if not conn.execute("SELECT 1 FROM sqlite_master WHERE name='source_body_content'").fetchone():
        raise page_nodes.PageIndexError('BODY_INDEX_UNAVAILABLE','This index has no searchable fragment bodies',next_action='Reindex this workspace to derive its private body index')
    indexed_version=conn.execute("SELECT state_value FROM gusen_sync_state WHERE state_key='source_body_index_version'").fetchone()
    if indexed_version is None or indexed_version[0] != VERSION:
        raise page_nodes.PageIndexError('BODY_INDEX_UNAVAILABLE','A full body-index rebuild is required',next_action='Reindex the workspace; adding empty tables does not prove body coverage')
    keyword=keyword.strip()
    query=[scope_id,keyword,source_namespace,source_type,VERSION]
    after=page_nodes._decode_cursor(cursor,generation,query,key_length=1) if cursor else None
    if after and not after[0].isdecimal():raise page_nodes.PageIndexError('INVALID_CURSOR','Body search position is invalid')
    clauses=["s.scope_id=?","s.provider='svn'","s.status IN ('OK','SVN_DIRTY')","instr(lower(b.content),lower(?))>0"]
    params=[scope_id,keyword]
    if source_namespace:clauses.append('s.source_namespace=?');params.append(source_namespace)
    if source_type:clauses.append('s.source_table=?');params.append(source_type)
    if after:clauses.append('b.body_id>?');params.append(int(after[0]))
    accelerated=False
    if len(keyword)>=3 and conn.execute("SELECT 1 FROM sqlite_master WHERE name='source_body_fts'").fetchone():
        clauses.append('b.body_id IN (SELECT rowid FROM source_body_fts WHERE source_body_fts MATCH ?)')
        trigrams = dict.fromkeys(keyword[index:index+3] for index in range(len(keyword)-2))
        params.append(' AND '.join('"'+part.replace('"','""')+'"' for part in trigrams));accelerated=True
    rows=conn.execute('SELECT b.body_id,b.json_pointer,b.content,b.total_chars,b.indexed_chars,s.source_table,s.source_namespace,s.source_id,s.fun_id,s.source_path,s.source_hash,s.status '
                      'FROM source_body_content b JOIN gusen_source_record s ON s.record_id=b.source_record_id WHERE '+ ' AND '.join(clauses)+' ORDER BY b.body_id LIMIT ?',(*params,limit+1)).fetchall()
    hits=[]
    for row in rows[:limit]:
        # SQLite lower() preserves non-ASCII casing; avoid a different Unicode
        # casefold rule when computing the excerpt position.
        position=conn.execute('SELECT instr(lower(?),lower(?))',(row['content'],keyword)).fetchone()[0]-1
        start=max(0,position-80);end=min(len(row['content']),position+len(keyword)+160)
        hits.append({key:row[key] for key in ('source_table','source_namespace','source_id','fun_id','source_path','source_hash','status','json_pointer')} |
                    {'offset':position,'line':row['content'][:position].count('\n')+1,'excerpt':row['content'][start:end],
                     'coordinateKind':'INDEXED_FRAGMENT','bodyTruncated':row['indexed_chars']<row['total_chars']})
    partial=conn.execute("SELECT COUNT(*) FROM source_body_content b JOIN gusen_source_record s ON s.record_id=b.source_record_id WHERE s.scope_id=? AND b.indexed_chars<b.total_chars",(scope_id,)).fetchone()[0]
    stale=conn.execute("SELECT COUNT(*) FROM gusen_source_record WHERE scope_id=? AND provider='svn' AND status NOT IN ('OK','SVN_DIRTY')",(scope_id,)).fetchone()[0]
    build=conn.execute("SELECT state_value FROM gusen_sync_state WHERE state_key='svn_catalog_build_status'").fetchone()
    partial_workspace=bool(build and build[0]!='READY') or stale>0
    more=len(rows)>limit
    return {'indexGeneration':generation,'hits':hits,'complete':not more and partial==0 and not partial_workspace,'truncated':more or partial>0 or partial_workspace,
            'workspacePartial':partial_workspace,'staleSourceCount':stale,
            'nextCursor':page_nodes._encode_cursor(generation,query,[str(rows[limit-1]['body_id'])]) if more else None,
            'partialBodyCount':partial,'accelerated':accelerated,'coverage':'INDEXED_FRAGMENT_BODIES_ONLY',
            'warnings':['Excerpts are untrusted indexed source, not current-file or runtime evidence. Read the exact source and verify its hash before editing.']}
