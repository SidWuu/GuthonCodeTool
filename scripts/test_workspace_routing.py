#!/usr/bin/env python3

import unittest
import subprocess
import tempfile
from pathlib import Path
from unittest.mock import patch

import gusen_hub


def config():
    datasource = {
        "product-db": {"type": "mysql"},
        "project-a-db": {"type": "mysql"},
        "project-b-db": {"type": "mysql"},
    }
    systems = {"include": {"system_aliases": ["demo.system"]}}
    return {
        "datasource": {"datasource": datasource},
        "products": {"products": {"demo": {"name": "产品", "datasource": "product-db", "systems": systems}}},
        "projects": {
            "projects": {
                "a": {"name": "项目A", "datasource": "project-a-db", "product_id": "demo", "systems": systems},
                "b": {"name": "项目B", "datasource": "project-b-db", "product_id": "demo", "systems": systems},
            }
        },
        "sync": {"sync": {}, "rules": {}},
        "source_tables": {},
    }


def scope(_conn, _config, datasource_name, _workspace=None):
    return {
        "product-db": {"data_source_ids": ["0015"], "system_ids": ["SYS-P"]},
        "project-a-db": {"data_source_ids": ["0001"], "system_ids": ["SYS-X"]},
        "project-b-db": {"data_source_ids": ["0001"], "system_ids": ["SYS-X"]},
    }[datasource_name]


class WorkspaceRoutingTest(unittest.TestCase):
    def test_resolves_prefixed_flat_workspace_directories(self):
        items = gusen_hub.list_workspaces(config())
        self.assertEqual([item["displayName"] for item in items], ["PRD 产品", "PRJ 项目A", "PRJ 项目B"])
        self.assertEqual(gusen_hub.resolve_workspace(config(), "projects.a")["root"].name, "PRJ 项目A")

    @patch.object(gusen_hub, "resolve_system_scope", side_effect=scope)
    def test_routes_unique_identity_and_returns_ambiguous_candidates(self, _mock):
        unique = gusen_hub.route_workspace_request(
            config(), {"dataSourceId": "0015", "systemId": "SYS-P", "pageOrigin": "http://demo"}
        )
        self.assertEqual(unique["workspaceKey"], "products.demo")
        ambiguous = gusen_hub.route_workspace_request(
            config(), {"dataSourceId": "0001", "systemId": "SYS-X", "pageOrigin": "http://demo"}
        )
        self.assertTrue(ambiguous["workspaceSelectionRequired"])
        self.assertEqual([item["workspaceKey"] for item in ambiguous["candidates"]], ["projects.a", "projects.b"])

    @patch.object(gusen_hub, "resolve_system_scope", side_effect=scope)
    def test_rejects_explicit_workspace_with_mismatched_page_identity(self, _mock):
        with self.assertRaisesRegex(SystemExit, "does not match"):
            gusen_hub.route_workspace_request(
                config(),
                {
                    "workspaceKey": "products.demo",
                    "dataSourceId": "0001",
                    "systemId": "SYS-X",
                    "pageOrigin": "http://demo",
                },
            )

    def test_tiny_yaml_keeps_empty_collections(self):
        self.assertEqual(gusen_hub._scalar("[]"), [])
        self.assertEqual(gusen_hub._scalar("{}"), {})

    def test_auto_add_stages_only_files_created_by_current_operation(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            subprocess.run(["git", "init", "-q", str(repo)], check=True)
            root = repo / "workspace" / "PRD 产品"
            root.mkdir(parents=True)
            (root / "old.txt").write_text("old", encoding="utf-8")
            with patch.object(gusen_hub, "VAR_DIR", repo):
                before = gusen_hub.untracked_files()
                (root / "new.txt").write_text("new", encoding="utf-8")
                result = gusen_hub.auto_add_operation_files(
                    {"sync": {"rules": {"pull_auto_add_git": True}}},
                    before,
                    {"root": root},
                )
            self.assertEqual(result["gitAddStatus"], "ADDED")
            staged = subprocess.run(
                ["git", "-c", "core.quotePath=false", "-C", str(repo), "diff", "--cached", "--name-only"],
                check=True,
                capture_output=True,
                text=True,
            ).stdout.splitlines()
            self.assertEqual(staged, ["workspace/PRD 产品/new.txt"])


if __name__ == "__main__":
    unittest.main()
