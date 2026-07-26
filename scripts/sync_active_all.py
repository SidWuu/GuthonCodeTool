#!/usr/bin/env python3
"""Run every export required after switching sync.ACTIVE."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import gusen_hub


ROOT = Path(__file__).resolve().parents[1]
STEPS = (
    ("源码与索引", "run_sync_once.py"),
    ("数据库表结构", "export_table_schema_sql.py"),
    ("单据类型", "export_bill_type_sql.py"),
    ("系统脚本", "export_system_script_sql.py"),
    ("视图", "export_view_sql.py"),
)


def current_active():
    return gusen_hub.resolve_active(gusen_hub.load_config())[0]


def main(runner=subprocess.run):
    try:
        expected_active = current_active()
    except (Exception, SystemExit) as error:
        print(f"同步中止：{error}", file=sys.stderr)
        return 1

    print(f"sync.ACTIVE: {expected_active}", flush=True)
    completed = []
    for index, (label, script_name) in enumerate(STEPS, 1):
        try:
            actual_active = current_active()
            if actual_active != expected_active:
                raise RuntimeError(
                    f"sync.ACTIVE 已从 {expected_active} 变更为 {actual_active}"
                )
            print(f"[{index}/{len(STEPS)}] {label}", flush=True)
            runner(
                [sys.executable, str(ROOT / "scripts" / script_name)],
                cwd=ROOT,
                check=True,
            )
        except subprocess.CalledProcessError as error:
            done = "、".join(completed) or "无"
            print(
                f"同步中止：{label}失败（退出码 {error.returncode}）；已完成：{done}",
                file=sys.stderr,
            )
            return error.returncode if error.returncode > 0 else 1
        except (Exception, SystemExit) as error:
            done = "、".join(completed) or "无"
            print(
                f"同步中止：执行{label}前校验失败：{error}；已完成：{done}",
                file=sys.stderr,
            )
            return 1
        completed.append(label)

    print(f"同步完成：{'、'.join(completed)}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
