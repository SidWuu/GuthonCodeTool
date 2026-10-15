"""Build optional search indexes once inside an atomic full source rebuild."""
from contextlib import contextmanager

from common.operation_control import checkpoint


@contextmanager
def bulk_search_index(conn, on_progress=None):
    if not conn.in_transaction:
        raise ValueError('Bulk search indexing requires an enclosing transaction')
    definitions = {
        'source_identity_fts': ('source_identity_insert', 'source_identity_delete', 'source_identity_update'),
        'source_body_fts': ('source_body_insert', 'source_body_delete', 'source_body_update'),
        'page_field_fts': ('page_field_fts_insert', 'page_field_fts_delete', 'page_field_fts_update'),
    }
    tables = [name for name in definitions if conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone()]
    triggers = []
    for table in tables:
        for name in definitions[table]:
            row = conn.execute("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name=?", (name,)).fetchone()
            if row:
                triggers.append(tuple(row))
    conn.execute('SAVEPOINT bulk_search_index')
    try:
        for name, _sql in triggers:
            conn.execute('DROP TRIGGER "' + name + '"')
        yield
        for table in tables:
            checkpoint()
            if on_progress:
                on_progress('批量建立检索索引 · ' + table)
            conn.execute(f"INSERT INTO {table}({table}) VALUES('rebuild')")
        for _name, sql in triggers:
            conn.execute(sql)
        conn.execute('RELEASE bulk_search_index')
    except BaseException:
        conn.execute('ROLLBACK TO bulk_search_index')
        conn.execute('RELEASE bulk_search_index')
        raise
