# API 工作空间布局与 guthon-team 调整方案

文档定位：本文记录 API 独立开发阶段的目录与团队插件调整。后续长期目标以[API 优先与多项目统一工作空间设计](long-term-unified-workspace-design.md)为准；本文中的 API 唯一模式、旧配置拒绝和新数据目录重新接入描述阶段实现，不代表长期兼容策略。

状态：guthon-team 已按本方案准备本地候选实现（插件 0.5.0、规范 2026.11.18.4），api-sync 相关实现已完成本地回归。实现与临时工作空间验证不代表插件已发布或真实客户端已验收。

## 新 API 布局目标与边界

- `<toolHome>/var/` 是唯一 Git 根。CodeBuddy 打开 `var/`，Nexus 在同一窗口切换工作区，通过 `context.workspaceState` 按 toolHome 保存和恢复 key；根窗口未选择时不猜测目标，失效 key 会清除，运行中的窗口各自保持选择，不写共享 ACTIVE；每个后端请求仍携带明确 `workspaceKey`。所有已登记 checkout 纳入编辑状态和文件监听，源码树与 SCM 只显示当前选中项。Codex 可从 `var/<用户目录>` 启动，由 Git 根向下发现 `var/AGENTS.md`；仍需核对宿主实际加载结果、更近目录规则和截断。
- `config/guthon.json` 使用 schemaVersion 2，包含 `workspaces`、`sync`、`datasource`、`databaseTesting`、`apiWorkspaces`。`workspaces` 以稳定 key 映射 `{name, directory, aliases}`。创建仅要求名称，自动生成 `ws_` 加 UUID；可选 ID、目录和别名。取消 products/projects 分组以及 kind/type/layer 身份，不从名称推断类型或强制 PRD/PRJ 前缀。
- 单个工作区有 `checkout/`、`context/`、`runtime/`、初始为空的 `docs/`。索引可重建；`context/` 中基线、冲突、回执等是恢复材料，需保留备份。`runtime/` 保存日志、缓存。两者默认由根 `.gitignore` 忽略，不等于可以随意清除。
- 首次初始化全新 API 工作空间时创建空 `var/rules/` 和 `var/docs/`，前者承载团队谷神开发规范，后者承载共用参考；工作区 docs 保存该工作区文档。guthon-team 更新现有工作空间时按下节选择规则目录：已有 `var/rules/` 使用该目录，没有时继续使用原 `var/docs/`。既有 `var/nexus/`、`var/tools/`、`var/.guthon/` 等共用运行目录继续遵循各自正式契约，并由根忽略规则覆盖；本方案不声称这些目录迁入每个工作区。
- 平台源码继承、产品源码和只读约束来自对象元数据及真实平台契约，不由工作区分类推断；取消分类身份不取消写入门禁、继承保护或实际业务中的产品/项目概念。
- 已有空间重跑 setup 保留现有规范根，不自动补建 rules。工具的 `initialize_space` 初始化新 var 的 Git、根规则入口及受管 `.gitignore` 块；保留已有 AGENTS 和块外人工内容，不生成各工作区重复的 `AGENTS.md`、`CODEBUDDY.md`、`.gitignore` 或嵌套 Git。

## 规范目录选择与旧布局兼容

目录选择在 guthon-team 创建或写入任何规范目录前完成，不增加用户配置，也不按工具版本、分支或工作区名称猜测：

| var 中的实际状态 | 本次规范文档目标 |
|---|---|
| `rules/` 已存在（包括空目录，或同时存在 `docs/`） | `var/rules/` |
| 没有 `rules/`，已有 `docs/` | 原 `var/docs/` |
| `rules/` 和 `docs/` 都不存在 | 创建并使用 `var/docs/` |
| `rules` 路径已被普通文件等非目录对象占用 | 明确报错，保留现场 |

选定目录统一用于规范分发、根规则入口、规范内部链接、Skill/Hook/linter 的规范引用及安装计划、清单和锁文件。预览显示实际目标；执行前重新核对选择条件，目标改变时重新预览。回退到 `docs/` 不代表自动转换旧源码配置，也不能据此推断源码 provider 或工作区身份。

已有 `rules/` 时，只使用该规范目录，不因某个文件缺失而逐文件回退到 `docs/` 或生成双份规范。以后新增 `rules/` 时，后续分发按目录存在规则选择新目标；原 `docs/` 规范和人工内容保留，不自动搬移或清理。新目标中的已有文件仍执行受管摘要及人工修改检查，不能把旧路径的锁记录视为覆盖新路径文件的授权。

## 当前实现与联通边界

- guthon-team 源码的规范分发、根入口、锁与索引使用同一规则目录选择；API 接入使用 runtime descriptor 的真实注册表和中性稳定 key，旧 DATABASE/SVN 契约保留。未修改已安装缓存或真实业务工作区。
- API 重复 setup 保留既有 docs 规范布局，workspace-resolve 返回实际 rulesDir；descriptor 的 linterCommand 通过工具后端 lint 委派，避免 Windows 直接执行 POSIX 脚本。
- 工具生成的 API 参考默认放入 `var/nexus/api-reference/谷神方言API/`，团队规范仍放在选定 rules/docs 下，两个生成器不再争写同一文档。业务共用资料继续使用 docs。
- API producer 的错误阶段事实、按原幂等键查找文档操作与 Hook consumer 对齐；写前拒绝不新增未知记录，已写或未知先核对原操作。混合批次须完整分页和哈希核验后，才允许原批次明确回滚，不重放候选。
- 本地回归及临时目录中的真实 API MCP 回执到 Hook CLI 联通不等于客户端实际触发。真实 CodeBuddy/Codex 规则加载、窗口重载、Hook 生命周期和平台效果仍需独立验收。

## guthon-team 具体修改

1. **根入口和规范模板**：调整 `assets/workspace/standards/AGENTS.md`，为新 API 布局准确描述唯一 Git 根、四目录、明确 key、API provider、按元数据保护继承源码；规范引用使用实际选定的 `rules/` 或 `docs/` 路径。API 接入的规则去掉不适用的 DATABASE 工作副本、分类 identity 和目录推断；现有工作空间按其实际源码接入契约应用适用规范，保留业务写入门禁、非源码文档范围及必要安全规则。`assets/workspace/standards/docs/谷神源码定位与有界查询.md`、`谷神源码写入门禁.md`、`宿主接入与检查能力.md`、`GUSHEN_DEVELOPMENT_BASELINE.md`、`谷神模块开发规范.md` 和 `谷神开发模式/` 中按实际引用调整身份、入口和相对链接；针对性检查 `谷神方言API/` 的归属与工具 `sync_guthon_api.mjs` 现行引用，工具生成参考缓存独立于团队受管规范。重新生成 `standards.json` 清单、摘要与版本，并检查链接及所有调用方。
2. **规范分发与人工内容保护**：调整 `scripts/guthon_workspace.py` 的资源映射、清单、计划及锁，统一在创建目录前选择规范根：`var/rules/` 存在时分发至该目录，不存在时分发至原 `var/docs/`。安装、更新、检查和预览共用该选择；不为旧工作空间自动新建 `rules/`。`standards.json` 的资源映射、安装计划与锁记录实际目标路径；旧锁中的 `docs/` 文件在回退模式下继续原地更新并核对原摘要。业务共用参考资料仍使用 `var/docs/`；工具生成的 API 参考缓存放入 `var/nexus/api-reference/谷神方言API/`，避免争写团队受管文件。`initialize_space` 已创建的根 AGENTS 属于非覆盖入口：团队插件不以首次没有锁为由整体覆盖；设计可审阅的受管区块或明确引用机制，先预览差异，块外及既有人工作品原样保留。规范文件继续使用上次安装摘要判断是否由人工修改：冲突时停止、列出具体路径；仅在用户明确接受具体覆盖时备份并操作。锁、备份、lint、Hook 沿用既有 `.guthon/`、`tools/` 等契约；重复初始化与更新必须幂等，不能清理用户 docs、源码或恢复记录。
3. **选择、身份和目录解析**：更新 `skills/guthon-use/SKILL.md`、`commands/guthon-use.md`、`scripts/guthon_target.py` 与 `scripts/guthon_hook.py`。名称、别名、key 或经过注册表校验的目录只能经 runtime descriptor 的 `workspaceResolveCommand` 解析；名称不唯一时显示候选并明确选择，根目录自身不隐含工作区。API 接入去掉 `--kind`、分类正则和仅允许旧 provider 的假设，严格校验统一解析器返回的 key、绝对 root、API sourceMode 和目标归属；旧接入继续遵守对应 runtime descriptor 的契约，不通过 `rules/` 或 `docs/` 推断源码模式。稳定 key 可人工指定，不能只接受 `ws_` 格式；不要扫描目录或直接猜配置。Hook 的会话/轮次绑定仍依赖宿主真实事件 ID，目标不同或身份/根变化时重新核对；显式跨工作区任务逐个选择，普通文档与只读讨论无需绑定。
4. **宿主入口**：更新 `commands/guthon-init.md`、`skills/guthon-bootstrap/`、`skills/guthon-guard/` 和 `assets/workspace/standards/docs/宿主接入与检查能力.md` 的实际适用段落。CodeBuddy 以 var 为项目根，检查客户端实际读取根 AGENTS 及 Hook 信任；Codex 从子目录以 var 为 Git 根发现父规则，核验 override、字节限制和实际加载。保留已有 CODEBUDDY 内容，不为每个工作区生成复制入口。根 AGENTS、已有 CODEBUDDY、Skill、Hook 和 linter 的规范路径均使用同一目录选择结果，并检查规范内部及共用资料的相对链接。根初始化和团队规范安装是两个独立步骤，不能把文件存在当作客户端已加载或 Hook 已运行。
5. **测试和发布准备**：更新 `tests/test_guthon_workspace.py`、`tests/test_guthon_target.py`、`tests/test_guthon_hook.py`、`tests/test_guthon_lint.py` 及命中路径的版本/规范测试；补齐新旧规则目录选择、首次分发、旧锁升级、人工内容保护、相对链接和重复更新用例；搜索全部 `products.`、`projects.`、`--kind`、旧目录和失效链接，逐项判断是过时身份还是仍有效的平台业务概念。插件修改和测试在 guthon-team 源码仓库完成；发布另行授权，不修改已安装缓存。

## 初始化与升级

- 新 API 目录：工具初始化新 var、根 Git、空 rules/docs、非覆盖式 AGENTS 和受管 ignore；随后安装团队插件时已存在 `rules/`，规范分发至该目录，参考资料保留在 `docs/`。预览规范分发和 Hook 配置，核对人工内容。创建工作区后仅在其目录生成四个子目录，项目 docs 初始为空。
- 现有工作空间更新团队规范：在写入前检查 `var/rules/`；不存在时沿用 `var/docs/`，必要时只创建 `docs/`。保留原有文件、相对目录及锁记录的更新关系，不要求先创建 `rules/`、迁移规范或更换本地数据目录。
- 源码接入升级：以下是 API 工具的配置升级边界，不是 guthon-team 在旧 `docs/` 中更新规范的前提。schema 1 和分类 YAML 不自动转换，旧 `configuration-migrate` 命令和向导退役。不原地改写或覆盖旧目录；先保留旧源码、未上传修改、基线、冲突及回执，在新数据目录创建新工作区，确认平台身份、范围后重新从 API 拉取。旧 SVN 修改按原流程处理，API 操作记录不替代 SVN 历史；恢复或交付证据另行核验。
- 已有根 AGENTS、用户规则、`.gitignore` 块外内容及已有 Hook 配置均须保留；规范冲突和现有 `core.hooksPath` 先报告，不静默覆盖。损坏的受管区块停止并提示人工检查。不得以忽略 Git 为理由删除 context 恢复材料。

## 分阶段实施与验收

1. **工具契约**：完成 schema 2、创建/解析、四目录、根初始化与旧配置拒绝；临时目录验证无覆盖、目录重名、重复初始化、损坏受管块和 Git 根。检查不同工作区的数据与请求隔离。
2. **Nexus 与 Bridge**：CodeBuddy 打开 var，在一个窗口切换多个工作区；核对按 toolHome 保存和恢复的 `workspaceState`、根窗口未选择及失效 key 清除、运行中窗口各自选择和后端明确 key；检查全部登记 checkout 的编辑状态与监听，以及源码树和 SCM 仅显示选中项。Bridge 多候选仅为当前请求选择，不写共享 ACTIVE。验证未保存编辑、登录与切换后的上下文，并在真实客户端核验窗口重载。
3. **团队插件**：按上述模板、分发、解析、Hook 和 tests 调整；夹具覆盖自定义 key、同名/别名歧义、子目录解析、API provider、跨目标写入拒绝、并发会话和轮次绑定、人工内容/Hook 冲突、重复更新。规范目录分别验证：`rules/` 已存在（含空目录）、仅有 `docs/`、两者均无、两者均有、`rules` 被普通文件占用；确认旧布局不会被自动创建 `rules/`，只向选中目录分发，入口引用与锁路径一致，旧 `docs/` 受管规范可继续更新。检查平台继承对象仍受只读保护。
4. **宿主实际验收**：用隔离测试数据目录，在真实 CodeBuddy 验证根入口、Nexus 切换、重载恢复、规则加载和 Hook；在 Codex 具体工作区启动验证父 AGENTS 与目标解析。分别核对客户端版本、实际运行证据、源码拉取、冲突恢复和平台业务结果；静态测试不能代替客户端或平台验收。
5. **交付检查**：核对公开文档及示例与最终代码一致，运行对应仓库测试、文档链接/关键词检查和 diff 检查；明确未完成项，按既有流程处理插件版本与发布，不在本次文档任务发布。

本方案对应的 guthon-team 源码、权威规范和内置载荷已在本地准备，使用 prepare 生成清单与副本；尚未提交、推送、发布、安装插件或同步真实业务工作区。安装缓存未改动，已完成隔离空间中的 Codex CLI/TUI 父规则加载、CodeBuddy IDE 根规则加载、Nexus 源码开发宿主切换及重载恢复，并捕获两端原生 Hook 事件。CodeBuddy 使用临时项目 Hook 接入当前源码；Marketplace 候选安装、Codex 桌面应用、Windows 和平台效果仍待分别验收，详见 [客户端验收记录](client-acceptance.md)。
