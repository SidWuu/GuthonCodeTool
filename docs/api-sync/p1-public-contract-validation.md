# P1 公共契约与配置读取适配

日期：2026-11-19。对应[长期设计 V1.1](long-term-unified-workspace-design.md)的 P1；本记录区分公共解析、源码执行、客户端安装和真实平台结果。

## 本地实现范围

- 新 toolHome 初始化 schema 3，逐项目明确 `sourceMode`，增加独立 `sourceTables` 字段映射。读取已有 API schema 2 时保留其版本和原行为；未知版本、损坏配置与活动新旧配置冲突明确报错，不回退或自动转换。
- 完整旧 YAML 可只读适配；保留原 key、source-mode 优先级、源码与文档路径、DATABASE 字段映射、同步规则及环境/凭据引用。旧空间 `setup` 核验后返回，不生成统一配置、Git 或业务目录。
- 公共解析支持 API checkout、SVN 原生 working copy 与授权 manifest、DATABASE readonly/workcopy。SVN 配置和 manifest 校验从现有实现提取到共享只读模块，不加载旧 provider 执行代码，不扫描业务源码或执行 SVN 命令。
- 公共结果提供配置来源、路径、来源绑定、目标配置能力与当前执行能力。`require_workspace_binding` 可重新解析并拒绝已变化的同 key 来源；所有旧会话的协同停用和迁移仍属后续阶段。
- 单项目解析或局部状态错误进入诊断，不阻断无冲突项目。Nexus 注册器增加保留 `configErrors` 的 snapshot，原列表调用保持；诊断行与项目总览 UI 属于 P2。
- API 入口保留执行能力。旧模式在本后端的源码更新、重建索引与登记改写明确拒绝，避免将 API 执行链路用于旧源码；现有老项目继续使用其原已验证入口。独立数据库只读排查仍使用实际目标和授权契约。

## 验证方式与结果

所有配置、工作副本路径与源码使用临时 toolHome 或本地夹具。Python 本地测试放在 Git 忽略的 `tests/`，不暂存或提交。测试覆盖三种模式的公共结果、旧模式优先级和显式路径、字段映射、加载及 setup 无改写、schema 2 保留、冲突与未知版本、局部诊断、manifest 范围、同 key 绑定变化及未接线入口拒绝。

| 验证 | 本轮结果 |
|---|---|
| 配置、统一工作区、公共契约、doctor、ToolHost 定向回归 | 61 项通过，使用隔离配置执行 |
| API Python 回归 | 340 项通过 |
| Nexus 全量 Node 回归 | 629 项通过，包含真实后端夹具与注册器诊断保持 |
| CLI self-test | 临时数据目录通过 |
| 公共文档与 QA | 校验四份 HTML、QA 数据和链接；另核验配置相关关键词进入实际搜索 |
| 索引与差异 | 校验 AI_CODE_INDEX 引用、方言参考同步脚本自检和本轮差异空白 |

上述代码回归不等于已安装客户端、Windows 或平台验收；未打包、安装、连接实际平台或数据库，未执行 SVN 更新/提交、API 上传或真实配置转换。

## 文档与保留边界

README、配置说明、AI_CODE_INDEX、全功能说明、使用手册及 QA 同步实际接入范围。Windows 安装页未改，原因是安装与首次连接操作没有变化。现有与当前任务无关的改动保留；本轮不改变暂存区、HEAD 或发布状态。

本文保留 P1 的验证范围。后续项目总览与卡片的实际进展见 [P2 记录](p2-project-views-validation.md)；P3 旧 provider 执行和 P4 配置升级、源码迁移仍独立推进。

后续执行能力见 [P3 接线记录](p3-provider-integration.md)。
