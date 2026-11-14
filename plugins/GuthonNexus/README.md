# Guthon Nexus

谷神 API 源码开发的 VS Code 入口。每个项目使用独立窗口，源码位于显式 toolHome 下的 `var/checkout/<项目ID>`；支持按子系统和共享数据源选择范围。

- 谷神项目：合并项目详情与工作区入口，直接登录、更新或上传；设置从向导进入，维护工具位于“更多操作”。
- 源码开发：页面、过程函数、表、视图、系统脚本按类型展示；搜索、跳转、PAGE XML/JSON 结构与集合 JSON 编辑、继承展开、草稿恢复、SCM、Quick Diff 和冲突处理。
- 语言辅助：官方 API 签名与文档展示，保留 Nexus 关键词、方法名和缩写补全。
- 辅助能力：独立数据库诊断、上下文导出、CLI/MCP、可选浏览器增强，以及组件和官方兼容资源更新。

本分支尚未单独发布正式版本。详细操作和能力边界以仓库内的 [使用手册](../../docs/GuthonCodeTool_使用手册.html)、[全功能说明](../../docs/GuthonCodeTool_全功能说明.html)、[QA](../../docs/GuthonCodeTool_QA.html) 和 [功能矩阵](../../docs/api-sync/feature-matrix.json) 为准。

## 开发与验证

插件源码位于 `gushen-vscode-completion/`。首次验证先安装精确运行时依赖：

```bash
cd plugins/GuthonNexus/gushen-vscode-completion
npm install --omit=dev --ignore-scripts --no-audit --no-fund
npm test
npm run check
npm run package
```

修改 CLI 动作协议后执行 `npm run build:bridge`，同步权威动作元数据与 Bridge 副本。贡献、注册与菜单使用仓库根的 `node scripts/check_nexus_commands.mjs` 检查。源码快照、本地更新和标准 VSIX 均须包含运行时依赖和相关许可证。

后端支持源码开发、Python pyz 与独立应用三种入口；运行目录、命令和版本由 runtime descriptor 声明。字段、接口和实现入口见 [AI 代码导航](../../AI_CODE_INDEX.md)，安装与构建边界见 [统一安装器说明](../../docs/UNIFIED_INSTALLER.md)。

本地保存、API 上传回读、数据库结构执行及平台业务运行分别核验。写入回执未知时先回读核对，保留操作记录和草稿。
