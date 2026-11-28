import copy
import json
import unittest

from common.database_source_merge import merge_database_source


class DatabaseSourceMergeTest(unittest.TestCase):
    def merge_page(self, base, local, remote):
        content, conflicts = merge_database_source(*(json.dumps(value) for value in (base, local, remote)),
                                                    page_type="1", page_alias="demo.page")
        return (json.loads(content) if content is not None else None), conflicts

    def page(self, fields):
        return {"pageId": "PG-TEST", "pageType": 1, "views": {"rows": [{
            "id": "row", "component": {"fields": fields},
        }]}}

    def fields(self, page):
        return page["views"]["rows"][0]["component"]["fields"]

    def test_merge_fields_by_identity_and_keep_native_defaults(self):
        base = self.page([{"fieldId": "CODE", "label": "Code"}, {"fieldId": "NAME", "width": 70}])
        local, remote = copy.deepcopy(base), copy.deepcopy(base)
        self.fields(local)[0]["label"] = "SKU"
        self.fields(local).append({"fieldId": "NOTE"})
        self.fields(remote)[0]["sortable"] = 1
        self.fields(remote)[1]["width"] = 80
        self.fields(remote).append({"fieldId": "OWNER"})
        remote["pageAliasId"] = "demo.page"
        merged, conflicts = self.merge_page(base, local, remote)
        self.assertEqual([], conflicts)
        self.assertEqual("demo.page", merged["pageAliasId"])
        self.assertEqual([
            {"fieldId": "CODE", "label": "SKU", "sortable": 1}, {"fieldId": "NAME", "width": 80},
            {"fieldId": "OWNER"}, {"fieldId": "NOTE"},
        ], self.fields(merged))

    def test_overlapping_values_and_scripts_return_precise_conflicts(self):
        original = {"fieldId": "CODE", "width": 80, "pageEvents": {"onChangeScript": "x();\ny();"}}
        base, local, remote = (self.page([copy.deepcopy(original)]) for _ in range(3))
        for page, width, text in ((local, 90, "local();"), (remote, 100, "remote();")):
            field = self.fields(page)[0]
            field.update(width=width, pageEvents={"onChangeScript": text + "\ny();"})
        merged, conflicts = self.merge_page(base, local, remote)
        self.assertIsNone(merged)
        self.assertEqual({
            ("value", "/views/rows/0/component/fields/0/width"),
            ("script", "/views/rows/0/component/fields/0/pageEvents/onChangeScript"),
        }, {(item["kind"], item["path"]) for item in conflicts})
        self.assertEqual([1], next(item["lines"] for item in conflicts if item["kind"] == "script"))

    def test_conflicting_array_identity_or_order_is_never_guessed(self):
        def order(ids):
            return self.page([{"fieldId": key} for key in ids])

        merged, conflicts = self.merge_page(order("ABC"), order("BAC"), order("ACB"))
        self.assertIsNone(merged)
        self.assertEqual("collection", conflicts[0]["kind"])
        merged, conflicts = self.merge_page(self.page([{"width": 1}]), self.page([{"width": 2}]), self.page([{"label": "New"}]))
        self.assertIsNone(merged)
        self.assertEqual("collection", conflicts[0]["kind"])

    def test_procedures_and_service_scripts_merge_disjoint_lines(self):
        base, local, remote = "a();\nb();\nc();\n", "local();\nb();\nc();\n", "a();\nb();\nremote();\n"
        merged, conflicts = merge_database_source(base, local, remote)
        self.assertEqual(("local();\nb();\nremote();", []), (merged, conflicts))

        common = {"pageId": "PG-SERVICE", "pageType": 0}
        sources = [json.dumps({**common, "compScript": content}) for content in (base, local)]
        live = {**common, "compScript": remote, "isCanInter": 1}
        content, conflicts = merge_database_source(*sources, json.dumps(live), page_type="0", page_alias="")
        self.assertEqual([], conflicts)
        self.assertEqual({**live, "compScript": "local();\nb();\nremote();\n"}, json.loads(content))
