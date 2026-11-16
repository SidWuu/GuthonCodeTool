"""Native identity and inherited-layer invariants shared by save and upload."""

from common import page_editor
from .client import ApiError


def parent_layers(data, path=""):
    result = {}
    if isinstance(data, dict):
        for key, value in data.items():
            pointer = path + "/" + key.replace("~", "~0").replace("/", "~1")
            if key in {"superServiceEvents", "superPageEvents", "superScript"}:
                result[pointer] = value
            else:
                result.update(parent_layers(value, pointer))
    elif isinstance(data, list):
        for index, value in enumerate(data):
            result.update(parent_layers(value, path + "/" + str(index)))
    return result


def validate_candidate(path, metadata, baseline, candidate):
    if metadata.get("sourceType") == "module-parameter":
        from .module_parameter_editor import validate_candidate as validate_module
        validate_module(baseline, candidate, metadata)
        return

    if metadata.get("sourceType") == "view":
        from .view_editor import extract_sql, is_metadata_only

        minimal = is_metadata_only(baseline, metadata, path)
        if minimal and candidate == baseline:
            return
        if not minimal:
            extract_sql(baseline, metadata)
        extract_sql(candidate, metadata)
        return
    if metadata.get("sourceType") == "table":
        import json
        from common.page_projection import _JsonValueLocator

        try:
            _JsonValueLocator(candidate).locate()
            value = json.loads(candidate)
        except (ValueError, TypeError) as error:
            raise ApiError(
                "API_TABLE_FORMAT_INVALID", "表定义必须为有效的原生JSON"
            ) from error
        if not isinstance(value, dict) or any(
            str(value.get(key)) != str(metadata[key])
            for key in ("dataSourceId", "tableId")
        ):
            raise ApiError(
                "API_IDENTITY_MISMATCH", "表定义的数据源或表编码与当前对象不一致"
            )
        return
    if (
        metadata.get("sourceType") != "page"
        or str(metadata.get("pageType", "")) == "0"
        or path.lower().endswith(".gss")
    ):
        return
    from .native_page import is_metadata_only

    minimal = is_metadata_only(baseline, metadata, path)
    if minimal and candidate == baseline:
        return
    try:
        if baseline.lstrip("\ufeff \t\r\n").startswith("<"):
            from .native_page import decode

            before, after = ({} if minimal else decode(baseline)), decode(candidate)
        else:
            before, _ = page_editor._data(baseline)
            after, _ = page_editor._data(candidate)
    except (ValueError, TypeError, KeyError) as error:
        raise ApiError(
            "API_PAGE_FORMAT_UNSUPPORTED", "PAGE必须保留有效的原生JSON结构"
        ) from error
    if not minimal and str(before.get("pageId")) != str(metadata.get("pageId")):
        raise ApiError("API_PAGE_IDENTITY_MISMATCH", "PAGE 原文编码与平台元数据不一致，不能覆盖")
    if str(after.get("pageId")) != str(metadata.get("pageId")):
        raise ApiError("API_IDENTITY_MISMATCH", "PAGE编码与平台对象身份不一致")
    if parent_layers(before) != parent_layers(after):
        raise ApiError("API_PAGE_PARENT_READONLY", "继承父层不可在项目源码中修改")
