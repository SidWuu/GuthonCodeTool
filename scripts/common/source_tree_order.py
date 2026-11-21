"""Local subsystem and datasource identities used by legacy source trees."""

from collections import Counter


def local_navigation_groups(workspace, systems, data_sources, *, infer_svn_sources=False):
    memberships = {}
    for mapping in workspace.get("systemMappings", {}).values():
        if not isinstance(mapping, dict):
            continue
        system_id = str(mapping.get("system_id") or "")
        source_id = str(mapping.get("data_source_id") or "")
        if system_id and source_id:
            memberships.setdefault(system_id, set()).add(source_id)
    assigned = {key: next(iter(values)) for key, values in memberships.items() if len(values) == 1}

    if infer_svn_sources:
        from providers.svn.group_inference import match_datasource_name

        for key, name in systems.items():
            if key not in memberships:
                match = match_datasource_name(name, data_sources)
                if match:
                    assigned[key] = match[0]

    def unique_ids_by_name(rows):
        counts = Counter(rows.values())
        return {name: key for key, name in rows.items() if name and counts[name] == 1}

    return {"dataSourceIdsBySystem": assigned, "systemIdsByName": unique_ids_by_name(systems),
            "dataSourceIdsByName": unique_ids_by_name(data_sources)}
