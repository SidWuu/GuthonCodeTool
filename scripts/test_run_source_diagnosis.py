import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import run_source_diagnosis as diagnosis  # noqa: E402


class FakeCursor:
    def __init__(self, connection):
        self.connection = connection
        self.rows = []
        self.rowcount = 0

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def mogrify(self, sql, params):
        rendered = sql
        for value in params:
            rendered = rendered.replace("%s", repr(value), 1)
        return rendered

    def execute(self, sql, params=()):
        self.connection.calls.append((sql, params))
        if sql == "START TRANSACTION READ ONLY":
            return
        self.rows = self.connection.results.pop(0)
        self.rowcount = len(self.rows)

    def fetchmany(self, size):
        return self.rows[:size]


class FakeConnection:
    def __init__(self, results):
        self.results = list(results)
        self.calls = []
        self.autocommit_value = None
        self.rolled_back = False
        self.closed = False

    def autocommit(self, value):
        self.autocommit_value = value

    def cursor(self):
        return FakeCursor(self)

    def rollback(self):
        self.rolled_back = True

    def close(self):
        self.closed = True


def sample_case():
    return {
        "name": "测试排查",
        "source_scope": "products.gdrm-product",
        "datasource": "gdrm-product-test",
        "database": "yshj_fxglx",
        "parameters": {"批号": "B001"},
        "max_rows": 2,
        "steps": [
            {
                "id": "01",
                "name": "入口检查",
                "source": "demo.vm:10",
                "logic": "入口数据必须存在",
                "sql": "SELECT ID FROM DEMO WHERE BATCH = %s",
                "bindings": ["批号"],
                "continue_when": "rows_found",
                "stop_conclusion": "入口数据不存在",
            },
            {
                "id": "02",
                "name": "异常检查",
                "database": "yshj_basic",
                "source": "demo.vm:20",
                "logic": "不能存在异常数据",
                "sql": "SELECT ID FROM DEMO_ERROR WHERE BATCH = %s",
                "bindings": ["批号"],
                "continue_when": "no_rows",
                "stop_conclusion": "存在异常数据",
            },
        ],
    }


class SourceDiagnosisTest(unittest.TestCase):
    def test_stops_at_first_failed_step_and_rolls_back(self):
        case = diagnosis.validate_case(sample_case())
        connections = []
        results = {"yshj_fxglx": [[{"ID": 1}]], "yshj_basic": [[{"ID": 9}]]}

        def connect(datasource):
            connection = FakeConnection(results[datasource["database"]])
            connections.append((datasource["database"], connection))
            return connection

        run = diagnosis.execute_case(
            case,
            {"databases": ["yshj_fxglx", "yshj_basic"]},
            connect=connect,
        )

        self.assertEqual("02", run["stopped_at"])
        self.assertEqual("存在异常数据", run["conclusion"])
        self.assertEqual(["yshj_fxglx", "yshj_basic"], [item[0] for item in connections])
        for _database, connection in connections:
            self.assertEqual("START TRANSACTION READ ONLY", connection.calls[0][0])
            self.assertEqual(("B001",), connection.calls[1][1])
            self.assertTrue(connection.rolled_back)
            self.assertTrue(connection.closed)
            self.assertFalse(connection.autocommit_value)

    def test_report_contains_parameters_sql_results_and_stop(self):
        case = diagnosis.validate_case(sample_case())
        results = {"yshj_fxglx": [[{"ID": 1}]], "yshj_basic": [[]]}
        run = diagnosis.execute_case(
            case,
            {"databases": ["yshj_fxglx", "yshj_basic"]},
            connect=lambda datasource: FakeConnection(results[datasource["database"]]),
        )

        report = diagnosis.render_report(case, run, case["datasource"])

        self.assertIn("| 批号 | B001 |", report)
        self.assertIn("SELECT ID FROM DEMO WHERE BATCH = 'B001';", report)
        self.assertIn("`yshj_basic`", report)
        self.assertIn("| 1 |", report)
        self.assertIn("未停止，全部步骤执行完成", report)

    def test_rejects_non_select_and_dangerous_selects(self):
        rejected = (
            "UPDATE DEMO SET A = 1",
            "WITH X AS (SELECT 1) UPDATE DEMO SET A = 1",
            "SELECT 1; DELETE FROM DEMO",
            "SELECT * FROM DEMO FOR UPDATE",
            "SELECT * FROM DEMO INTO OUTFILE '/tmp/x'",
            "SELECT GET_LOCK('x', 1)",
            "SELECT custom_function()",
            "SELECT `custom_function`()",
            "SELECT demo.custom_function()",
            "SELECT \"custom_function\"()",
            "SELECT @x := 1",
            "SELECT 1 -- comment",
        )
        for sql in rejected:
            with self.subTest(sql=sql):
                with self.assertRaises(ValueError):
                    diagnosis.validate_single_select(sql)

        self.assertEqual(
            "SELECT DATABASE(), VERSION()",
            diagnosis.validate_single_select("SELECT DATABASE(), VERSION()"),
        )

    def test_datasource_must_be_enabled_test_query_only(self):
        valid = {
            "environment": "test",
            "diagnosis": {"enabled": True, "query_only": True},
            "databases": ["yshj_basic"],
        }
        diagnosis.validate_datasource("test", valid)
        for datasource in (
            {"environment": "dev", "diagnosis": {"enabled": True, "query_only": True}, "databases": ["yshj_basic"]},
            {"environment": "test", "diagnosis": {"enabled": False, "query_only": True}, "databases": ["yshj_basic"]},
            {"environment": "test", "diagnosis": {"enabled": True, "query_only": False}, "databases": ["yshj_basic"]},
            {"environment": "test", "diagnosis": {"enabled": True, "query_only": True}, "databases": []},
        ):
            with self.assertRaises(ValueError):
                diagnosis.validate_datasource("unsafe", datasource)

    def test_rejects_database_outside_allowlist(self):
        case = diagnosis.validate_case(sample_case())
        case["steps"][0]["database"] = "mysql"

        run = diagnosis.execute_case(
            case,
            {"databases": ["yshj_basic"]},
            connect=lambda _datasource: self.fail("不应建立数据库连接"),
        )

        self.assertEqual("01", run["stopped_at"])
        self.assertIn("不在数据源允许列表", run["conclusion"])


if __name__ == "__main__":
    unittest.main()
