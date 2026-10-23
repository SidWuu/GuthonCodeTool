# GuthonCodeTool

谷神低代码平台的本地开发工具集，连接源码、编辑器、浏览器和 AI，支持 DATABASE 与 SVN 两种源码模式。

[下载发行版](https://github.com/SidWuu/GuthonCodeTool/releases/latest) · [使用手册](https://sidwuu.github.io/GuthonCodeTool/) · [全功能说明](https://sidwuu.github.io/GuthonCodeTool/GuthonCodeTool_全功能说明.html) · [常见问题](https://sidwuu.github.io/GuthonCodeTool/GuthonCodeTool_QA.html)

## 能做什么

- **管理源码与工作区**：产品、项目独立配置；DATABASE 同步与 Workcopy 开发，SVN 检出、编辑、差异和提交。
- **在编辑器中开发**：Guthon Nexus 提供源码树、API 补全、定义跳转、PAGE 编辑、SCM 和工作区状态。
- **让 AI 有据可查**：本地索引和 `guthon-svn` MCP 支持定位源码、查询调用关系及受控页面与过程函数修改。
- **增强平台操作**：Guthon Bridge 提供字段复制、脚本导航、列表滚动和平台与 Nexus 双向定位。

## 开始使用

支持 **Windows x64** 和 **macOS Apple Silicon**。

1. 从 [Releases](https://github.com/SidWuu/GuthonCodeTool/releases/latest) 下载适合的发行包。Windows 可直接按 [一键安装步骤](https://sidwuu.github.io/GuthonCodeTool/GuthonCodeTool_Windows安装步骤.html#one-click) 配置；macOS 按使用手册安装应用、Nexus VSIX 和需要的 Chrome 扩展。
2. 在 Nexus 选择工具入口和长期保留的本地数据目录（`toolHome`），添加产品或项目，并选择 DATABASE / SVN。
3. 按 [使用手册](https://sidwuu.github.io/GuthonCodeTool/) 接入源码，开始浏览、编辑和检查差异；需要 AI 接入时配置 MCP。

真实配置、凭据和业务源码保存在仓库外的 `toolHome`。本地保存、SVN 提交与平台编译/运行分别核验；详细能力和限制见 [全功能说明](https://sidwuu.github.io/GuthonCodeTool/GuthonCodeTool_全功能说明.html)。

## 开发与维护

- [开发规则](AGENTS.md) · [代码导航](AI_CODE_INDEX.md) · [配置参考](config/README.md)
- [Windows 安装器构建](docs/UNIFIED_INSTALLER.md) · [发行镜像维护](docs/RELEASE_MIRROR.md)
- 谷神业务开发从私有工作区的 `AGENTS.md` 进入；数据库排查与验证参见 [Guthon Testing Skill](skills/guthon-testing/SKILL.md)。

## 文档

- [在线文档](https://sidwuu.github.io/GuthonCodeTool/)
