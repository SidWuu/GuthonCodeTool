# GuthonCodeTool

谷神低代码平台的本地开发工具集，支持 API、SVN 和 DATABASE 源码同步，连接 IDE、浏览器和 AI，并提供独立的数据库诊断与测试。

[下载发行版](https://github.com/SidWuu/GuthonCodeTool/releases/latest) · [使用手册](https://sidwuu.github.io/GuthonCodeTool/) · [全功能说明](https://sidwuu.github.io/GuthonCodeTool/GuthonCodeTool_全功能说明.html) · [常见问题](https://sidwuu.github.io/GuthonCodeTool/GuthonCodeTool_QA.html)

## 能做什么

- 按项目设置同步范围，在独立工作区更新、检索和编辑源码。
- 在 Nexus 比较本地改动。根据项目同步方式审阅并上传源码，或提交 SVN 工作副本，再核对逐项结果。
- 通过 MCP 按明确工作区查询和受控修改本地文件；Bridge 按需提供网页字段复制、导航、滚动和页签排序。
- 独立配置数据库目标，开展只读诊断、测试计划和结果核验。

## 开始使用

安装 GuthonCodeTool 和 Nexus，在 IDE 打开开发目录（默认可命名为 `var`），从 Nexus 完成初始化。添加项目时，按项目实际来源选择 API、SVN 或 DATABASE，配置连接和同步范围，再更新源码建立索引。网页辅助和团队治理可按需安装。安装和日常操作见[使用手册](docs/GuthonCodeTool_使用手册.html)，各模式的能力和限制见[全功能说明](docs/GuthonCodeTool_全功能说明.html)。

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
