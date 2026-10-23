"""PAGE designer contracts shared by AI insertion, editing and diagnostics.

These are exported designer keys, including the platform's historical spelling
``complateSaveScript``. No platform JavaScript or business configuration is run.
"""
from __future__ import annotations

import copy
import json
import uuid
from common.inheritance import project as inheritance_projection

INPUT_TYPES = {"text", "select", "date", "datetime", "radio", "checkbox", "file", "label", "password"}
COLUMN_TYPES = {"text", "select", "date", "datetime", "checkbox"}
COMPONENT_KINDS = {
    "input-box": "FORM", "input-grid": "FORM", "search-box": "SEARCH",
    "table-main": "TABLE", "table-item": "TABLE", "tree-box": "TREE",
    "tab-page": "TABS", "tab-item": "TAB", "custom-box": "CUSTOM",
    "html-box": "HTML", "report-box": "REPORT", "echat-box": "CHART",
}
# Public event API metadata only; no platform script bodies or business data.
EVENT_DETAILS = {'TABLE': {'pageEvents': [{'name': 'onTableBeforeInitScript', 'additionalParameters': 'tableOptions'},
                          {'name': 'onTableReadyScript', 'additionalParameters': '_$table'},
                          {'name': 'onBeforeLoadScript',
                           'additionalParameters': 'params,continueCallback',
                           'returnType': 'int'},
                          {'name': 'onLoadSuccessScript', 'additionalParameters': 'rows,form'},
                          {'name': 'onAfterLoadScript', 'additionalParameters': 'rows,form'},
                          {'name': 'onClickRowScript', 'additionalParameters': 'rowData, rowIndex, _$table'},
                          {'name': 'onDblClickRowScript', 'additionalParameters': 'rowData, rowIndex, _$table'},
                          {'name': 'onClickCellScript',
                           'additionalParameters': 'field, value, rowData, rowIndex, _$table'},
                          {'name': 'onDblClickCellScript',
                           'additionalParameters': 'field, value, rowData, rowIndex, _$table'},
                          {'name': 'getCellFormaterScript',
                           'additionalParameters': 'fieldId, value, rowData, rowIndex',
                           'returnType': 'string'},
                          {'name': 'getCellStyleScript',
                           'additionalParameters': 'fieldId, value, rowData, rowIndex',
                           'returnType': 'object'},
                          {'name': 'getRowStyleScript',
                           'additionalParameters': 'rowData, rowIndex, _$table',
                           'returnType': 'object'},
                          {'name': 'getRowHeightScript',
                           'additionalParameters': 'rowData, rowIndex, _$table',
                           'returnType': 'int'},
                          {'name': 'isRowSelectableScript',
                           'additionalParameters': 'rowData, rowIndex, agRowNode',
                           'returnType': 'boolean'},
                          {'name': 'isFieldEditableScript',
                           'additionalParameters': 'rowData, rowIndex, fieldId',
                           'returnType': 'boolean'},
                          {'name': 'onCheckScript', 'additionalParameters': 'rowData, rowIndex, _$table'},
                          {'name': 'onUnCheckScript', 'additionalParameters': 'rowData, rowIndex, _$table'},
                          {'name': 'onChangeScript', 'additionalParameters': 'fieldId, rowData, rowIndex, _$table'},
                          {'name': 'getContextMenuItemsScript',
                           'additionalParameters': 'menus, fieldId, rowData, batchId, rowIndex, params'},
                          {'name': 'getIsRowMasterScript', 'additionalParameters': 'rowData', 'returnType': 'boolean'},
                          {'name': 'getDetailRowHTMLScript',
                           'additionalParameters': 'rowData, params',
                           'returnType': 'string'}],
           'serviceEvents': [{'name': 'beforeLoadScript', 'additionalParameters': '$form, $isSum'},
                             {'name': 'beforeSqlSelectScript', 'additionalParameters': '$form, $sqlBean, $isSum'},
                             {'name': 'afterLoadScript', 'additionalParameters': '$form, $list, $page'}]},
 'COLUMN': {'pageEvents': [{'name': 'formaterScript',
                            'additionalParameters': 'value, rowData, rowIndex, _$table',
                            'returnType': 'string'},
                           {'name': 'onChangeScript', 'additionalParameters': 'newData, rowIndex, _$table'},
                           {'name': 'getCellStyleScript',
                            'additionalParameters': 'value, newData, rowIndex, _$table',
                            'returnType': 'object'}]},
 'FIELD': {'pageEvents': [{'name': 'onChangeScript', 'additionalParameters': ''},
                          {'name': 'onAfterFileUploadScript',
                           'additionalParameters': 'result, tallFiles',
                           'requiresType': 'file'},
                          {'name': 'onInputScript', 'additionalParameters': '', 'requiresType': 'text'},
                          {'name': 'onKeyPressScript', 'additionalParameters': 'e', 'requiresType': 'text'},
                          {'name': 'onKeyDownScript', 'additionalParameters': 'e', 'requiresType': 'text'},
                          {'name': 'onKeyUpScript', 'additionalParameters': 'e', 'requiresType': 'text'},
                          {'name': 'onBlurScript', 'additionalParameters': '', 'requiresType': 'text'},
                          {'name': 'onTextAreaInitScript', 'additionalParameters': 'options', 'requiresType': 'text'},
                          {'name': 'onClickScript', 'additionalParameters': '', 'requiresType': 'text'},
                          {'name': 'onDbClickScript', 'additionalParameters': '', 'requiresType': 'text'}]},
 'FORM': {'pageEvents': [{'name': 'onLoadSuccessScript', 'additionalParameters': 'data'},
                         {'name': 'onAfterLoadScript', 'additionalParameters': 'data'},
                         {'name': 'onChangeScript', 'additionalParameters': 'fieldId'}],
          'serviceEvents': [{'name': 'beforeLoadScript', 'additionalParameters': '$form'},
                            {'name': 'beforeSqlSelectScript', 'additionalParameters': '$form, $sqlBean'},
                            {'name': 'afterLoadScript', 'additionalParameters': '$form, $list'}]},
 'TREE': {'pageEvents': [{'name': 'onInitTreeConfigScript', 'additionalParameters': 'treeSetting'},
                         {'name': 'onTreeNodeClickScript', 'additionalParameters': 'treeNode'},
                         {'name': 'onInitTreeDataScript', 'additionalParameters': 'treeDatas'},
                         {'name': 'onTreeDataLoadedScript', 'additionalParameters': 'treeNode'},
                         {'name': 'onBeforeCheckScript', 'additionalParameters': 'treeNode', 'returnType': 'boolean'},
                         {'name': 'onCheckScript', 'additionalParameters': 'treeNode'}],
          'serviceEvents': [{'name': 'beforeLoadScript', 'additionalParameters': '$form'},
                            {'name': 'beforeSqlSelectScript', 'additionalParameters': '$form, $sqlBean'},
                            {'name': 'afterLoadScript', 'additionalParameters': '$form, $list'}]},
 'TAB': {'pageEvents': [{'name': 'onClickScript', 'additionalParameters': ''}]},
 'CUSTOM': {'pageEvents': [{'name': 'onEmitScript', 'additionalParameters': 'eventType, args', 'returnType': 'Object'},
                           {'name': 'onLoadReadyScript', 'additionalParameters': ''}]},
 'REPORT': {'pageEvents': [{'name': 'onPrintButtonClickScript',
                            'additionalParameters': 'reportId, doCommand, params',
                            'returnType': 'int'},
                           {'name': 'onPageLoadedScript', 'additionalParameters': 'reportId'}]},
 'CHART': {'pageEvents': [{'name': 'onChartInitScript', 'additionalParameters': 'options'},
                          {'name': 'onTableReadyScript', 'additionalParameters': '_$table'},
                          {'name': 'onBeforeLoadScript',
                           'additionalParameters': 'params,continueCallback',
                           'returnType': 'int'}],
           'serviceEvents': [{'name': 'beforeLoadScript', 'additionalParameters': '$form, $isSum'},
                             {'name': 'beforeSqlSelectScript', 'additionalParameters': '$form, $sqlBean, $isSum'},
                             {'name': 'afterLoadScript', 'additionalParameters': '$form, $list, $page'}]},
 'PAGE': {'pageEvents': [{'name': 'onCreateScript', 'additionalParameters': ''},
                         {'name': 'onOpenScript', 'additionalParameters': 'openType, args'},
                         {'name': 'onShowScript', 'additionalParameters': 'openType, args'},
                         {'name': 'onBeforeWinCloseScript',
                          'additionalParameters': 'closeCallback',
                          'returnType': 'int'},
                         {'name': 'doMethodScript', 'additionalParameters': 'type, args', 'returnType': 'object'}]},
 'BUTTON': {'pageEvents': [{'name': 'onClickScript', 'additionalParameters': ''}],
            'serviceEvents': [{'name': 'beforeSaveScript', 'additionalParameters': '$isNew', 'requiresType': 'save'},
                              {'name': 'saveDataScript', 'additionalParameters': '$isNew', 'requiresType': 'save'},
                              {'name': 'afterSaveScript', 'additionalParameters': '$isNew', 'requiresType': 'save'},
                              {'name': 'complateSaveScript', 'additionalParameters': '$isNew', 'requiresType': 'save'},
                              {'name': 'beforeDeleteScript', 'additionalParameters': '$form', 'requiresType': 'delete'},
                              {'name': 'deleteDataScript',
                               'additionalParameters': '$form',
                               'requiresType': 'delete',
                               'returnType': 'boolean'},
                              {'name': 'afterDeleteScript', 'additionalParameters': '$form', 'requiresType': 'delete'},
                              {'name': 'complateDeleteScript',
                               'additionalParameters': '$form',
                               'requiresType': 'delete'},
                              {'name': 'beforeLoadScript', 'additionalParameters': '$form', 'requiresType': 'export'},
                              {'name': 'afterLoadScript',
                               'additionalParameters': '$form,$list',
                               'requiresType': 'export'}]},
 'SEARCH': {},
 'TABS': {},
 'HTML': {}}
EVENTS = {kind: {group: {item["name"] for item in items} for group, items in groups.items()}
          for kind, groups in EVENT_DETAILS.items()}
BUTTON_EVENTS = {
    "save": set("beforeSaveScript saveDataScript afterSaveScript complateSaveScript".split()),
    "delete": set("beforeDeleteScript deleteDataScript afterDeleteScript complateDeleteScript".split()),
    "export": {"beforeLoadScript", "afterLoadScript"},
}
FIELD_PROPERTIES = set("type fieldId tbId fdId label disName width height labelWidth maxLength maxTextLength readonly hide colGroupType defaultValue fieldTemplateId format groupName isDefaultLike isDisAdvSearch isDisLabel isDisabled isHide isHideField isImageUpload isLike isMust isRichEdit isTextArea isUseMaxEdit pcAndH5 placeholder selectCompId textAreaRows validId isEndDate parentFieldId childFieldId".split())
COLUMN_PROPERTIES = set("type fieldId tbId fdId label disName width colGroupType align autoHeight checkboxFalse checkboxTrue editable fieldTemplateId format groupName isDisExtraSearch isDisLabel isHide isHideField isMust isRowSpanning isSum isTextArea isTrimValue isUseMaxEdit pcAndH5 pinAlign selectCompId sortable sumSql validId isCanRemoveGroupField useTableFieldName".split())
BUTTON_PROPERTIES = set("name aliasName bntAuth bntSubType bntType className color groupName icon isDisDbClick isDisabled isHide isInGlobalTran pcAndH5 title".split())
SELECT_PROPERTIES = set("codeType forceSelection otherSetFields selectCodefieldId selectInitParam areaRange dqCode1 dqCode2 dqCode3 dqCode4 dqName1 dqName2 dqName3 dqName4 dqMust1 dqMust2 dqMust3 dqMust4".split())
FILE_PROPERTIES = set("excelTemplateResourceId fileAccessTag fileExtName fileSaveSubPath fileType fileUrlField isMultiple".split())
COMPONENT_PROPERTIES = set("name label h5label defaultPageSize disablePageSearch disableSave disableSelectField editable enableRowEdit flodTitle isAutoLoad isCanFlod isDisableCustomReport isDisableGroupSum isFetchPage isHide isMasterDetailRow isPage isShowExport isShowPageSumRow isShowRowNumField masterDetailHeight masterDetailHeightType multipleSelect pageSort searchBoxId selectRowWhenClick billTypeCode disableDesign formWidth isDisabledExtraSearch labelWidth mainTableId showBorder showLines isCanFilter isLoadAllData bottomButtonAlign topButtonAlign isShowBorder customSkinFun disName dsType".split())
PAGE_PROPERTIES = set("isPageScroll isHideCloseButton pageWidth".split())


def field_types(component):
    return COLUMN_TYPES if component in {"table-main", "table-item"} else (
        INPUT_TYPES - {"password", "file"} | {"datesearch", "numsearch"} if component == "search-box" else INPUT_TYPES)


def allowed_events(kind, item):
    result = {key: set(names) for key, names in EVENTS[kind].items()}
    if kind == "BUTTON":
        # The designer selects backend events by button action, not onClick.
        action = item.get("bntType")
        result["serviceEvents"] = set(BUTTON_EVENTS.get(action, ())) if isinstance(action, str) and item.get("bntSubType", 1) == 2 else set()
        if item.get("id") == "reset-button":
            result["pageEvents"] = {"onAfterResetScript"}
    elif kind == "FIELD":
        names = {"onChangeScript"}
        if item.get("type") == "file":
            names.add("onAfterFileUploadScript")
        if item.get("type") == "text":
            names |= EVENTS[kind]["pageEvents"] - {"onAfterFileUploadScript", "onTextAreaInitScript"}
            if item.get("isRichEdit") == 1:
                names -= {"onBlurScript", "onClickScript", "onDbClickScript"}
                names.add("onTextAreaInitScript")
        result["pageEvents"] = names
    return result


def property_paths(kind):
    if kind in {"FIELD", "COLUMN"}:
        paths = set(COLUMN_PROPERTIES if kind == "COLUMN" else FIELD_PROPERTIES)
        paths |= {"selectBox." + name for name in SELECT_PROPERTIES}
        if kind == "FIELD":
            paths |= {"fileInput." + name for name in FILE_PROPERTIES}
        return paths
    if kind == "BUTTON":
        return BUTTON_PROPERTIES | {"authHide." + name for name in ("auth", "hideType", "isUse")}
    if kind == "PAGE":
        return PAGE_PROPERTIES
    return COMPONENT_PROPERTIES | {"tree." + name for name in (
        "canEdit", "disFieldId", "fieldId", "isCanMultipleSelect", "parentFieldId", "showBorder", "width")}


def validate_member(item, component, *, button=False):
    """Check native shapes without rewriting an existing member's identity."""
    if not isinstance(item, dict):
        raise ValueError("Field/button must be an object")
    key = "name" if button else "fieldId"
    if not isinstance(item.get(key), str) or not item[key].strip() or len(item[key]) > 512:
        raise ValueError("Field/button requires " + key)
    for name in ("label", "aliasName", "guid"):
        if name in item and (not isinstance(item[name], str) or len(item[name]) > 512):
            raise ValueError(name + " must be bounded text")
    if (button or component in {"table-main", "table-item"} or "id" in item) and (
            not isinstance(item.get("id"), str) or not item["id"].strip()):
        raise ValueError("Field/button requires a native id for stable platform editing")
    types = field_types(component) | ({"line"} if component not in {"table-main", "table-item"} else set())
    if not button and (not isinstance(item.get("type"), str) or item["type"] not in types):
        raise ValueError("Unsupported field type for this platform region")
    if "colGroupType" in item and (type(item["colGroupType"]) is not int or item["colGroupType"] not in {0, 1, 2}):
        raise ValueError("Unknown platform field group type")
    for name in ("selectBox", "fileInput", "params", "authHide", "pageEvents", "serviceEvents"):
        if name in item and not isinstance(item[name], dict):
            raise ValueError(name + " must be an object, not null or an array")
    for name in ("bnts",):
        if name in item and (not isinstance(item[name], list) or any(not isinstance(child, dict) for child in item[name])):
            raise ValueError(name + " must be an array of button objects")
    if not button and item.get("type") == "select":
        if not item.get("selectBox", {}).get("codeType"):
            raise ValueError("Select field requires selectBox.codeType")
        if component not in {"table-main", "table-item"} and not item.get("selectCompId"):
            raise ValueError("Select field requires selectCompId")
        if item["selectBox"].get("selectCodefieldId") == item["fieldId"]:
            raise ValueError("Select field cannot reflect to itself")
    if not button and item.get("type") == "file" and not item.get("fileInput", {}).get("fileUrlField"):
        raise ValueError("File field requires fileInput.fileUrlField")
    if not button and item.get("colGroupType") == 2:
        select = item.get("selectBox", {})
        if not item.get("groupName") or any(not select.get("dq" + name + str(level)) for name in ("Code", "Name") for level in (1, 2, 3)):
            raise ValueError("Area group requires groupName and province/city/county code/name field bindings")
    if item.get("isHide") == 1 and item.get("isMust") == 1:
        raise ValueError("Hidden fields cannot also be required")
    for name, value in item.items():
        if (name.startswith("is") or name in {"editable", "sortable", "autoHeight", "useTableFieldName"}) and name != "isLike":
            if name in FIELD_PROPERTIES | COLUMN_PROPERTIES | BUTTON_PROPERTIES and (type(value) is not int or value not in {0, 1}):
                raise ValueError(name + " must use the platform integer 0/1 flag")
    if "validId" in item and not isinstance(item["validId"], str):
        raise ValueError("validId must be a semicolon-separated string")
    if button and item.get("authHide", {}).get("isUse"):
        if not item.get("aliasName") or not item["authHide"].get("auth"):
            raise ValueError("Permission hiding requires aliasName and authHide.auth")
    if button and (type(item.get("bntSubType", 1)) is not int or item.get("bntSubType", 1) not in {1, 2, 3}):
        raise ValueError("Unknown platform button subtype")
    if button and (not isinstance(item.get("bntType", "custom"), str) or len(item.get("bntType", "custom")) > 128):
        raise ValueError("Button action type must be bounded text")


def prepare_member(item, component, *, button=False, identity_seed="", renew_ids=False):
    """Build a native member; deterministic IDs freeze preview and write equally."""
    candidate = copy.deepcopy(item)
    if not isinstance(candidate, dict):
        raise ValueError("New field/button must be an object")
    if any(name.startswith("super") for name in candidate) or candidate.get("isProduct"):
        raise ValueError("New fields/buttons cannot introduce product layers")
    if set(candidate) & {"vm", "isNew", "_"}:
        raise ValueError("New fields/buttons cannot contain designer session state")
    def identity(suffix):
        return uuid.uuid5(uuid.NAMESPACE_URL, identity_seed + ":" + suffix).hex.upper()
    if renew_ids or not candidate.get("id"):
        candidate["id"] = identity("id")
    if renew_ids and "guid" in candidate:
        candidate["guid"] = identity("guid")
    if button:
        defaults = {"bntSubType": 1, "bntType": "custom", "isHide": 0, "isDisabled": 0,
                    "isInGlobalTran": 0, "isDisDbClick": 0, "params": {},
                    "authHide": {"hideType": 0, "isUse": 0}, "pageEvents": {}, "serviceEvents": {}}
    elif component in {"table-main", "table-item"}:
        defaults = {"width": 100, "isSum": 0, "sumSql": "", "pageEvents": {}, "isHide": 0,
                    "autoHeight": 0, "isCanRemoveGroupField": 0, "useTableFieldName": 0,
                    "validId": "", "selectBox": {"forceSelection": 0}, "params": {},
                    "editable": 0, "isMust": 0, "colGroupType": 1, "sortable": 1, "type": "text"}
    else:
        defaults = {"width": 1, "colGroupType": 1, "type": "text", "isMust": 0, "isEndDate": 0,
                    "isLike": 0, "isDisabled": 0, "isRichEdit": 0, "isImageUpload": 0,
                    "fileInput": {}, "isDisLabel": 0, "isDisAdvSearch": 0, "isHide": 0,
                    "selectBox": {"forceSelection": 1}, "validId": "", "pageEvents": {}}
    for name, value in defaults.items():
        if name not in candidate:
            candidate[name] = copy.deepcopy(value)
        elif isinstance(value, dict) and isinstance(candidate[name], dict):
            for subkey, subvalue in value.items():
                candidate[name].setdefault(subkey, subvalue)
    if not button:
        if candidate.get("colGroupType") in (0, 2) and not candidate.get("fieldId"):
            candidate["fieldId"] = identity("fieldId")
        candidate.setdefault("label", "操作" if candidate.get("colGroupType") == 0 else candidate.get("groupName") or candidate.get("fieldId"))
    # Native exporters persist a semicolon-separated string, never a form array.
    if isinstance(candidate.get("validId"), list):
        if any(not isinstance(value, str) for value in candidate["validId"]):
            raise ValueError("validId must contain validation names")
        candidate["validId"] = ";".join(candidate["validId"]) + (";" if candidate["validId"] else "")
    if "bnts" in candidate and not isinstance(candidate["bnts"], list):
        raise ValueError("bnts must be an array of button objects")
    for index, child in enumerate(candidate.get("bnts", [])):
        candidate["bnts"][index] = prepare_member(child, component, button=True,
            identity_seed=identity_seed + ":bnts:" + str(index), renew_ids=True)
    validate_member(candidate, component, button=button)
    kind = "BUTTON" if button else "COLUMN" if component in {"table-main", "table-item"} else "FIELD"
    allowed = allowed_events(kind, candidate)
    for name in ("pageEvents", "serviceEvents"):
        known = set(EVENTS[kind].get(name, ()))
        if kind == "BUTTON" and name == "serviceEvents":
            known = set().union(*BUTTON_EVENTS.values())
        for event, content in candidate.get(name, {}).items():
            if event not in allowed.get(name, set()) and (event not in known or content):
                raise ValueError("Unsupported new field/button event for its platform type")
            if not isinstance(content, str) or len(content) > 500_000 or inheritance_projection(content, None)["status"] != "INACTIVE":
                raise ValueError("New event requires explicit source without inheritance markers")
    if len(json.dumps(candidate, ensure_ascii=False, allow_nan=False).encode()) > 64_000:
        raise ValueError("New field/button exceeds the size limit")
    return candidate


def contract():
    return {"contractVersion": 1, "operations": ["insert", "copy", "remove", "move", "patch", "event", "removeEvent", "datasource", "layout", "grid", "repairIdentities", "property", "text", "order"],
            "platformBasis": "Observed native designer export contract; verify the target platform build before acceptance.",
            "operationArguments": {
                "insert": ["collectionPointer", "item"],
                "copy": ["collectionPointer", "fieldKey", "targetCollectionPointer (optional)", "patch (new fieldId or aliasName)"],
                "remove": ["collectionPointer", "fieldKey"],
                "move": ["collectionPointer", "fieldKey", "targetCollectionPointer"],
                "patch": ["ownerPointer", "patch (property path to scalar value)"],
                "event": ["ownerPointer", "eventType", "eventName", "content"],
                "removeEvent": ["ownerPointer", "eventType", "eventName"],
                "datasource": ["ownerPointer", "value (native datasource with dsType, fields, pks and sql/script)"],
                "layout": ["rows (native row/column/component/tab tree; controls catalog is derived)"],
                "grid": ["ownerPointer (input-grid)", "rows (native gridRows with cell.control.ctrlId field bindings)"],
                "repairIdentities": ["collectionPointer (only missing/duplicate native IDs; product members excluded)"],
                "property": ["collectionPointer", "fieldKey", "property", "value"],
                "text": ["jsonPointer", "content"], "order": ["collectionPointer", "fieldKeys"]},
            "components": COMPONENT_KINDS,
            "inputTypes": sorted(INPUT_TYPES), "columnTypes": sorted(COLUMN_TYPES),
            "searchTypes": sorted(field_types("search-box")),
            "events": {kind: {name: sorted(events) for name, events in groups.items()} for kind, groups in EVENTS.items()},
            "eventDetails": EVENT_DETAILS,
            "buttonServiceEvents": {kind: sorted(events) for kind, events in BUTTON_EVENTS.items()},
            "properties": {kind: sorted(property_paths(kind)) for kind in ("FIELD", "COLUMN", "BUTTON", "PAGE", "TABLE")},
            "identityPolicy": "Create generates missing IDs; copy renews IDs; edits and moves preserve native IDs.",
            "nativePageShape": {"pageId": "<existing platform PAGE ID>", "views": {"rows": [], "ctrls": []}, "pageSetup": {}},
            "verification": "Local contract validation; platform round-trip and business execution require separate acceptance."}


def prepare_collection(before, proposed, component, *, identity_seed):
    """Guard raw field-fragment saves as well as typed MCP insertion.

    Changing a caption/binding must not silently turn an existing native object
    into a new one. Existing unchanged legacy members remain byte-semantically
    untouched; only new members receive defaults.
    """
    result = []
    for index, member in enumerate(proposed):
        if not isinstance(member, dict):
            raise ValueError("Field collection requires objects")
        old = [item for item in before if isinstance(item, dict) and (
            item.get("fieldId") == member.get("fieldId") and member.get("fieldId")
            or item.get("id") == member.get("id") and member.get("id"))]
        if len(old) > 1:
            raise ValueError("Existing field identity is ambiguous")
        if old:
            original = old[0]
            for name in ("id", "guid"):
                if member.get(name) != original.get(name):
                    raise ValueError("Editing an existing field must preserve its native " + name)
            for name in set(original) | set(member):
                if (name.startswith("super") or name == "isProduct") and member.get(name) != original.get(name):
                    raise ValueError("Existing field product layers must be preserved")
            candidate = copy.deepcopy(member)
            if candidate != original:
                validate_member(candidate, component)
        else:
            candidate = prepare_member(member, component, identity_seed=identity_seed + ":" + str(index))
        if any(other.get("fieldId", "").casefold() == candidate.get("fieldId", "").casefold() for other in result):
            raise ValueError("Duplicate fieldId in proposed collection")
        for name in ("id", "guid"):
            if candidate.get(name) and any(other.get(name) == candidate[name] for other in result):
                raise ValueError("Duplicate native " + name + " in proposed collection")
        result.append(candidate)
    return result
