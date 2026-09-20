"""Infer SVN system-to-datasource groups from checkout names and index files."""

from __future__ import annotations

import re
from collections import Counter
from difflib import SequenceMatcher
from pathlib import Path


GENERIC_NAME_PARTS = (
    "数据库",
    "物联网",
    "中心",
    "系统",
    "管理",
    "业务",
    "应用",
    "平台",
)
ASCII_WORD = re.compile(r"[A-Za-z0-9_-]+")


def checkout_name(root: Path) -> str:
    try:
        markers = sorted(
            item.name[2:].strip()
            for item in root.iterdir()
            if item.is_dir() and item.name.startswith("$.") and item.name[2:].strip()
        )
    except OSError:
        return ""
    return markers[0] if markers else ""


def _normalized_name(value: str) -> str:
    normalized = ASCII_WORD.sub("", str(value or "")).strip().lower()
    if normalized.endswith("数据源"):
        normalized = normalized[:-1]
    for part in GENERIC_NAME_PARTS:
        normalized = normalized.replace(part, "")
    return normalized


def _name_score(system_name: str, datasource_name: str) -> float:
    system = _normalized_name(system_name)
    datasource = _normalized_name(datasource_name)
    if not system or not datasource:
        return 0.0
    if system == datasource:
        return 1.0
    if min(len(system), len(datasource)) >= 2 and (system in datasource or datasource in system):
        return 0.82
    return SequenceMatcher(None, system, datasource).ratio()


def _index_text(root: Path, category: str) -> str:
    index_path = root / ("pages/index.md" if category == "systems" else "procedures/index.md")
    try:
        return index_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def _business_terms(value: str) -> list[str]:
    normalized = _normalized_name(value)
    if len(normalized) < 2:
        return []
    if len(normalized) == 2:
        return [normalized]
    return [normalized[index:index + 2] for index in range(len(normalized) - 1)]


def _index_evidence(system_name: str, datasource_text: str) -> int:
    terms = _business_terms(system_name)
    if not terms or not datasource_text:
        return 0
    counts = Counter(term for term in terms for _ in range(datasource_text.count(term)))
    return sum(min(count, 20) for count in counts.values())


def infer_groups(checkout_root: Path, working_copies: list[dict]) -> dict:
    """Return conservative system mappings plus the evidence used for each match."""

    available = {
        str(item.get("localSubdir") or "").strip().replace("\\", "/")
        for item in working_copies
        if isinstance(item, dict)
    }
    systems = []
    datasources = []
    for local_subdir in sorted(available):
        category, separator, identifier = local_subdir.partition("/")
        if not separator or category not in {"systems", "datasources"} or not identifier:
            continue
        root = checkout_root / local_subdir
        record = {
            "id": identifier,
            "name": checkout_name(root),
            "text": _index_text(root, category),
        }
        (systems if category == "systems" else datasources).append(record)

    matches = {}
    assigned_datasources = set()
    unresolved = []
    for system in systems:
        ranked = sorted(
            ((_name_score(system["name"], datasource["name"]), datasource) for datasource in datasources),
            key=lambda item: (-item[0], item[1]["id"]),
        )
        best_score, best = ranked[0] if ranked else (0.0, None)
        runner_up = ranked[1][0] if len(ranked) > 1 else 0.0
        if best is not None and best_score >= 0.82 and best_score - runner_up >= 0.12:
            matches[system["id"]] = {
                "dataSourceId": best["id"],
                "systemName": system["name"],
                "dataSourceName": best["name"],
                "evidence": "checkout-name",
                "score": round(best_score, 3),
            }
            assigned_datasources.add(best["id"])
        else:
            unresolved.append(system)

    # Only use index content after high-confidence names have reduced the candidate
    # set. This keeps generic words in large indexes from forcing a false group.
    remaining_datasources = [item for item in datasources if item["id"] not in assigned_datasources]
    still_unresolved = []
    for system in unresolved:
        ranked = sorted(
            ((_index_evidence(system["name"], datasource["text"]), datasource)
             for datasource in remaining_datasources),
            key=lambda item: (-item[0], item[1]["id"]),
        )
        best_score, best = ranked[0] if ranked else (0, None)
        runner_up = ranked[1][0] if len(ranked) > 1 else 0
        if best is not None and best_score >= 2 and best_score >= max(2, runner_up * 2):
            matches[system["id"]] = {
                "dataSourceId": best["id"],
                "systemName": system["name"],
                "dataSourceName": best["name"],
                "evidence": "index-content",
                "score": best_score,
            }
            assigned_datasources.add(best["id"])
            remaining_datasources = [item for item in remaining_datasources if item["id"] != best["id"]]
        else:
            still_unresolved.append({"systemId": system["id"], "systemName": system["name"]})

    return {
        "matches": matches,
        "unmatchedSystems": still_unresolved,
        "unmatchedDatasources": [
            {"dataSourceId": item["id"], "dataSourceName": item["name"]}
            for item in datasources
            if item["id"] not in assigned_datasources
        ],
    }
