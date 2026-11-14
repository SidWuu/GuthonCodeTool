# Guthon Nexus

谷神 API 源码开发插件，在当前项目窗口完成登录、按子系统拉取、源码浏览与受控编辑。当前源码保存在唯一的 checkout 中，上传前比较平台版本，上传后逐项回读。

支持官方风格的 API 签名和文档提示，同时保留 Nexus 的关键词、方法名及缩写补全；提供定义跳转、PAGE XML/JSON 编辑、字段集合 JSON、继承展开、草稿恢复、SCM 和 Quick Diff。

侧栏包含“谷神项目”和“谷神源码”：卡片下方提供常用操作按钮，项目设置提供向导，其余功能集中在右上角原生“…”菜单。源码按页面、过程函数、表、视图和系统脚本分类。新数据目录统一使用 config/guthon.json，已有配置仅在明确确认迁移后合并。

首次使用：设置 GuthonCodeTool 运行入口与显式数据目录，创建产品或项目，在独立窗口登录并选择范围，再更新源码。浏览器增强按需启用；数据库诊断使用独立只读目标。

Nexus 可检查 Open VSX 官方来源包，校验并切换兼容的补全资源，用临时编辑器说明变化与回退结果。同步、设计器等执行协议的升级随经过适配验证的 Nexus 版本发布。

`api-sync` 说明对应该分支代码及构建产物，正式发行包的功能以对应发行说明为准。源码、离线 HTML 手册和配置参考见 [GuthonCodeTool 仓库](https://github.com/SidWuu/GuthonCodeTool/tree/api-sync)；完整实现与验证边界见仓库的 `docs/api-sync/feature-matrix.json`。
