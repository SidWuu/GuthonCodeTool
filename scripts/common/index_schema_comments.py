"""Queryable descriptions for the SQLite source-index schema.

SQLite has no native table or column COMMENT statement. A blank column_name
describes the table; other rows describe columns returned by PRAGMA table_info.
"""

SCHEMA_COMMENTS = {
    "gusen_source_record": (
        "源码对象主表；其他事实表通过 record_id 关联此表。",
        """record_id|索引内的源码对象编号
source_layer|产品层或项目层
scope_id|产品或项目的业务身份
project_id|项目身份；产品层为空
source_namespace|源码命名空间
source_table|源码对象类型
source_id|源码对象原生编号
source_alias_id|源码对象别名
fun_id|过程函数编号
source_name|源码对象名称
version_mac|平台版本标识
update_time|源码更新时间
check_out_user_id|检出人编号
check_out_date|检出时间
check_in_date|签入时间
change_key|增量索引变化键
local_path|本地只读源码相对路径
status|源码对象索引状态
indexed_time|最近索引时间
provider|源码提供方
source_path|提供方中的源码路径
source_hash|源码内容哈希
svn_revision|SVN 修订号
json_pointer|源码对象的 JSON Pointer
system_id|系统编号
data_source_id|数据源编号
working_copy_id|SVN 工作副本编号
scope_entry_id|授权范围条目编号
file_size|源码文件字节数
mtime_ns|源码文件修改时间纳秒值
diagnostic_code|索引诊断代码
diagnostic_message|索引诊断说明
parser_version|解析器版本
last_seen_time|最近一次扫描发现时间""",
    ),
    "gusen_invoke_call": (
        "可静态确定目标的函数调用边。",
        """id|调用边编号
source_record_id|调用方源码对象编号
source_fragment_id|调用所在源码片段编号
script_type|脚本类型
json_path|调用在源码中的 JSON 路径
line_no|调用所在行号
target_alias_id|目标对象别名
target_fun_id|目标函数编号
invoke_type|调用方式""",
    ),
    "gusen_dynamic_call": (
        "无法静态确定目标的动态调用线索。",
        """id|动态调用编号
source_record_id|调用方源码对象编号
source_fragment_id|调用所在源码片段编号
script_type|脚本类型
json_path|调用在源码中的 JSON 路径
line_no|调用所在行号
invoke_expr|动态调用表达式
reason|目标无法静态确定的原因""",
    ),
    "gusen_sync_state": (
        "索引构建和增量刷新所需的键值状态。",
        """state_key|状态键
state_value|状态值""",
    ),
    "gusen_source_fragment": (
        "可定位的源码片段及其内容哈希；不保存完整源码正文。",
        """fragment_id|源码片段编号
source_record_id|所属源码对象编号
fragment_type|片段类型
json_pointer|片段在源码中的 JSON Pointer
label|片段显示名称
language|片段语言
coordinate_kind|行号坐标类型
line_count|片段行数
content_hash|片段内容哈希
origin_map_json|片段来源映射 JSON""",
    ),
    "gusen_page_relation": (
        "PAGE 元素之间的结构关系及置信度。",
        """relation_id|关系编号
source_record_id|所属 PAGE 对象编号
source_fragment_id|关系所在源码片段编号
relation_type|关系类型
source_key|关系起点键
target_key|关系终点键
json_pointer|关系证据的 JSON Pointer
confidence|关系置信度""",
    ),
    "gusen_page_node": (
        "PAGE 语义节点目录；正文从授权源码按需读取。",
        """source_record_id|所属 PAGE 对象编号
json_pointer|节点在 PAGE 中的 JSON Pointer
node_type|语义节点类型
label|节点显示名称
content_hash|节点内容哈希
semantic_node_id|派生的语义节点编号
identity_stability|节点身份稳定性
event_scope|事件作用域
owner_type|节点宿主类型
owner_id|节点宿主编号
parser_version|解析器版本""",
    ),
    "gusen_page_field": (
        "具有组件宿主的 PAGE 界面字段目录。",
        """source_record_id|所属 PAGE 对象编号
json_pointer|字段在 PAGE 中的 JSON Pointer
collection_pointer|字段集合的 JSON Pointer
ordinal|字段在集合中的顺序
region_type|界面区域类型
component_type|组件类型
field_id|字段原生编号
native_id|组件原生 ID
native_guid|组件原生 GUID
table_id|关联数据表编号
column_id|关联数据列编号
label|界面字段名称
content_hash|字段内容哈希
semantic_field_id|派生的语义字段编号
identity_stability|字段身份稳定性
parser_version|解析器版本""",
    ),
    "gusen_page_field_relation": (
        "PAGE 字段显式指向及未解析映射的证据。",
        """relation_id|字段关系编号
source_record_id|所属 PAGE 对象编号
source_pointer|关系起点的 JSON Pointer
collection_pointer|字段集合的 JSON Pointer
source_field_id|起点字段原生编号
relation_type|字段关系类型
target_field_id|目标字段原生编号
target_pointer|已解析目标的 JSON Pointer
resolution|目标解析状态
confidence|关系置信度
evidence_pointer|关系证据的 JSON Pointer
parser_version|解析器版本""",
    ),
    "gusen_bill_route": (
        "数据源、单据类型和业务表之间的源码路由。",
        """route_id|单据路由编号
source_record_id|所属源码对象编号
data_source_id|数据源编号
bill_type_code|单据类型编码
bill_type_name|单据类型名称
table_name|关联业务表名
primary_keys|业务表主键字段""",
    ),
    "gusen_data_access": (
        "源码读写业务表的结构化事实与有界证据。",
        """access_id|数据访问事实编号
source_record_id|所属源码对象编号
source_fragment_id|所属源码片段编号
table_name|被访问的业务表名
operation|读取或写入操作
key_fields|操作涉及的键字段
line_no|证据所在行号
scope_path|条件或语句作用域路径
access_kind|数据访问类型
confidence|识别置信度
evidence|有界原文证据
detail_text|有界详细文本
detail_hash|详细文本哈希
detail_truncated|详细文本是否截断""",
    ),
    "gusen_logic_fact": (
        "条件、赋值、返回和异常等逻辑事实。",
        """fact_id|逻辑事实编号
source_record_id|所属源码对象编号
source_fragment_id|所属源码片段编号
fact_kind|逻辑事实类型
subject|逻辑主体
operator|判断或赋值操作符
value_text|事实中的值文本
scope_path|逻辑作用域路径
parent_fact_id|父逻辑事实编号
line_start|证据起始行
line_end|证据结束行
confidence|识别置信度
evidence|有界原文证据
detail_text|有界详细文本
detail_hash|详细文本哈希
detail_truncated|详细文本是否截断""",
    ),
    "gusen_schema_comment": (
        "SQLite 索引表与字段的可查询中文注释；column_name 为空表示表注释。",
        """table_name|被说明的索引表名
column_name|字段名；空字符串表示表本身
comment|表或字段的中文说明""",
    ),
}


def setup_schema_comments(conn) -> None:
    conn.execute(
        """CREATE TABLE IF NOT EXISTS gusen_schema_comment (
            table_name TEXT NOT NULL,
            column_name TEXT NOT NULL DEFAULT '',
            comment TEXT NOT NULL,
            PRIMARY KEY (table_name, column_name)
        )"""
    )
    comments = []
    for table_name, (table_comment, column_lines) in SCHEMA_COMMENTS.items():
        actual_columns = {
            row[1] for row in conn.execute(f"PRAGMA table_info({table_name})")
        }
        column_comments = dict(line.split("|", 1) for line in column_lines.splitlines())
        if not column_comments.keys() <= actual_columns:
            raise ValueError(f"索引字段注释与表结构不一致：{table_name}")
        comments.append((table_name, "", table_comment))
        comments.extend(
            (table_name, column_name, comment)
            for column_name, comment in column_comments.items()
        )
    conn.executemany(
        """INSERT INTO gusen_schema_comment(table_name, column_name, comment)
        VALUES (?, ?, ?)
        ON CONFLICT(table_name, column_name) DO UPDATE SET comment=excluded.comment
        WHERE comment<>excluded.comment""",
        comments,
    )
