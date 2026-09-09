#!/usr/bin/env python3
"""Validate and evaluate artifacts produced by the DBX database-test workflow.

This module never connects to a database. Codex uses the configured DBX tools to
collect read-only evidence, normalizes that evidence, and passes it here for
deterministic target resolution, assertions, and report rendering.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path
from typing import Any

from common import gusen_hub
from providers.database.run_source_diagnosis import validate_single_select


SCHEMA_VERSION = 1
WORKSPACE_KEY = re.compile(r"^(?:products|projects)\.[A-Za-z0-9._-]+$")
IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_$]*$")
TABLE_REFERENCE = re.compile(
    r"\b(?:FROM|JOIN)\s+([A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)?)",
    re.IGNORECASE,
)
ASSERTION_TYPES = {
    "scalar_equals",
    "decimal_equals",
    "rows_empty",
    "row_count_equals",
    "keyed_rows_equals",
}
TRUNCATION_VALUES = {"none", "rows", "cell", "unknown"}
CASE_LEVELS = {"query", "platform-result"}
ENVIRONMENTS = {"dev", "test"}


class ArtifactError(ValueError):
    """A validation or workflow gate failure with a stable error code."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def load_yaml(path: Path) -> dict:
    value = gusen_hub.load_yaml(path)
    if not isinstance(value, dict):
        raise ArtifactError("CONFIG_INVALID", "数据库测试配置必须是 YAML 对象")
    return value


def load_json(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ArtifactError("ARTIFACT_INVALID", f"JSON 产物必须是对象: {path}")
    return value


def digest(value: dict) -> str:
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _require_keys(value: dict, required: set[str], context: str) -> None:
    missing = sorted(key for key in required if key not in value or value.get(key) in (None, ""))
    if missing:
        raise ArtifactError("ARTIFACT_INVALID", f"{context} 缺少字段: {', '.join(missing)}")


def _reject_unknown(value: dict, allowed: set[str], context: str) -> None:
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise ArtifactError("ARTIFACT_INVALID", f"{context} 包含未知字段: {', '.join(unknown)}")


def _is_placeholder(value: str) -> bool:
    lowered = value.strip().lower()
    return (
        not lowered
        or "<" in value
        or ">" in value
        or lowered.startswith("replace-")
        or ".example" in lowered
    )


def validate_config(config: dict) -> dict:
    _reject_unknown(config, {"schemaVersion", "expectedIdentities", "databaseTests"}, "配置")
    if config.get("schemaVersion") != SCHEMA_VERSION:
        raise ArtifactError("CONFIG_VERSION_UNSUPPORTED", "仅支持 schemaVersion=1")
    identities = config.get("expectedIdentities")
    workspaces = config.get("databaseTests")
    if not isinstance(identities, dict) or not identities:
        raise ArtifactError("CONFIG_INVALID", "expectedIdentities 必须是非空对象")
    if not isinstance(workspaces, dict) or not workspaces:
        raise ArtifactError("CONFIG_INVALID", "databaseTests 必须是非空对象")

    for identity_id, identity in identities.items():
        if not isinstance(identity, dict):
            raise ArtifactError("CONFIG_INVALID", f"环境身份 {identity_id} 必须是对象")
        _reject_unknown(identity, {"engine", "endpoint", "database", "schema", "evidenceRef"}, f"环境身份 {identity_id}")
        _require_keys(identity, {"engine", "endpoint", "database", "evidenceRef"}, f"环境身份 {identity_id}")
        if identity["engine"] not in {"mysql", "oracle"}:
            raise ArtifactError("UNSUPPORTED", f"仅支持 MySQL/Oracle: {identity_id}")
        if identity["engine"] == "oracle" and not identity.get("schema"):
            raise ArtifactError("CONFIG_INVALID", f"Oracle 环境身份必须配置 schema: {identity_id}")
        if identity.get("schema") and not IDENTIFIER.fullmatch(str(identity["schema"])):
            raise ArtifactError("CONFIG_INVALID", f"环境身份 {identity_id} 的 schema 无效")
        if _is_placeholder(str(identity["endpoint"])) or _is_placeholder(str(identity["evidenceRef"])):
            raise ArtifactError("ENVIRONMENT_UNVERIFIED", f"环境身份 {identity_id} 仍包含占位值")

    for workspace_key, workspace_config in workspaces.items():
        if not WORKSPACE_KEY.fullmatch(str(workspace_key)):
            raise ArtifactError("CONFIG_INVALID", f"无效 workspaceKey: {workspace_key}")
        if not isinstance(workspace_config, dict):
            raise ArtifactError("CONFIG_INVALID", f"工作区配置必须是对象: {workspace_key}")
        _reject_unknown(workspace_config, {"targets"}, f"工作区 {workspace_key}")
        targets = workspace_config.get("targets")
        if not isinstance(targets, list) or not targets:
            raise ArtifactError("CONFIG_INVALID", f"工作区 {workspace_key} 的 targets 必须是非空数组")
        seen: set[str] = set()
        for target in targets:
            validate_target(target, workspace_key, identities)
            if target["id"] in seen:
                raise ArtifactError("CONFIG_INVALID", f"工作区 {workspace_key} 的 target ID 重复: {target['id']}")
            seen.add(target["id"])
    return config


def validate_target(target: Any, workspace_key: str, identities: dict) -> None:
    if not isinstance(target, dict):
        raise ArtifactError("CONFIG_INVALID", f"工作区 {workspace_key} 的 target 必须是对象")
    allowed = {
        "id",
        "systemId",
        "dataSourceId",
        "connectionId",
        "database",
        "schema",
        "environment",
        "access",
        "expectedIdentityRef",
        "allowedTables",
        "tenantScope",
    }
    _reject_unknown(target, allowed, f"target {target.get('id', '?')}")
    required = {
        "id",
        "systemId",
        "dataSourceId",
        "connectionId",
        "database",
        "environment",
        "access",
        "expectedIdentityRef",
        "allowedTables",
        "tenantScope",
    }
    _require_keys(target, required, f"工作区 {workspace_key} 的 target")
    if _is_placeholder(str(target["connectionId"])):
        raise ArtifactError("CONNECTION_MISSING", f"target {target['id']} 仍使用占位 connectionId")
    if target["environment"] not in ENVIRONMENTS:
        raise ArtifactError("CONFIG_INVALID", f"target {target['id']} 的 environment 仅允许 dev/test")
    if target["access"] != "read-only":
        raise ArtifactError("UNSUPPORTED", f"target {target['id']} 首版仅允许 read-only")
    if not IDENTIFIER.fullmatch(str(target["database"])):
        raise ArtifactError("CONFIG_INVALID", f"target {target['id']} 的 database 无效")
    if target.get("schema") and not IDENTIFIER.fullmatch(str(target["schema"])):
        raise ArtifactError("CONFIG_INVALID", f"target {target['id']} 的 schema 无效")
    tables = target["allowedTables"]
    if not isinstance(tables, list) or not tables or "*" in tables:
        raise ArtifactError("CONFIG_INVALID", f"target {target['id']} 必须配置非通配 allowedTables")
    if any(not IDENTIFIER.fullmatch(str(table)) for table in tables):
        raise ArtifactError("CONFIG_INVALID", f"target {target['id']} 包含无效表名")
    identity_ref = str(target["expectedIdentityRef"])
    if identity_ref not in identities:
        raise ArtifactError("CONFIG_INVALID", f"target {target['id']} 的 expectedIdentityRef 不存在")
    identity = identities[identity_ref]
    if identity["database"].lower() != str(target["database"]).lower():
        raise ArtifactError("ENVIRONMENT_MISMATCH", f"target {target['id']} 与环境身份的 database 不一致")
    identity_schema = str(identity.get("schema") or "")
    target_schema = str(target.get("schema") or "")
    if identity["engine"] == "oracle" and not target_schema:
        raise ArtifactError("CONFIG_INVALID", f"Oracle target 必须配置 schema: {target['id']}")
    if identity_schema.lower() != target_schema.lower():
        raise ArtifactError("ENVIRONMENT_MISMATCH", f"target {target['id']} 与环境身份的 schema 不一致")
    tenant_scope = target["tenantScope"]
    if not isinstance(tenant_scope, dict):
        raise ArtifactError("CONFIG_INVALID", f"target {target['id']} 的 tenantScope 必须是对象")
    _reject_unknown(tenant_scope, {"field", "evidenceRef"}, f"target {target['id']} tenantScope")
    _require_keys(tenant_scope, {"field", "evidenceRef"}, f"target {target['id']} tenantScope")
    if not IDENTIFIER.fullmatch(str(tenant_scope["field"])):
        raise ArtifactError("CONFIG_INVALID", f"target {target['id']} 的租户字段无效")
    if _is_placeholder(str(tenant_scope["evidenceRef"])):
        raise ArtifactError("ENVIRONMENT_UNVERIFIED", f"target {target['id']} 的租户证据仍是占位值")


def resolve_target(
    config: dict,
    workspace_key: str,
    *,
    system_id: str,
    data_source_id: str,
    target_id: str = "",
) -> dict:
    validate_config(config)
    workspace = config["databaseTests"].get(workspace_key)
    if not workspace:
        raise ArtifactError("BINDING_MISSING", f"工作区未配置数据库测试目标: {workspace_key}")
    matches = [
        target
        for target in workspace["targets"]
        if str(target["systemId"]) == system_id
        and str(target["dataSourceId"]) == data_source_id
        and (not target_id or target["id"] == target_id)
    ]
    if not matches:
        raise ArtifactError(
            "BINDING_MISSING",
            f"没有匹配 target: workspace={workspace_key}, systemId={system_id}, dataSourceId={data_source_id}",
        )
    if len(matches) > 1:
        ids = ", ".join(sorted(target["id"] for target in matches))
        raise ArtifactError("BINDING_AMBIGUOUS", f"多个 target 同时匹配: {ids}")
    return matches[0]


def validate_plan(plan: dict, config: dict | None = None) -> dict:
    allowed = {"schemaVersion", "taskId", "workspaceKey", "sourceMode", "sourceDigest", "cases"}
    _reject_unknown(plan, allowed, "测试计划")
    _require_keys(plan, {"taskId", "workspaceKey", "sourceMode", "sourceDigest", "cases"}, "测试计划")
    if plan.get("schemaVersion") != SCHEMA_VERSION:
        raise ArtifactError("PLAN_VERSION_UNSUPPORTED", "测试计划仅支持 schemaVersion=1")
    if not WORKSPACE_KEY.fullmatch(str(plan["workspaceKey"])):
        raise ArtifactError("ARTIFACT_INVALID", "测试计划 workspaceKey 无效")
    if plan["sourceMode"] not in {"database", "svn"}:
        raise ArtifactError("ARTIFACT_INVALID", "测试计划 sourceMode 仅允许 database/svn")
    if _is_placeholder(str(plan["sourceDigest"])):
        raise ArtifactError("ARTIFACT_INVALID", "测试计划 sourceDigest 仍是占位值")
    if not isinstance(plan["cases"], list) or not plan["cases"]:
        raise ArtifactError("ARTIFACT_INVALID", "测试计划 cases 必须是非空数组")
    if config is not None:
        validate_config(config)
        if plan["workspaceKey"] not in config["databaseTests"]:
            raise ArtifactError("BINDING_MISSING", f"测试计划工作区未配置: {plan['workspaceKey']}")

    case_ids: set[str] = set()
    targets_by_id = {}
    if config is not None:
        targets_by_id = {
            target["id"]: target
            for target in config["databaseTests"][plan["workspaceKey"]]["targets"]
        }
    for case in plan["cases"]:
        validate_case(case, targets_by_id.get(case.get("targetId")) if targets_by_id else None)
        if case["caseId"] in case_ids:
            raise ArtifactError("ARTIFACT_INVALID", f"caseId 重复: {case['caseId']}")
        case_ids.add(case["caseId"])
        if config is not None and case["targetId"] not in targets_by_id:
            raise ArtifactError("BINDING_MISSING", f"用例 {case['caseId']} 的 target 不存在: {case['targetId']}")
    return plan


def validate_case(case: Any, target: dict | None = None) -> None:
    if not isinstance(case, dict):
        raise ArtifactError("ARTIFACT_INVALID", "测试用例必须是对象")
    allowed = {
        "caseId",
        "requirementIds",
        "targetId",
        "level",
        "sourceEvidence",
        "preconditions",
        "checks",
        "expectedBasis",
        "cleanup",
        "platform",
    }
    _reject_unknown(case, allowed, f"用例 {case.get('caseId', '?')}")
    required = {
        "caseId",
        "requirementIds",
        "targetId",
        "level",
        "sourceEvidence",
        "checks",
        "expectedBasis",
        "cleanup",
    }
    _require_keys(case, required, f"用例 {case.get('caseId', '?')}")
    if case["level"] not in CASE_LEVELS:
        raise ArtifactError("ARTIFACT_INVALID", f"用例 {case['caseId']} 的 level 无效")
    for field in ("requirementIds", "sourceEvidence", "checks"):
        if not isinstance(case[field], list) or not case[field]:
            raise ArtifactError("ARTIFACT_INVALID", f"用例 {case['caseId']} 的 {field} 必须是非空数组")
    if any(_is_placeholder(str(item)) for item in case["sourceEvidence"]):
        raise ArtifactError("ARTIFACT_INVALID", f"用例 {case['caseId']} 的 sourceEvidence 仍有占位值")
    preconditions = case.get("preconditions", [])
    if not isinstance(preconditions, list):
        raise ArtifactError("ARTIFACT_INVALID", f"用例 {case['caseId']} 的 preconditions 必须是数组")
    cleanup = case["cleanup"]
    if not isinstance(cleanup, dict) or "required" not in cleanup or not str(cleanup.get("reason") or ""):
        raise ArtifactError("ARTIFACT_INVALID", f"用例 {case['caseId']} 的 cleanup 无效")
    if case["level"] == "platform-result" and not isinstance(case.get("platform"), dict):
        raise ArtifactError("ARTIFACT_INVALID", f"平台用例 {case['caseId']} 缺少 platform 证据要求")

    step_ids: set[str] = set()
    for step in [*preconditions, *case["checks"]]:
        validate_step(step, case["caseId"], target)
        if step["id"] in step_ids:
            raise ArtifactError("ARTIFACT_INVALID", f"用例 {case['caseId']} 的步骤 ID 重复: {step['id']}")
        step_ids.add(step["id"])


def validate_step(step: Any, case_id: str, target: dict | None) -> None:
    if not isinstance(step, dict):
        raise ArtifactError("ARTIFACT_INVALID", f"用例 {case_id} 的步骤必须是对象")
    _reject_unknown(step, {"id", "sql", "assert"}, f"用例 {case_id} 步骤")
    _require_keys(step, {"id", "sql", "assert"}, f"用例 {case_id} 步骤")
    try:
        validate_single_select(str(step["sql"]))
    except ValueError as error:
        raise ArtifactError("QUERY_UNSUPPORTED", f"用例 {case_id} 步骤 {step['id']}: {error}") from error
    assertion = step["assert"]
    if not isinstance(assertion, dict) or assertion.get("type") not in ASSERTION_TYPES:
        raise ArtifactError("ASSERTION_UNSUPPORTED", f"用例 {case_id} 步骤 {step['id']} 的断言不支持")
    validate_assertion(assertion)
    if target is not None:
        validate_sql_scope(str(step["sql"]), target, case_id, str(step["id"]))


def validate_sql_scope(sql: str, target: dict, case_id: str, step_id: str) -> None:
    if _has_top_level_comma_join(sql):
        raise ArtifactError("QUERY_UNSUPPORTED", f"用例 {case_id} 步骤 {step_id} 不支持逗号连接，请使用显式 JOIN")
    allowed = {str(table).lower() for table in target["allowedTables"]}
    found = TABLE_REFERENCE.findall(sql)
    if not found:
        raise ArtifactError("QUERY_UNSUPPORTED", f"用例 {case_id} 步骤 {step_id} 无法识别数据表")
    expected_qualifier = str(target.get("schema") or target["database"]).lower()
    for reference in found:
        parts = reference.split(".")
        if len(parts) == 2 and parts[0].lower() != expected_qualifier:
            raise ArtifactError("CROSS_DATABASE_DENIED", f"用例 {case_id} 步骤 {step_id} 引用了未授权数据库或 schema")
        table = parts[-1].lower()
        if table not in allowed:
            raise ArtifactError("TABLE_DENIED", f"用例 {case_id} 步骤 {step_id} 引用了未授权表: {parts[-1]}")


def _has_top_level_comma_join(sql: str) -> bool:
    tokens = list(re.finditer(r"[A-Za-z_][A-Za-z0-9_$]*|[(),]", sql))
    depth = 0
    in_from = False
    terminators = {"WHERE", "GROUP", "ORDER", "HAVING", "LIMIT", "UNION", "FOR"}
    for match in tokens:
        token = match.group(0).upper()
        if token == "(":
            depth += 1
        elif token == ")":
            depth = max(0, depth - 1)
        elif depth == 0 and token == "FROM":
            in_from = True
        elif depth == 0 and in_from and token in terminators:
            in_from = False
        elif depth == 0 and in_from and token == ",":
            return True
    return False


def validate_assertion(assertion: dict) -> None:
    kind = assertion["type"]
    if kind == "rows_empty":
        _reject_unknown(assertion, {"type"}, kind)
    elif kind == "row_count_equals":
        _reject_unknown(assertion, {"type", "expected"}, kind)
        expected = assertion.get("expected")
        if not isinstance(expected, int) or isinstance(expected, bool) or expected < 0:
            raise ArtifactError("ASSERTION_UNSUPPORTED", "row_count_equals.expected 必须是非负整数")
    elif kind == "scalar_equals":
        _reject_unknown(assertion, {"type", "column", "expected", "valueType"}, kind)
        if not isinstance(assertion.get("column"), str) or not assertion["column"]:
            raise ArtifactError("ASSERTION_UNSUPPORTED", "scalar_equals.column 必填")
        if "expected" not in assertion:
            raise ArtifactError("ASSERTION_UNSUPPORTED", "scalar_equals.expected 必填")
        if assertion.get("valueType") not in {None, "string", "integer", "boolean", "decimal"}:
            raise ArtifactError("ASSERTION_UNSUPPORTED", "scalar_equals.valueType 无效")
    elif kind == "decimal_equals":
        _reject_unknown(assertion, {"type", "column", "expected", "precision", "tolerance"}, kind)
        if not isinstance(assertion.get("column"), str) or not assertion["column"]:
            raise ArtifactError("ASSERTION_UNSUPPORTED", "decimal_equals.column 必填")
        if "expected" not in assertion:
            raise ArtifactError("ASSERTION_UNSUPPORTED", "decimal_equals.expected 必填")
        precision = assertion.get("precision")
        if not isinstance(precision, int) or isinstance(precision, bool) or not 0 <= precision <= 18:
            raise ArtifactError("ASSERTION_UNSUPPORTED", "decimal_equals.precision 必须是 0..18 的整数")
    else:
        _reject_unknown(assertion, {"type", "keys", "expectedRows"}, kind)
        keys = assertion.get("keys")
        expected_rows = assertion.get("expectedRows")
        if not isinstance(keys, list) or not keys or not all(isinstance(key, str) and key for key in keys):
            raise ArtifactError("ASSERTION_UNSUPPORTED", "keyed_rows_equals.keys 必须是非空字符串数组")
        if not isinstance(expected_rows, list) or any(not isinstance(row, dict) for row in expected_rows):
            raise ArtifactError("ASSERTION_UNSUPPORTED", "keyed_rows_equals.expectedRows 必须是对象数组")


def evaluate(plan: dict, results: dict, config: dict | None = None) -> dict:
    validate_plan(plan, config)
    validate_results(results, plan)
    stale = results["sourceDigest"] != plan["sourceDigest"] or results["planDigest"] != digest(plan)
    indexed = {
        (result["caseId"], result["stepId"]): result
        for result in results["steps"]
    }
    case_results = []
    for case in plan["cases"]:
        if stale:
            case_results.append(_case_gate(case, "BLOCKED", "SOURCE_DIGEST_MISMATCH", "源码或测试计划摘要已变化"))
            continue
        target_gate = _target_verification(case, results, config, plan["workspaceKey"])
        if target_gate is not None:
            case_results.append(target_gate)
            continue
        if case["level"] == "platform-result" and not _platform_verified(case, results, plan["sourceDigest"]):
            case_results.append(_case_gate(case, "BLOCKED", "VERSION_UNVERIFIED", "缺少可核验的平台版本或触发证据"))
            continue
        evaluated_steps = []
        blocked = None
        for step in case.get("preconditions", []):
            outcome = evaluate_step(step, indexed.get((case["caseId"], step["id"])))
            evaluated_steps.append({"kind": "precondition", **outcome})
            if outcome["status"] != "PASS":
                code = outcome["errorCode"] if outcome["status"] == "BLOCKED" else "PRECONDITION_UNMET"
                blocked = _case_gate(case, "BLOCKED", code, f"前置条件未满足: {step['id']}", evaluated_steps)
                break
        if blocked:
            case_results.append(blocked)
            continue
        failed = False
        for step in case["checks"]:
            outcome = evaluate_step(step, indexed.get((case["caseId"], step["id"])))
            evaluated_steps.append({"kind": "check", **outcome})
            failed = failed or outcome["status"] == "FAIL"
        if failed:
            case_results.append(_case_gate(case, "FAIL", "ASSERTION_FAILED", "业务断言失败", evaluated_steps))
        elif any(item["status"] == "BLOCKED" for item in evaluated_steps):
            first = next(item for item in evaluated_steps if item["status"] == "BLOCKED")
            case_results.append(_case_gate(case, "BLOCKED", first["errorCode"], first["message"], evaluated_steps))
        else:
            case_results.append(_case_gate(case, "PASS", "", "全部断言通过", evaluated_steps))

    if any(case["status"] == "FAIL" for case in case_results):
        status = "FAIL"
    elif any(case["status"] == "BLOCKED" for case in case_results):
        status = "BLOCKED"
    else:
        status = "PASS"
    return {
        "schemaVersion": SCHEMA_VERSION,
        "taskId": plan["taskId"],
        "runId": results["runId"],
        "workspaceKey": plan["workspaceKey"],
        "sourceDigest": plan["sourceDigest"],
        "planDigest": digest(plan),
        "status": status,
        "cases": case_results,
    }


def validate_results(results: dict, plan: dict) -> dict:
    allowed = {
        "schemaVersion",
        "taskId",
        "workspaceKey",
        "sourceDigest",
        "planDigest",
        "runId",
        "targetVerification",
        "platformEvidence",
        "steps",
    }
    _reject_unknown(results, allowed, "规范化结果")
    required = {
        "taskId",
        "workspaceKey",
        "sourceDigest",
        "planDigest",
        "runId",
        "targetVerification",
        "steps",
    }
    _require_keys(results, required, "规范化结果")
    if results.get("schemaVersion") != SCHEMA_VERSION:
        raise ArtifactError("RESULT_VERSION_UNSUPPORTED", "规范化结果仅支持 schemaVersion=1")
    if results["taskId"] != plan["taskId"] or results["workspaceKey"] != plan["workspaceKey"]:
        raise ArtifactError("RESULT_UNSUPPORTED", "规范化结果与测试计划身份不一致")
    if not isinstance(results["steps"], list):
        raise ArtifactError("RESULT_UNSUPPORTED", "规范化结果 steps 必须是数组")
    verifications = results["targetVerification"]
    if not isinstance(verifications, dict) or not verifications:
        raise ArtifactError("ENVIRONMENT_UNVERIFIED", "targetVerification 必须按 targetId 记录核验结果")
    for target_id, verification in verifications.items():
        if not isinstance(verification, dict):
            raise ArtifactError("ENVIRONMENT_UNVERIFIED", f"target {target_id} 的核验结果必须是对象")
        _require_keys(verification, {"status", "targetDigest", "evidenceRef"}, f"target {target_id} 核验结果")
        if verification["status"] not in {"PASS", "BLOCKED"}:
            raise ArtifactError("ENVIRONMENT_UNVERIFIED", f"target {target_id} 的核验状态无效")
        if _is_placeholder(str(verification["targetDigest"])) or _is_placeholder(str(verification["evidenceRef"])):
            raise ArtifactError("ENVIRONMENT_UNVERIFIED", f"target {target_id} 的核验证据仍是占位值")
    expected_targets = {
        (case["caseId"], step["id"]): case["targetId"]
        for case in plan["cases"]
        for step in [*case.get("preconditions", []), *case["checks"]]
    }
    seen: set[tuple[str, str]] = set()
    for result in results["steps"]:
        if not isinstance(result, dict):
            raise ArtifactError("RESULT_UNSUPPORTED", "规范化步骤必须是对象")
        required_step = {
            "caseId",
            "stepId",
            "targetId",
            "startedAt",
            "finishedAt",
            "status",
            "columns",
            "rows",
            "truncation",
            "rawEvidenceRef",
        }
        _require_keys(result, required_step, "规范化步骤")
        if result["status"] not in {"SUCCESS", "ERROR"}:
            raise ArtifactError("RESULT_UNSUPPORTED", f"无效查询状态: {result['status']}")
        if result["truncation"] not in TRUNCATION_VALUES:
            raise ArtifactError("RESULT_UNSUPPORTED", f"无效 truncation: {result['truncation']}")
        if not isinstance(result["columns"], list) or not isinstance(result["rows"], list):
            raise ArtifactError("RESULT_UNSUPPORTED", "columns/rows 类型无效")
        if _is_placeholder(str(result["rawEvidenceRef"])):
            raise ArtifactError("RESULT_UNSUPPORTED", f"步骤证据仍是占位值: {result['caseId']}/{result['stepId']}")
        key = (result["caseId"], result["stepId"])
        expected_target = expected_targets.get(key)
        if expected_target is None:
            raise ArtifactError("RESULT_UNSUPPORTED", f"规范化结果包含计划外步骤: {key[0]}/{key[1]}")
        if result["targetId"] != expected_target:
            raise ArtifactError("ENVIRONMENT_MISMATCH", f"步骤 {key[0]}/{key[1]} 使用了错误 target")
        if key in seen:
            raise ArtifactError("RESULT_UNSUPPORTED", f"规范化步骤重复: {key[0]}/{key[1]}")
        seen.add(key)
    return results


def evaluate_step(step: dict, result: dict | None) -> dict:
    if result is None:
        return _step_outcome(step, "BLOCKED", "RESULT_UNSUPPORTED", "缺少查询结果")
    if result["status"] != "SUCCESS":
        return _step_outcome(
            step,
            "BLOCKED",
            str(result.get("errorCode") or "QUERY_FAILED"),
            str(result.get("message") or "查询未成功完成"),
            result,
        )
    if result["truncation"] != "none":
        code = "RESULT_TRUNCATED" if result["truncation"] in {"rows", "cell"} else "RESULT_UNSUPPORTED"
        return _step_outcome(step, "BLOCKED", code, f"结果完整性不足: {result['truncation']}", result)
    try:
        passed, actual = apply_assertion(step["assert"], result["rows"])
    except ArtifactError as error:
        return _step_outcome(step, "BLOCKED", error.code, str(error), result)
    return _step_outcome(
        step,
        "PASS" if passed else "FAIL",
        "" if passed else "ASSERTION_FAILED",
        "断言通过" if passed else "断言不满足",
        result,
        actual,
    )


def apply_assertion(assertion: dict, rows: list[dict]) -> tuple[bool, Any]:
    validate_assertion(assertion)
    kind = assertion["type"]
    if any(not isinstance(row, dict) for row in rows):
        raise ArtifactError("RESULT_UNSUPPORTED", "查询行必须是对象")
    if kind == "rows_empty":
        return not rows, {"rowCount": len(rows)}
    if kind == "row_count_equals":
        expected = assertion.get("expected")
        if not isinstance(expected, int) or isinstance(expected, bool):
            raise ArtifactError("ASSERTION_UNSUPPORTED", "row_count_equals.expected 必须是整数")
        return len(rows) == expected, {"rowCount": len(rows)}
    if kind in {"scalar_equals", "decimal_equals"}:
        column = assertion.get("column")
        if not isinstance(column, str) or not column:
            raise ArtifactError("ASSERTION_UNSUPPORTED", f"{kind}.column 必填")
        if len(rows) != 1 or column not in rows[0]:
            return False, {"rowCount": len(rows), "columnPresent": bool(rows and column in rows[0])}
        actual = rows[0][column]
        expected = assertion.get("expected")
        if kind == "scalar_equals":
            return _scalar_equal(actual, expected, assertion.get("valueType")), {"value": actual}
        return _decimal_equal(actual, expected, assertion), {"value": actual}
    if kind == "keyed_rows_equals":
        keys = assertion.get("keys")
        expected_rows = assertion.get("expectedRows")
        if not isinstance(keys, list) or not keys or not all(isinstance(key, str) and key for key in keys):
            raise ArtifactError("ASSERTION_UNSUPPORTED", "keyed_rows_equals.keys 必须是非空字符串数组")
        if not isinstance(expected_rows, list) or any(not isinstance(row, dict) for row in expected_rows):
            raise ArtifactError("ASSERTION_UNSUPPORTED", "keyed_rows_equals.expectedRows 必须是对象数组")
        actual_index = _keyed_index(rows, keys)
        expected_index = _keyed_index(expected_rows, keys)
        return actual_index == expected_index, {"rowCount": len(rows), "keys": keys}
    raise ArtifactError("ASSERTION_UNSUPPORTED", f"未知断言类型: {kind}")


def _scalar_equal(actual: Any, expected: Any, value_type: Any) -> bool:
    if value_type is None:
        return type(actual) is type(expected) and actual == expected
    if value_type == "string":
        return isinstance(actual, str) and isinstance(expected, str) and actual == expected
    if value_type == "integer":
        return type(actual) is int and type(expected) is int and actual == expected
    if value_type == "boolean":
        return type(actual) is bool and type(expected) is bool and actual == expected
    if value_type == "decimal":
        return _decimal_equal(actual, expected, {"precision": 18, "tolerance": "0"})
    raise ArtifactError("ASSERTION_UNSUPPORTED", f"不支持 scalar valueType: {value_type}")


def _decimal_equal(actual: Any, expected: Any, assertion: dict) -> bool:
    if actual is None or expected is None:
        return False
    precision = assertion.get("precision")
    if not isinstance(precision, int) or isinstance(precision, bool) or not 0 <= precision <= 18:
        raise ArtifactError("ASSERTION_UNSUPPORTED", "decimal_equals.precision 必须是 0..18 的整数")
    try:
        actual_decimal = Decimal(str(actual))
        expected_decimal = Decimal(str(expected))
        tolerance = Decimal(str(assertion.get("tolerance", "0")))
        quantum = Decimal(1).scaleb(-precision)
        actual_decimal = actual_decimal.quantize(quantum, rounding=ROUND_HALF_UP)
        expected_decimal = expected_decimal.quantize(quantum, rounding=ROUND_HALF_UP)
    except (InvalidOperation, ValueError) as error:
        raise ArtifactError("RESULT_UNSUPPORTED", "金额结果或期望值不是有效十进制数") from error
    if tolerance < 0:
        raise ArtifactError("ASSERTION_UNSUPPORTED", "decimal_equals.tolerance 不能为负数")
    return abs(actual_decimal - expected_decimal) <= tolerance


def _keyed_index(rows: list[dict], keys: list[str]) -> dict[tuple[Any, ...], str]:
    indexed = {}
    for row in rows:
        if any(key not in row for key in keys):
            raise ArtifactError("RESULT_UNSUPPORTED", "键集合字段缺失")
        key = tuple(row[item] for item in keys)
        try:
            hash(key)
        except TypeError as error:
            raise ArtifactError("RESULT_UNSUPPORTED", "唯一键值必须是标量") from error
        if key in indexed:
            raise ArtifactError("RESULT_UNSUPPORTED", f"声明唯一键重复: {key}")
        indexed[key] = json.dumps(row, ensure_ascii=False, sort_keys=True, default=str)
    return indexed


def _platform_verified(case: dict, results: dict, source_digest: str) -> bool:
    evidence = results.get("platformEvidence") or {}
    item = evidence.get(case["caseId"])
    if not isinstance(item, dict):
        return False
    references = [item.get("versionEvidenceRef"), item.get("triggerEvidenceRef"), item.get("correlationId")]
    return (
        item.get("status") == "VERIFIED"
        and item.get("sourceDigest") == source_digest
        and item.get("targetId") == case["targetId"]
        and all(value and not _is_placeholder(str(value)) for value in references)
    )


def _target_verification(
    case: dict,
    results: dict,
    config: dict | None,
    workspace_key: str,
) -> dict | None:
    verification = (results.get("targetVerification") or {}).get(case["targetId"])
    if not isinstance(verification, dict):
        return _case_gate(case, "BLOCKED", "ENVIRONMENT_UNVERIFIED", "缺少测试目标环境核验证据")
    if verification.get("status") != "PASS":
        return _case_gate(
            case,
            "BLOCKED",
            str(verification.get("errorCode") or "ENVIRONMENT_MISMATCH"),
            str(verification.get("message") or "测试目标环境核验未通过"),
        )
    if config is not None:
        targets = config["databaseTests"][workspace_key]["targets"]
        target = next((item for item in targets if item["id"] == case["targetId"]), None)
        if target is None or verification.get("targetDigest") != digest(target):
            return _case_gate(case, "BLOCKED", "ENVIRONMENT_UNVERIFIED", "测试目标映射摘要已变化")
    return None


def _step_outcome(
    step: dict,
    status: str,
    error_code: str,
    message: str,
    result: dict | None = None,
    actual: Any = None,
) -> dict:
    return {
        "stepId": step["id"],
        "status": status,
        "errorCode": error_code,
        "message": message,
        "expected": step["assert"],
        "actual": actual,
        "evidenceRef": "" if result is None else result.get("rawEvidenceRef", ""),
    }


def _case_gate(
    case: dict,
    status: str,
    error_code: str,
    message: str,
    steps: list[dict] | None = None,
) -> dict:
    return {
        "caseId": case["caseId"],
        "requirementIds": case["requirementIds"],
        "level": case["level"],
        "status": status,
        "errorCode": error_code,
        "message": message,
        "steps": steps or [],
    }


def render_report(plan: dict, results: dict, evaluation: dict) -> str:
    verification = results.get("targetVerification") or {}
    lines = [
        "# 谷神数据库测试报告",
        "",
        f"- 任务：`{plan['taskId']}`",
        f"- runId：`{results['runId']}`",
        f"- workspaceKey：`{plan['workspaceKey']}`",
        f"- 源码摘要：`{plan['sourceDigest']}`",
        f"- 测试计划摘要：`{digest(plan)}`",
        f"- 整体状态：**{evaluation['status']}**",
        "",
        "## 测试目标核验",
        "",
    ]
    for target_id, item in sorted(verification.items()):
        lines.append(
            f"- `{md(target_id)}`：{md(item.get('status', 'UNKNOWN'))}；"
            f"证据：{md(item.get('evidenceRef', '未记录'))}"
        )
    lines.extend(
        [
            "",
            "## 用例结果",
            "",
            "| 用例 | 验收条件 | 层级 | 状态 | 错误码 | 说明 |",
            "|---|---|---|---|---|---|",
        ]
    )
    for case in evaluation["cases"]:
        requirements = ", ".join(case["requirementIds"])
        lines.append(
            f"| {md(case['caseId'])} | {md(requirements)} | {md(case['level'])} | "
            f"{md(case['status'])} | {md(case['errorCode'] or '-')} | {md(case['message'])} |"
        )
        for step in case["steps"]:
            lines.append(
                f"| ↳ {md(step['stepId'])} |  |  | {md(step['status'])} | "
                f"{md(step['errorCode'] or '-')} | {md(step['message'])}; 证据: {md(step['evidenceRef'] or '未记录')} |"
            )
    platform_cases = [case for case in plan["cases"] if case["level"] == "platform-result"]
    lines.extend(
        [
            "",
            "## 平台与清理边界",
            "",
            f"- 平台结果用例：{len(platform_cases)}",
            "- DBX 阶段只执行只读查询；平台触发、持久化夹具及清理由既有开发流程按授权负责。",
            "- BLOCKED/SKIPPED 不计为通过；源码或计划摘要变化后必须创建新 run 并重新执行受影响用例。",
            "",
            "## 需要开发流程处理的问题",
            "",
        ]
    )
    issues = [case for case in evaluation["cases"] if case["status"] != "PASS"]
    if issues:
        lines.extend(f"- `{case['caseId']}` {case['errorCode']}: {case['message']}" for case in issues)
    else:
        lines.append("- 无。")
    lines.append("")
    return "\n".join(lines)


def md(value: Any) -> str:
    return str(value).replace("|", "\\|").replace("\n", " ")


def _emit(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2, default=str))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    config_parser = commands.add_parser("validate-config")
    config_parser.add_argument("config", type=Path)

    target_parser = commands.add_parser("resolve-target")
    target_parser.add_argument("config", type=Path)
    target_parser.add_argument("--workspace", required=True)
    target_parser.add_argument("--system-id", required=True)
    target_parser.add_argument("--data-source-id", required=True)
    target_parser.add_argument("--target-id", default="")

    plan_parser = commands.add_parser("validate-plan")
    plan_parser.add_argument("plan", type=Path)
    plan_parser.add_argument("--config", type=Path)

    evaluate_parser = commands.add_parser("evaluate")
    evaluate_parser.add_argument("plan", type=Path)
    evaluate_parser.add_argument("results", type=Path)
    evaluate_parser.add_argument("--config", type=Path)
    evaluate_parser.add_argument("--report", type=Path)

    args = parser.parse_args(argv)
    try:
        if args.command == "validate-config":
            validate_config(load_yaml(args.config))
            _emit({"ok": True, "schemaVersion": SCHEMA_VERSION})
        elif args.command == "resolve-target":
            target = resolve_target(
                load_yaml(args.config),
                args.workspace,
                system_id=args.system_id,
                data_source_id=args.data_source_id,
                target_id=args.target_id,
            )
            _emit({"ok": True, "target": target, "targetDigest": digest(target)})
        elif args.command == "validate-plan":
            plan = load_json(args.plan)
            config = load_yaml(args.config) if args.config else None
            validate_plan(plan, config)
            _emit({"ok": True, "planDigest": digest(plan)})
        else:
            plan = load_json(args.plan)
            results = load_json(args.results)
            config = load_yaml(args.config) if args.config else None
            evaluation = evaluate(plan, results, config)
            if args.report:
                args.report.parent.mkdir(parents=True, exist_ok=True)
                args.report.write_text(render_report(plan, results, evaluation), encoding="utf-8")
            _emit(evaluation)
            return 0 if evaluation["status"] == "PASS" else 2
    except (ArtifactError, OSError, ValueError, json.JSONDecodeError) as error:
        _emit({"ok": False, "errorCode": getattr(error, "code", "ARTIFACT_INVALID"), "message": str(error)})
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
