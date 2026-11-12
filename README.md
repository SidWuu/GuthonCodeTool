# GuthonCodeTool

谷神低代码平台的本地开发工具集，连接源码、编辑器、浏览器和 AI，通过 API 接入项目源码，支持独立数据库诊断与测试。

`api-sync` 的说明对应本分支的代码与构建产物。使用开发模式时指向本分支 worktree；已发布附件是否包含 API 功能，以对应发行说明为准。

[下载发行版](https://github.com/SidWuu/GuthonCodeTool/releases/latest) · [使用手册](https://sidwuu.github.io/GuthonCodeTool/) · [全功能说明](https://sidwuu.github.io/GuthonCodeTool/GuthonCodeTool_全功能说明.html) · [常见问题](https://sidwuu.github.io/GuthonCodeTool/GuthonCodeTool_QA.html)

## 能做什么

- 通过谷神 API 按项目和子系统拉取 PAGE、过程函数、系统脚本、表、视图及公共资料，在各项目窗口维护本地源码。
- 使用 Nexus 检索、编辑、比较和上传；支持本地 PAGE 页面草稿、API 冲突处理与逐项回读。
- 通过 MCP 按明确工作区查询和受控修改本地文件；Bridge 按需提供网页字段复制、导航、滚动和页签排序。
- 独立配置数据库目标，开展只读诊断、测试计划和结果核验。

## 开始使用

安装 GuthonCodeTool 与 Guthon Nexus，设置显式本地数据目录后创建产品或项目。配置 API 地址、登录并选择子系统及共享数据源，再拉取当前项目源码；每个项目使用自己的窗口。需要浏览器辅助或团队治理时分别安装对应组件。

当前分支仍在集成；源码实现、已安装客户端、平台回读和业务运行是不同验证阶段。详见 [使用手册](docs/GuthonCodeTool_使用手册.html) 和 [全功能说明](docs/GuthonCodeTool_全功能说明.html)。

## 开发与维护

- [开发规则](AGENTS.md) · [代码导航](AI_CODE_INDEX.md) · [配置参考](config/README.md)
- [Windows 安装器构建](docs/UNIFIED_INSTALLER.md) · [发行镜像维护](docs/RELEASE_MIRROR.md) · [API 迁移功能矩阵](docs/api-sync/feature-matrix.json)
- 谷神业务开发从私有工作区的 `AGENTS.md` 进入；数据库排查与验证参见 [Guthon Testing Skill](skills/guthon-testing/SKILL.md)。

## 文档

- [在线文档](https://sidwuu.github.io/GuthonCodeTool/)
