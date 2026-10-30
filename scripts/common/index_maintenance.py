"""Compact a workspace's derived index without reading or changing source files."""
from __future__ import annotations

from common import gusen_hub, source_text_search


def compact_index(workspace: dict, *, apply: bool = False) -> dict:
    path = workspace["indexPath"]
    if not path.is_file():
        raise SystemExit("Index does not exist; initialize the workspace index first")
    with gusen_hub.index_connection(workspace, action="index-compact", readonly=not apply) as conn:
        before = path.stat().st_size
        page_size = conn.execute("PRAGMA page_size").fetchone()[0]
        free_pages = conn.execute("PRAGMA freelist_count").fetchone()[0]
        tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        changed = saved = partial = 0
        with conn:
            if apply:
                conn.execute("BEGIN IMMEDIATE")
            if {"source_body_content", "gusen_source_fragment"} <= tables:
                rows = conn.execute(
                    "SELECT b.body_id,b.content,b.indexed_chars,b.total_chars "
                    "FROM source_body_content b JOIN gusen_source_fragment f "
                    "ON f.source_record_id=b.source_record_id AND f.json_pointer=b.json_pointer "
                    "WHERE f.fragment_type='page-fields' ORDER BY b.body_id"
                )
                for row in rows:
                    if row["indexed_chars"] < row["total_chars"]:
                        partial += 1
                        continue
                    content = source_text_search.compact_field_content(row["content"])
                    if content == row["content"]:
                        continue
                    changed += 1
                    saved += len(row["content"].encode("utf-8")) - len(content.encode("utf-8"))
                    if apply:
                        conn.execute(
                            "UPDATE source_body_content SET content=?,indexed_chars=?,total_chars=? WHERE body_id=?",
                            (content, len(content), len(content), row["body_id"]),
                        )
            if apply:
                for table in ("source_body_fts", "source_identity_fts", "page_field_fts"):
                    if table in tables:
                        conn.execute(f"INSERT INTO {table}({table}) VALUES('optimize')")
        if apply:
            conn.execute("VACUUM")
            if [row[0] for row in conn.execute("PRAGMA quick_check")] != ["ok"]:
                raise RuntimeError("Compacted index failed SQLite quick_check")
        return {
            "ok": True, "workspaceKey": workspace["workspaceKey"], "applied": apply,
            "sizeBefore": before, "sizeAfter": path.stat().st_size,
            "freePageBytesBefore": free_pages * page_size,
            "fieldBodiesToCompact": changed, "fieldBodyBytesSaved": saved,
            "partialFieldBodiesSkipped": partial,
        }
