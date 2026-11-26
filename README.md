# GuthonCodeTool

谷神低代码平台的本地开发工具集，连接源码、编辑器、浏览器和 AI，通过 API 接入项目源码，支持独立数据库诊断与测试。

`api-sync` 的说明对应本分支的代码与构建产物。使用开发模式时指向本分支 worktree；已发布附件是否包含 API 功能，以对应发行说明为准。

[下载发行版](https://github.com/SidWuu/GuthonCodeTool/releases/latest) · [使用手册](https://sidwuu.github.io/GuthonCodeTool/) · [全功能说明](https://sidwuu.github.io/GuthonCodeTool/GuthonCodeTool_全功能说明.html) · [常见问题](https://sidwuu.github.io/GuthonCodeTool/GuthonCodeTool_QA.html)

## 能做什么

- 通过谷神 API 按项目和子系统拉取 PAGE、过程函数、系统脚本、表、视图及公共资料，在独立工作区维护本地源码。
- 使用 Nexus 检索、编辑、比较和上传；支持本地 PAGE 页面草稿、API 冲突处理与逐项回读。
- 通过 MCP 按明确工作区查询和受控修改本地文件；Bridge 按需提供网页字段复制、导航、滚动和页签排序。
- 独立配置数据库目标，开展只读诊断、测试计划和结果核验。

## 开始使用

将 GuthonCodeTool 和 Nexus VSIX 放在上一级目录，在 IDE 打开自己新建的开发目录（默认可命名为 `var`），从 Nexus 初始化。配置生成在上一级，日常继续打开同一个开发目录。在 Nexus 添加项目时，项目目录位于开发根的 `workspace/` 下。选择 API 项目并登录，再选同步范围，首次拉取同时建立索引。Codex 可打开具体项目目录，继承开发根的 `AGENTS.md`。需要浏览器辅助或团队治理时分别安装对应组件。

当前分支已接入公共配置契约：保留 API schema 2，新增 schema 3，并可只读解析旧 SVN/DATABASE 分类 YAML，保留原 key、路径和字段映射。Nexus 已接入“项目总览＋当前项目卡片＋项目源码”和配置诊断。SVN/DATABASE 通过各自入口更新源码、查看变更和操作记录，旧配置加载保留原文。配置可离线预览、备份并显式升级至 schema 3。SVN 到 API 已接入源侧预检，候选下载与切换仍在实施。源码实现、已安装客户端、平台回读和业务运行是不同验证阶段。详见 [使用手册](docs/GuthonCodeTool_使用手册.html) 和 [全功能说明](docs/GuthonCodeTool_全功能说明.html)。

## 开发与维护

- [开发规则](AGENTS.md) · [代码导航](AI_CODE_INDEX.md) · [配置参考](config/README.md)
- [工作空间布局与团队插件调整方案](docs/api-sync/workspace-layout-and-guthon-team-plan.md)
- [Windows 安装器构建](docs/UNIFIED_INSTALLER.md) · [发行镜像维护](docs/RELEASE_MIRROR.md) · [API 迁移功能矩阵](docs/api-sync/feature-matrix.json)
- 谷神业务开发从私有工作区的 `AGENTS.md` 进入；数据库排查与验证参见 [Guthon Testing Skill](skills/guthon-testing/SKILL.md)。

### 合并前回归

[Pre-merge 工作流](.github/workflows/regression.yml) 在 PR 与合并队列运行 `Regression gate`。保护目标分支时，将该任务设置为必需状态检查。工作流运行公开 Python 回归集、源码和 zipapp 冒烟、Nexus 与 Bridge 测试，以及生成资源和文档校验。

本地从仓库根运行 `PYTHONPATH=scripts .venv/bin/python -m unittest discover -s tests/ci -v`。测试需要 Git、`svn` 和 `svnadmin`，使用临时数据目录、本地 SVN 仓库和模拟数据库响应。其他 `tests/` 内容保留为本机历史测试，可独立运行调查旧行为。共享回归用例放在 `tests/ci/`，使用可从干净检出重建的夹具。

## 文档

- [在线文档](https://sidwuu.github.io/GuthonCodeTool/)
