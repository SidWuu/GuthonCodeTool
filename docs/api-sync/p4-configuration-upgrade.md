# P4 配置升级与 SVN→API 切换

依据 [V1.1 长期方案](long-term-unified-workspace-design.md) 的 5.4 和 11。配置格式转换与单个项目切换独立执行。

## 配置升级

- 离线预览支持完整分类 YAML 和 API schema 2。它核对新旧工作区的 key、provider、scope、源码及运行路径，并检查实际配置字段。
- 发布要求停用其他写入入口并确认本次预览 ID。命令保存权限受限的原文件备份及摘要，复查来源后发布 schema 3。
- 中断期间公共配置读写停止。恢复校验原文件、备份和目标摘要，发布前还原原配置，发布后按已写入的统一配置确认完成。
- 配置升级保持原工作区模式。操作命令和恢复入口见 [配置参考](../../config/README.md)。

## SVN 源侧预检

在已完成配置升级的 SVN 项目上，命令验证 working copy 仓库身份、本地版本、授权范围和变更状态，检查待核对的 SVN 交付及平台操作。

```bash
python scripts/guthon_tool.py svn-api-migration --home "<toolHome>" --workspace "<workspaceKey>" -- preflight
```

预检将源侧证据、平台生效和编辑器离线状态分列。SVN revision 与谷神平台最终提交分别取证。

## 候选与切换

- `prepare` 使用正式 API 登录与读取链路下载候选，比较授权工作副本中可映射的对象。计划分别记录稳定身份、字节一致、跨格式或内容差异、额外 API 对象以及缺项／歧义。项目地址按配置的 origin（如有）核对，同时校验系统与数据源关联。旧平台最终生效由操作者提供独立依据。
- `apply` 使用已审阅的 planId 和人工核对记录。持锁重读 SVN 状态、候选及平台清单和正文摘要。先准备 `checkout/` 与独立 API 上下文，再发布同一 key 的权威登记。旧工作副本、索引及历史保留。SVN 写入在取得操作锁后核验当前绑定，拒绝切换前取得的旧绑定。
- `status` 查询登记是否发布。发布前的 `recover` 按摘要恢复候选位置；发布后核验现有 API 登记和材料。恢复保持其他项目配置与平台记录。操作步骤见[使用手册](../GuthonCodeTool_使用手册.html#migrate-local-changes)。

## 验证与边界

- 临时 SVN 仓库与合成 HTTP API 验证了原 key 和资料保留、多模式共存、凭据不落盘、API 读取和 MCP 回读、待确认差异、范围变化、脏工作副本、缺对象、旧写入拒绝，以及配置发布前后中断。另有 PAGE／视图跨格式身份、重复候选和继承缺项的回归。
- 公共契约、配置、迁移、旧 provider 与 ToolHost 定向 Python 回归通过 76 项，API 340 项，Nexus 646 项，Bridge 122 项。团队规则完整性检查通过，API 和升级后 SVN 契约分别通过 17 项和 4 项，目标选择与 Hook 门禁通过 59 项。调试 PYZ、Nexus VSIX 构建成功。
- 隔离 VS Code 和 CodeBuddy 已验证三层视图、API／DATABASE／SVN 切换和迁移后源码打开。CodeBuddy 另验证配置诊断、同一项目选择恢复及 MCP 回读，见[客户端验收记录](client-acceptance.md#v11-多项目与-svnapi-隔离验收2026-11-20)。真实数据库导出、谷神平台生效及业务验收需在相应环境分别取证。
- 两份历史本地测试仍使用缺少配置来源元数据的模拟配置、退役的 SVN 命令常量或旧调用位置。额外执行暴露 21 个错误，移除本轮相关改动的临时副本可复现；上述通过统计未包含这两份测试。

## guthon-team 规则与门禁评审

- 保留显式目标、受控修改及原回执核对原则。Hook 在写入前重新解析当前的 key、root 和 provider，旧会话沿用同一 key 时仍会因 provider 变化失效。API 回执核验按项目根下的 `checkout/` 读取，因此迁移保持此目录位置。
- 现行分发规则中的“新 API 布局使用 schema 2”和“Bridge 源码拉取只适用于 DATABASE”需要在下次获准发布团队规范时更新。schema 3 是新登记格式，Bridge 按能力执行 API 定向刷新或 DATABASE 拉取，SVN 继续提供定位及查询。
- 团队 Hook 要求项目 root 位于当前 `var/` 下。后端能登记明确的外部 root；团队插件对这种布局的支持需单独核验。正式团队规则和插件载荷本轮仅评审。
