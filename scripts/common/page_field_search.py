"""Optional PAGE label trigram candidates with exact substring residuals."""
import sqlite3


def setup(conn):
    conn.execute('PRAGMA recursive_triggers=ON')
    if conn.execute("SELECT 1 FROM sqlite_master WHERE name='page_field_fts'").fetchone():return
    conn.execute('SAVEPOINT page_field_fts_setup')
    try:
        conn.execute("CREATE VIRTUAL TABLE page_field_fts USING fts5(label,content='gusen_page_field',content_rowid='rowid',tokenize='trigram',detail='none')")
        conn.execute("CREATE TRIGGER page_field_fts_insert AFTER INSERT ON gusen_page_field BEGIN INSERT INTO page_field_fts(rowid,label) VALUES(new.rowid,new.label); END")
        conn.execute("CREATE TRIGGER page_field_fts_delete AFTER DELETE ON gusen_page_field BEGIN INSERT INTO page_field_fts(page_field_fts,rowid,label) VALUES('delete',old.rowid,old.label); END")
        conn.execute("CREATE TRIGGER page_field_fts_update AFTER UPDATE OF label ON gusen_page_field BEGIN INSERT INTO page_field_fts(page_field_fts,rowid,label) VALUES('delete',old.rowid,old.label); INSERT INTO page_field_fts(rowid,label) VALUES(new.rowid,new.label); END")
        conn.execute("INSERT INTO page_field_fts(page_field_fts) VALUES('rebuild')")
        conn.execute('RELEASE page_field_fts_setup')
    except sqlite3.OperationalError as error:
        conn.execute('ROLLBACK TO page_field_fts_setup');conn.execute('RELEASE page_field_fts_setup')
        if 'fts5' not in str(error).lower() and 'tokenizer' not in str(error).lower():raise


def candidates(conn, keyword):
    # Unicode lower() semantics differ between Python and SQLite; the exact
    # SQL residual still decides which results are returned on either path.
    if len(keyword)<3 or not keyword.isascii():return '',[]
    if not conn.execute("SELECT 1 FROM sqlite_master WHERE name='page_field_fts'").fetchone():return '',[]
    trigrams=sorted({keyword[index:index+3] for index in range(len(keyword)-2)})
    match=' AND '.join('"'+value.replace('"','""')+'"' for value in trigrams)
    return 'f.rowid IN (SELECT rowid FROM page_field_fts WHERE page_field_fts MATCH ?)',[match]
