# Guthon SVN Navigator

面向谷神 SVN 源码快照的 VS Code 扩展。插件不会改名、移动或复制 SVN 中的业务文件，而是解析每个系统的 `pages/<SYSTEM_ID>/index.md`，在 VS Code 左侧展示中文页面目录。

## 功能

- 自动识别旧式完整 SVN 工作副本，以及页面、过程函数、表和视图分别 checkout 的新版组合工作区。
- 按“系统 → 中文目录 → 菜单 → 页面对象”展示页面树。
- JSON 页面可按查询区、表单、主表、页签、明细表继续展开，并查看其中的字段、按钮、事件和数据源 SQL；这些节点都是同一个物理文件的虚拟视图。
- 点击虚拟控件只打开当前片段的虚拟文档，不再展示整份 JSON；服务组件 `.gss` 仍可直接打开。
- 组件、控件的右键菜单保留“在原始 JSON 中定位”，需要修改时可回到同一个物理文件。
- 页面、组件、字段和按钮中的所有 `*Script` 都会拆成独立脚本节点；字段脚本会显示字段编码和字段名称，便于区分多个 `onChangeScript`。
- 脚本虚拟文档保存时保留原脚本格式，并把特殊字符按原 JSON 规则重新转义，减少 SVN 无意义差异。
- 脚本、数据源 SQL 和“字段（数量）”集合虚拟文档支持直接编辑，按 `Ctrl+S` 会回写原始 JSON；组件和按钮整体片段仍需回到原始 JSON 修改。
- 使用“搜索页面”跨系统查找主页面、子页面、弹窗、选窗和服务组件。
- `index.md` 发生变化时自动刷新目录。
- 在 VS Code“源代码管理”视图中显示 SVN 新增、修改、删除和冲突文件，并支持查看差异、`svn update` 和提交。
- 页面 JSON 的差异查看显示格式化后的事件 Script 和数据源 SQL；原始 SVN 文件仍保持原布局。
- 在插件面板中执行 `svn update` 或查看 `svn status`。
- 为 `.gss` 文件提供基础 Guthon VM 语法高亮。

## 安装

使用 VS Code 的“扩展：从 VSIX 安装...”命令，选择生成的：

```text
guthon-svn-navigator-0.3.4.vsix
```

安装后打开 SVN 工作副本目录，左侧活动栏会出现 `Guthon SVN` 图标。

如果当前 VS Code 工作区不是项目根目录，点击页面树中的“选择 SVN 工作副本”。旧结构可以选择包含 `.svn` 和 `pages` 的完整工作副本：

```text
.svn/
info.json
pages/
```

新版分片结构应选择所有 checkout 目录的共同上层目录。这个目录自身可以没有 `.svn`：

```text
项目目录/
  skill/.svn/
  public/.svn/
  pages/SYS-.../.svn/
  procedures/0000/.svn/
  system-script/SYS-.../.svn/
  tables/0000/.svn/
  views/0000/.svn/
```

插件把这些独立工作副本聚合成一个逻辑项目，不会要求改回旧目录结构。

## 使用

### 浏览和打开页面

1. 打开左侧 `Guthon SVN`。
2. 展开产品、系统、中文目录和菜单。
3. JSON 页面单击后会展开组件树；继续展开组件即可选择字段、按钮、事件或数据源 SQL。
4. 单击最末级控件，只查看该字段、按钮、事件或 SQL 片段；模块行右侧的预览按钮可以只查看整个模块。
5. 右键虚拟节点执行“在原始 JSON 中定位”可回到真实文件；页面行右侧的“打开文件”按钮可直接打开完整 JSON。
6. 脚本、SQL 和字段集合虚拟文档保存后会同步到唯一的原始 JSON 文件；不会生成额外的虚拟文件。GSS 页面仍然单击即打开。

### 搜索页面

点击页面树标题栏的搜索按钮，或运行：

```text
Guthon SVN: 搜索页面
```

搜索支持中文页面名称、系统 ID、页面类型和完整中文层级。

### 更新 SVN

点击项目页标题栏的下载按钮，或执行“全量更新项目”。旧结构更新项目根工作副本；新版结构会按顺序更新所有独立 checkout，并在结束时汇总成功和失败结果。每个中文存储库标题栏上的下载按钮只更新当前 checkout。命令使用系统安装的 `svn` 客户端逐个执行：

```text
svn update -- <工作副本目录>
```

完成后中文页面树会自动刷新。SVN 输出位于 VS Code 的 `Guthon SVN` 输出通道。

### 查看变更与提交

打开 VS Code 左侧“源代码管理”（分支图标），即可看到当前工作副本的“工作副本更改”。新版会按实际 checkout 显示中文存储库，例如“国际贸易 · 页面”“贸易系统 · 过程函数”“风险管理 · 系统脚本”；页面文件优先显示 `index.md` 中的中文页面名称，悬浮提示仍保留原始 SVN 路径和编码。默认点击文件打开“脚本/SQL 可读差异”：页面 JSON 只展开事件脚本和数据源 SQL，便于看业务修改。右键选择“查看真实文件差异”可核对 SVN `BASE` 与当前原始文件的完整文本；两种查看方式都不会改动源码。

右键实际文件或 Guthon SVN 变更项，选择“查看文件 SVN 历史”，可查看最近 50 个版本的版本号、作者、时间和提交说明；选中版本后可只读打开该版本，或与当前文件比较。

提交行为与通用 SVN 插件一致：每个独立 checkout 单独提交，先勾选要提交的文件，再输入提交说明。不会再把多个 checkout 拼成一条 `svn commit` 命令。未纳入版本控制的文件显示在独立分组中，右键选择“加入 SVN”后才会进入可提交列表。顶部下载按钮执行更新；提交实际执行：

```text
svn commit -F <UTF-8 提交说明文件> --encoding UTF-8 --depth empty -- <已选择文件...>
```

提交说明会通过 UTF-8 文件并携带 `--encoding UTF-8` 写入 SVN，避免中文说明出现乱码。

未纳入版本控制的文件也会显示在列表中；提交前请确认它们是否应加入 SVN。

## 配置

其他 SVN 源代码管理扩展创建的 `SYS-* pages`、`0008 procedures` 等原始存储库标题无法由本插件改名。若只希望看到中文列表，请在扩展管理中对该通用 SVN 扩展选择“禁用（工作区）”；Guthon SVN 的更新、查看差异和提交功能不受影响。

如仍需使用通用 SVN 扩展扫描多个独立 checkout，请在 VS Code 用户设置中开启：

```json
"svn.multipleFolders.enabled": true,
"svn.multipleFolders.depth": 4
```

- `guthonSvnNavigator.repositoryRoot`：手工指定完整工作副本根目录，或新版分片 checkout 的共同上层目录。
- `guthonSvnNavigator.autoRefresh`：索引变化时自动刷新，默认开启。
- `guthonSvnNavigator.showIds`：在系统节点旁显示 SYSTEM_ID。
- `guthonSvnNavigator.showMissingPages`：显示索引中存在但目标文件已经缺失的历史节点，默认关闭。
- `guthonSvnNavigator.trustServerCertificate`：临时信任 SVN 服务器证书，默认关闭。仅当服务器证书过期、主机名不匹配或颁发者未知且暂时无法修复时开启。

如需临时开启，可在工作区 `.vscode/settings.json` 中加入：

```json
{
  "guthonSvnNavigator.trustServerCertificate": true
}
```

这会对更新、提交、状态查询和差异读取放宽证书校验；服务器证书修复后请关闭。

## 开发验证

打包工具要求 Node.js 20.18 或更高版本；插件本身运行在 VS Code 扩展宿主中，没有第三方 npm 依赖。

```bash
npm test
npm run check
npm run package
```
