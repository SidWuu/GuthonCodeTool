# GuthonCodeTool 安装后冒烟验收

本清单用于每次正式发行后的 macOS、Windows 实机验收。自动化构建只能证明构建产物在 CI 环境启动并通过协议检查；VSIX、Chrome 扩展、实际页面、受控数据库和 SVN 工作副本需要逐项记录实机证据。验收时使用专用开发或测试工作区，避免在生产环境执行写入。

## 发行产物和记录

记录版本、下载来源、校验文件、操作系统和架构、VS Code 版本、Chrome 版本、Nexus VSIX 版本、扩展版本，以及验收人和时间。每项保留“通过 / 失败 / 未执行”及首条失败信息；未执行不能写成通过。

| 平台 | 应用入口 | 脚本入口 | 需安装的界面组件 |
| --- | --- | --- | --- |
| macOS Apple Silicon | 解压 `GuthonCodeTool-macos-arm64.zip` 后的 `GuthonCodeTool` | `GuthonCodeTool-python.pyz` 与 Python 3.12+ | `guthon-nexus-vscode.vsix`、`GuthonCodeTool-chrome.zip` |
| Windows x64 | `GuthonCodeTool-windows-x64.exe` | 同一 pyz 与 Python 3.12+ | 同一 VSIX、Chrome 扩展 ZIP |

先对下载件核对 `GuthonCodeTool-checksums.txt`，再在空的临时数据目录运行仓库内的冒烟脚本：

```bash
python scripts/check_release_smoke.py --entry /path/to/GuthonCodeTool
# Windows: python scripts/check_release_smoke.py --entry D:\tools\GuthonCodeTool-windows-x64.exe
# pyz:     python scripts/check_release_smoke.py --entry /path/to/GuthonCodeTool-python.pyz
```

脚本依次检查 `version`、`self-test`、`setup`、MCP stdio 握手、默认 28 个工具与只读模式 15 个工具，并自动删除临时 toolHome。此检查不读取真实配置，也不代替后续组件联调。

## 实机检查矩阵

| 检查点 | 操作与通过标准 | 证据 |
| --- | --- | --- |
| 应用和 ToolHost | 在 Nexus 选择该发行应用和独立数据目录，执行“检查本地环境”；运行模式、入口路径、数据目录可在工作区树中核对，输出包含成功阶段。连续执行两次只读查询，ToolHost 保持可用。 | 入口路径、版本、输出首尾和 ToolHost 状态 |
| VSIX | 安装同版 VSIX、重载 VS Code；活动栏出现 Guthon Nexus，目标 `workspaceKey` 的项目和驾驶舱可见。 | VSIX 版本、工作区身份、驾驶舱状态 |
| Bridge | 启动由 Nexus 管理的 Bridge，检查 `127.0.0.1:17361` health；安装并重载 Chrome 扩展，在允许来源的测试页面观察按钮及目标工作区选择。 | health 结果、页面 origin、工作区身份、请求结果 |
| Chrome → Nexus PAGE 定位 | 在模块开发页选中已知 PAGE，用 Bridge 弹窗打开 Nexus；VS Code 应显示 SVN 工作区选择，确认精确 PAGE ID 后打开预期虚拟分块。若 VS Code 被唤起但没有响应，检查实际安装 VSIX 的 `onUri` 能力，强制重装当前构建并重载窗口后复测。 | PAGE ID、安装包构建、工作区与源码身份、VS Code 实际结果 |
| Chrome → Nexus 过程函数定位 | 选中已知过程函数页签，分别从 Bridge 弹窗和页面左下角按钮打开 Nexus；确认工作区选择、精确包名和函数名、候选源码身份及虚拟文档。PAGE 也从页面左下角按钮复测一次。 | 页签身份、包名与函数名、工作区、实际打开的源码；失败时记录 Chrome 和 VS Code 的第一条错误 |
| MCP | 用发行应用或 pyz 的绝对路径注册 `mcp --stdio --home <toolHome>`；握手后默认发现 28 个工具，`--read-only` 发现 15 个查询工具；调用 `get_runtime_status` 并确认目标工作区。 | 命令和参数、协商协议版本、工具数、状态摘要 |
| DATABASE | 在专用开发/测试目标解析 `workspaceKey`、环境、库/schema；探测只读连接，执行一条有界查询，再检查同步和 Workcopy 状态。 | 目标身份、探测结果、同步阶段及 Workcopy 差异 |
| SVN | 使用有授权的测试根地址检出或复用工作副本；刷新索引，查询一个已知 PAGE 和过程函数；如需验证写入，只在受控目标用预览、幂等键和 SVN diff 检查，结束时按原有流程处理测试改动。 | 根地址身份、revision、索引状态、对象身份、diff |

若任一项失败，先记录当前运行模式、入口路径、toolHome、`workspaceKey` 和“输出 → GuthonCodeTool”的首条失败阶段；再按 [QA](GuthonCodeTool_QA.html) 的对应问题处理。MCP 写入响应不明时保留原 `idempotencyKey`，先查询原操作，不直接重试写入。

## 本次执行记录

此文件是验收模板。实际安装、真实页面、数据库和 SVN 的结果需在每次发行时另行填写，不能由源码测试推断。
