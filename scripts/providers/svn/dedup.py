"""Resolve stale duplicate PAGE files left by SVN alias renames."""

from __future__ import annotations

import re


def _revision_key(value: object) -> tuple[int, int, str]:
    """Return an orderable key for the SVN revision stored on one file."""

    text = str(value or "").strip()
    match = re.fullmatch(r"r?(\d+)", text, re.IGNORECASE)
    if match:
        return (1, int(match.group(1)), "")
    return (0, -1, text)


def _source_order(item: dict) -> tuple[tuple[int, int, str], str]:
    """Use SVN revision first and a stable path tie-breaker second."""

    return (_revision_key(item.get("svn_revision")), str(item.get("source_path") or ""))


def _is_page_candidate(item: dict) -> bool:
    return item.get("source_table") == "page" and item.get("status") != "PARSE_ERROR"


def resolve_page_duplicates(items: list[dict]) -> tuple[list[dict], list[dict]]:
    """Keep only the newest indexed object for each PAGE_ID.

    Guthon SVN can leave the old alias file behind when a PAGE alias changes.
    Such files are physical checkout artifacts, not independent PAGE objects.
    The returned ``ignored`` entries describe files deliberately excluded from
    the source index; they are not scan failures and therefore do not abort a
    complete index rebuild.
    """

    selected = []
    page_positions = {}
    ignored = []
    for item in items:
        if not _is_page_candidate(item):
            selected.append(item)
            continue
        identity = (item.get("source_id") or "", item.get("fun_id") or "")
        position = page_positions.get(identity)
        if position is None:
            page_positions[identity] = len(selected)
            selected.append(item)
            continue
        previous = selected[position]
        if _source_order(item) > _source_order(previous):
            selected[position] = item
            newer, older = item, previous
        else:
            newer, older = previous, item
        ignored.append(
            {
                "source_table": "page",
                "source_id": identity[0],
                "path": older.get("source_path") or "",
                "keptPath": newer.get("source_path") or "",
                "revision": older.get("svn_revision") or "",
                "keptRevision": newer.get("svn_revision") or "",
                "reason": "duplicate PAGE_ID; older SVN file excluded from source index",
            }
        )
    return selected, ignored


def is_newer_page(candidate: dict, existing: dict) -> bool:
    """Return whether a candidate PAGE object should replace an indexed one."""

    return (
        _is_page_candidate(candidate)
        and _is_page_candidate(existing)
        and _source_order(candidate) > _source_order(existing)
    )
