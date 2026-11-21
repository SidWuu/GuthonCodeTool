# P3 旧源码模式接线与验证

日期 2026-11-19。依据 [V1.1 长期方案](long-term-unified-workspace-design.md)，在同一后端按当前项目的同步方式执行。SVN 和 DATABASE 使用 main 已提交的源码流程及各自索引。P1 公共登记、路径与权限仍是目标来源。

| 入口 | SVN | DATABASE |
|---|---|---|
| Nexus 更新源码 | 授权检出或原生更新后维护本地索引 | 更新 readonly 与结构资料，维护本地索引 |
| Nexus 本地修改与记录 | 清单模式的 SCM、差异、冲突与文件选择。提交按 working copy，继续核对 SVN 回执和平台生效 | Workcopy 状态、差异、交付材料与同步记录 |
| CLI 与 ToolHost | `svn` 的检出、更新、索引、查询、虚拟文档和变更审阅操作 | `sync-source`、`sync-all`、`pull`、`create-workcopy`、`workcopy`、本地索引与导出 |
| Bridge | 页面定位和已授权的本地调用方查询 | 已匹配的页面、过程函数拉取到 Workcopy，调用方查询走本地索引 |
| MCP | `--provider svn` 选择 SVN 服务。支持原有清单模式本地查询与受控编辑 | `--provider database` 提供本地索引、源码预览和同步历史 |

所有源码操作以明确的 workspaceKey 及 provider 为边界。清单 SVN 提交须经过文件差异预览及确认，操作记录保留原来的 revision 和不确定结果。旧 sparse checkout 按原布局读取与更新，清单模式特有的受控编辑、提交和分组由对应能力决定。DATABASE 保留 readonly 与 Workcopy 的比较机制，原有 Git 暂存开关仍仅适用于本操作新生成且之前未跟踪的文件。数据库全量更新依赖已配置的数据源、系统范围和源码字段映射。

## 本地验证

| 回归 | 结果 |
|---|---|
| Python 公共契约与旧模式联通 | 63 项通过 |
| Python API | 340 项通过 |
| Nexus 全量 | 646 项通过 |
| SVN 编辑器、SCM 与监听兼容 | 103 项通过，在临时目录复用 main 的测试并按 provider 筛选菜单断言 |
| Bridge | 122 项通过 |
| 团队 SVN 与 API 契约 | SVN 4 项、API 17 项通过 |


- 使用独立临时 SVN 仓库验证初次检出、索引、工作副本差异、未提交修改阻断更新、文件审阅和提交回执，以及另一工作副本更新后的增量索引。测试中的 SVN 写入仅发生在本地夹具仓库。CLI、ToolHost 与 SVN MCP stdio 使用同一目标解析。
- DATABASE 使用合成数据库连接返回源码行，走真实的 legacy SQL 生成、readonly 写入、索引和 Workcopy 比较。覆盖二次拉取保留本地草稿、状态/历史读取及 DATABASE MCP 拒绝其他模式。
- Bridge 测试覆盖 DATABASE 拉取、SVN 拒绝浏览器拉取、旧模式本地调用方查询，以及 API 请求继续使用 API 入口。
- Python 调试包在临时目录构建，CLI 自检及 SVN SCM 状态读取通过。
- 团队仓库 `verify` 通过。隔离副本中的 SVN 1.5／2.0 合成工作区验证了受控修改、回读与 Linter，API 规则及回执契约另行回归。团队 fixture 在副本中使用完整旧 YAML，并通过已拆分的 legacy 索引模块建索引。原仓库规则与安装载荷保留。

真实数据库连接与完整导出、正式客户端安装及谷神平台最终生效需要对应环境验收。当前交付停在 P3。配置转换与 SVN→API 源码迁移属于 P4。

## 接入已有项目

在 Nexus 选择当前后端和已有本地数据目录，核对项目总览的 provider、目录和授权范围。SVN 从环境检查确认本机 SVN 客户端，再从项目设置检查共享账号及授权范围，更新后查看源码和 SVN 变更。DATABASE 检查连接引用、字段映射及 Workcopy 设置，更新后从工作副本管理修改。需要 AI 工具时为对应模式生成 MCP 配置，先只读回读当前项目，再按项目规范使用受控入口。
