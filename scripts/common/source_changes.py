"""Committed SVN metadata changes with explicit retained generation boundaries."""
from __future__ import annotations

import base64
import datetime as dt
import json

HISTORY_GENERATIONS = 500
KEYS = ('scope_id', 'source_namespace', 'source_type', 'source_id', 'fun_id')
FIELDS = (*KEYS, 'source_path', 'working_copy_id', 'source_hash', 'status', 'change_key', 'source_alias_id', 'source_name')


class ChangeHistoryError(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def setup(conn):
    conn.executescript('''
    CREATE TABLE IF NOT EXISTS gusen_index_generation(
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      generation TEXT NOT NULL UNIQUE,
      published_at TEXT NOT NULL,
      source_count INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS gusen_source_snapshot(
      scope_id TEXT NOT NULL,source_namespace TEXT NOT NULL,source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,fun_id TEXT NOT NULL,source_path TEXT NOT NULL,
      working_copy_id TEXT NOT NULL,source_hash TEXT NOT NULL,status TEXT NOT NULL,
      change_key TEXT NOT NULL,source_alias_id TEXT NOT NULL,source_name TEXT NOT NULL,
      PRIMARY KEY(scope_id,source_namespace,source_type,source_id,fun_id)
    );
    CREATE TABLE IF NOT EXISTS gusen_source_change_event(
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,generation_sequence INTEGER NOT NULL,
      scope_id TEXT NOT NULL,source_namespace TEXT NOT NULL,source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,fun_id TEXT NOT NULL,source_path TEXT NOT NULL,
      working_copy_id TEXT NOT NULL,change_type TEXT NOT NULL,source_hash TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS gusen_source_change_scope_generation
      ON gusen_source_change_event(scope_id,generation_sequence,event_id);
    ''')


def publish(conn, generation):
    """Called only inside the index publisher's transaction, with no source IO."""
    if conn.execute('SELECT 1 FROM gusen_index_generation WHERE generation=?', (generation,)).fetchone():
        return
    rows = conn.execute(
        'SELECT scope_id,source_namespace,source_table,source_id,fun_id,source_path,working_copy_id,'
        "source_hash,status,change_key,source_alias_id,source_name FROM gusen_source_record WHERE provider='svn'")
    values = [tuple('' if value is None else str(value) for value in row) for row in rows]
    current = {value[:5]: value for value in values}
    previous = {tuple(row[:5]): tuple(row) for row in conn.execute('SELECT ' + ','.join(FIELDS) + ' FROM gusen_source_snapshot')}
    inserted = conn.execute('INSERT INTO gusen_index_generation(generation,published_at,source_count) VALUES(?,?,?)',
                           (generation, dt.datetime.now(dt.timezone.utc).isoformat(), len(current)))
    sequence = inserted.lastrowid
    for key in sorted(set(current) | set(previous)):
        old, new = previous.get(key), current.get(key)
        if old == new:
            continue
        value = new or old
        change = 'ADDED' if old is None else 'DELETED' if new is None else 'MODIFIED'
        conn.execute('INSERT INTO gusen_source_change_event(generation_sequence,' + ','.join(FIELDS[:7])
                     + ',change_type,source_hash,status) VALUES(' + ','.join('?' for _ in range(11)) + ')',
                     (sequence, *value[:7], change, value[7], value[8]))
    conn.execute('DELETE FROM gusen_source_snapshot')
    conn.executemany('INSERT INTO gusen_source_snapshot(' + ','.join(FIELDS) + ') VALUES(' + ','.join('?' for _ in FIELDS) + ')', current.values())
    cutoff = conn.execute('SELECT sequence FROM gusen_index_generation ORDER BY sequence DESC LIMIT 1 OFFSET ?',
                          (HISTORY_GENERATIONS - 1,)).fetchone()
    if cutoff:
        conn.execute('DELETE FROM gusen_source_change_event WHERE generation_sequence<?', (cutoff[0],))
        conn.execute('DELETE FROM gusen_index_generation WHERE sequence<?', (cutoff[0],))


def list_changes(conn, scope_id, *, since_generation, limit=50, cursor=''):
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
        raise ChangeHistoryError('INVALID_LIMIT', 'limit must be between 1 and 100')
    if not conn.execute("SELECT 1 FROM sqlite_master WHERE name='gusen_index_generation'").fetchone():
        raise ChangeHistoryError('HISTORY_UNAVAILABLE', 'This index has no retained generation history; rebuild the derived index')
    baseline = conn.execute('SELECT sequence FROM gusen_index_generation WHERE generation=?', (since_generation,)).fetchone()
    if baseline is None:
        raise ChangeHistoryError('HISTORY_UNAVAILABLE', 'sinceGeneration is unknown or no longer retained; obtain a current bounded snapshot')
    latest = conn.execute('SELECT sequence,generation FROM gusen_index_generation ORDER BY sequence DESC LIMIT 1').fetchone()
    after = 0
    through = latest[0]
    if cursor:
        try:
            token = json.loads(base64.urlsafe_b64decode(cursor.encode()).decode())
            if set(token) != {'scope', 'since', 'after', 'through'} or token['scope'] != scope_id or token['since'] != since_generation:
                raise ValueError('cursor query mismatch')
            if any(isinstance(token[key], bool) or not isinstance(token[key], int) or token[key] < 0 for key in ('after', 'through')):
                raise ValueError('cursor positions must be nonnegative integers')
            after, through = token['after'], token['through']
            if not baseline[0] <= through <= latest[0]:
                raise ValueError('cursor generation boundary is invalid')
        except (ValueError, TypeError, UnicodeError, KeyError) as error:
            raise ChangeHistoryError('INVALID_CURSOR', str(error)) from error
    rows = conn.execute('SELECT e.*,g.generation FROM gusen_source_change_event e '
                        'JOIN gusen_index_generation g ON g.sequence=e.generation_sequence '
                        'WHERE e.scope_id=? AND e.generation_sequence>? AND e.generation_sequence<=? AND e.event_id>? '
                        'ORDER BY e.event_id LIMIT ?', (scope_id, baseline[0], through, after, limit + 1)).fetchall()
    truncated = len(rows) > limit
    visible = rows[:limit]
    next_cursor = base64.urlsafe_b64encode(json.dumps({'scope': scope_id, 'since': since_generation, 'after': visible[-1]['event_id'], 'through': through}).encode()).decode() if truncated else None
    return {'sinceGeneration': since_generation, 'throughGeneration': conn.execute('SELECT generation FROM gusen_index_generation WHERE sequence=?', (through,)).fetchone()[0],
            'changes': [dict(row) for row in visible], 'complete': not truncated, 'truncated': truncated,
            'nextCursor': next_cursor, 'coverage': 'RETAINED_COMMITTED_INDEX_METADATA', 'retainedGenerations': HISTORY_GENERATIONS}
