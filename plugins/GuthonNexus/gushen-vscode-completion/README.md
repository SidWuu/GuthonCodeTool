# Guthon Nexus

谷神源码开发插件，在开发目录根窗口管理 API、SVN 和 DATABASE 项目，完成连接、选择同步范围、更新源码、检索和受控编辑。API 项目按子系统拉取到项目的 checkout，上传前比较平台版本，上传后逐项回读。

支持官方风格的 API 签名和文档提示，同时保留 Nexus 的关键词、方法名及缩写补全；提供定义跳转、PAGE XML/JSON 编辑、字段集合 JSON、继承展开、草稿恢复、SCM 和 Quick Diff。

侧栏采用“项目总览＋当前项目＋项目源码”。总览按名称、别名或 key 搜索，点击项目行切换当前窗口目标。卡片与源码树联动，已打开的标签页和草稿保持原归属。卡片提供常用操作，其他功能位于原生“…”菜单。三种方式保存范围后都需手动点击「更新源码」。缩小范围时，更新按模式清理退出范围的同步副本，保护本地修改。清单 SVN 支持受控分块编辑和提交审阅。DATABASE 从只读目录读取同步源码，修改保存到 Workcopy。

首次使用时，打开开发目录并初始化，创建工作区，登录后选择同步范围，再手动更新源码。Codex 可打开具体工作区目录，通过同一 Git 根读取根 AGENTS.md。浏览器增强按需启用，数据库诊断使用独立只读目标。

上传前可按名称、类型及路径勾选文件并查看差异；源码树支持仅展示过滤、物理文件操作和资源管理器状态提示。继承标记及全局事务调用支持导航，本地函数支持注释悬停；物理 PAGE 的原生编辑器复用现有草稿。

从项目菜单生成 `guthon-source-helper` 客户端配置，预览后合并并检查连接。API 在线操作可复用对应 Nexus 项目的登录会话。操作步骤见使用手册，API 能力及验证边界见[功能吸收记录](https://github.com/SidWuu/GuthonCodeTool/blob/main/docs/api-sync/official-adoption.md)。

Nexus 可检查 Open VSX 官方来源包，校验并切换兼容的补全资源，用临时编辑器说明变化与回退结果。同步、设计器等执行协议的升级随经过适配验证的 Nexus 版本发布。

查阅[使用手册](https://sidwuu.github.io/GuthonCodeTool/)和 [GuthonCodeTool 发行说明](https://github.com/SidWuu/GuthonCodeTool/releases)。
