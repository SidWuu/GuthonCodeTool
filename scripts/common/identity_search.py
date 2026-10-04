"""Optional trigram acceleration with unchanged literal substring results."""
from __future__ import annotations

import re
import sqlite3


def setup(conn):
    # REPLACE must run the implicit DELETE trigger of external-content FTS.
    conn.execute("PRAGMA recursive_triggers=ON")
    if conn.execute("SELECT 1 FROM sqlite_master WHERE name='source_identity_fts'").fetchone():
        return
    conn.execute("SAVEPOINT identity_fts_setup")
    try:
        conn.execute("CREATE VIRTUAL TABLE source_identity_fts USING fts5(source_id,source_alias_id,fun_id,source_name, content='gusen_source_record',content_rowid='record_id',tokenize='trigram')")
        conn.execute("CREATE TRIGGER source_identity_insert AFTER INSERT ON gusen_source_record BEGIN INSERT INTO source_identity_fts(rowid,source_id,source_alias_id,fun_id,source_name) VALUES(COALESCE(new.record_id,new.rowid),new.source_id,new.source_alias_id,new.fun_id,new.source_name); END")
        conn.execute("CREATE TRIGGER source_identity_delete AFTER DELETE ON gusen_source_record BEGIN INSERT INTO source_identity_fts(source_identity_fts,rowid,source_id,source_alias_id,fun_id,source_name) VALUES('delete',old.record_id,old.source_id,old.source_alias_id,old.fun_id,old.source_name); END")
        conn.execute("CREATE TRIGGER source_identity_update AFTER UPDATE OF source_id,source_alias_id,fun_id,source_name ON gusen_source_record BEGIN INSERT INTO source_identity_fts(source_identity_fts,rowid,source_id,source_alias_id,fun_id,source_name) VALUES('delete',old.record_id,old.source_id,old.source_alias_id,old.fun_id,old.source_name); INSERT INTO source_identity_fts(rowid,source_id,source_alias_id,fun_id,source_name) VALUES(COALESCE(new.record_id,new.rowid),new.source_id,new.source_alias_id,new.fun_id,new.source_name); END")
        conn.execute("INSERT INTO source_identity_fts(source_identity_fts) VALUES('rebuild')")
        conn.execute("RELEASE identity_fts_setup")
    except sqlite3.OperationalError as error:
        conn.execute("ROLLBACK TO identity_fts_setup")
        conn.execute("RELEASE identity_fts_setup")
        if "fts5" not in str(error).lower() and "tokenizer" not in str(error).lower():
            raise


def candidate_clause(conn, keyword, *, allow_like_wildcards=False):
    # Keep LIKE wildcards, Unicode case behavior and short searches on the old
    # path; residual instr/LIKE still decides the result on the accelerated path.
    if (len(keyword) < 3 or not keyword.isascii() or not re.search(r"[A-Za-z0-9]{3}", keyword)
            or allow_like_wildcards and any(char in keyword for char in "%_")):
        return "", []
    if not conn.execute("SELECT 1 FROM sqlite_master WHERE name='source_identity_fts'").fetchone():
        return "", []
    phrase = '"' + keyword.replace('"', '""') + '"'
    return "record_id IN (SELECT rowid FROM source_identity_fts WHERE source_identity_fts MATCH ?)", [phrase]
