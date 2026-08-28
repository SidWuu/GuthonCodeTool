# Guthon SVN Navigator

在 VS Code 中浏览谷神新式 SVN 项目，按系统、数据源和源码对象显示中文目录，并快速打开页面、GSS、表和视图。

当前版本：0.7.21

## 支持的项目结构

插件只识别下面的新式结构：

```text
项目根目录/
├── systems/
│   └── SYS-XXXX/
│       ├── $.系统中文名/
│       ├── pages/
│       │   ├── index.md
│       │   └── 页面目录和 JSON
│       └── system-script/
├── datasources/
│   └── 0000/
│       ├── $.数据源中文名/
│       ├── procedures/
│       │   └── index.md
│       ├── tables/
│       └── views/
├── public/
└── skill/
```

- systems/<systemId>/ 保存系统页面和系统脚本。
- datasources/<dataSourceId>/ 保存过程函数、表和视图。
- $.中文名目录提供系统或数据源的显示名称。
- pages/index.md 和 procedures/index.md 是定位索引资料，不是业务源码。
- 页面、GSS、表和视图的最终内容以当前 SVN 工作副本中的真实文件为准。

项目根目录可以是一个 SVN 工作副本，也可以由多个新式子工作副本组成。项目名称、系统 ID 和数据源编号只是组织维度，不会被当成独立项目。

## 安装

使用 VSIX 安装：

```bash
code --install-extension guthon-svn-navigator-0.7.21.vsix
```

插件不依赖其他 VS Code SVN 扩展，但依赖本机 SVN 命令行程序。

## 配置

在工作区或多个项目的共同父目录创建 guthon-projects.yaml：

```yaml
version: 2

# 所有项目共用一个 SVN 用户名；密码不写入配置。
username: your-svn-user

projects:
  # 新式分片 SVN：每个 checkout_paths 是一个独立工作副本。
  gmeSvn:
    name: 期现产品
    path: gmeSvn
    repository_url: https://source.example/project
    checkout_paths:
      - skill
      - public
      - systems/SYS-XXXX
      - datasources/0000

  # 新式整项目 SVN：不填写 checkout_paths。
  newProject:
    name: 新项目
    path: newProject
    repository_url: https://source.example/new-project
```

配置规则：

- 有非空 checkout_paths：按分片模式分别 checkout、update、status、commit 和回滚。
- 没有 checkout_paths 或配置为空：按整项目模式，对项目根目录执行一次 checkout/update/status/commit。
- 顶层 username 只配置一次；密码使用 SVN 凭据缓存或命令行认证，不写入 YAML。
- 不再配置数据源映射、系统映射或源码路径映射；这些信息从项目目录和索引文件读取。

首次在空目录执行初始化配置项目时，插件会生成上述模板；模板使用 your-svn-user，不会写入开发者机器上的手机号或真实账号。

## 初始化和切换项目

在中文源码目录标题栏选择初始化配置项目：

- 分片模式按 checkout_paths 创建目录并逐个 checkout。
- 整项目模式创建项目目录并执行 svn checkout repository_url projectRoot。
- 已存在根 .svn 时先执行 svn info 核对 URL，再更新。
- 如果上一次 checkout/update 因网络或网关超时中断，工作副本可能显示为 `incomplete` 或 `wc-locked`；再次初始化或更新时插件会先自动执行安全的 SVN Cleanup，再继续更新。
- 已存在但非空且没有 .svn 的目录不会被覆盖。
- 根目录和子目录同时存在工作副本时，优先使用 systems/*、datasources/*、public 和 skill 下的真实子工作副本。

多个项目时，使用选择当前项目切换。目录树、搜索、AI 索引和源代码管理都只显示当前项目，不会混合同名系统或数据源。

## 中文源码目录

目录树按以下层级显示：

```text
项目
├── 系统中文名
│   ├── 页面
│   └── 系统脚本
└── 数据源中文名
    ├── 过程函数
    ├── 表
    └── 视图
```

系统名来自 systems/<systemId>/$.中文名，数据源名来自 datasources/<dataSourceId>/$.中文名。页面和过程函数名称优先来自对应 index.md，找不到时才使用源码身份字段或文件名。

## AI 索引

点击标题栏 AI 索引后选择重建当前项目 AI 索引。索引由插件自带 Node.js 代码生成，不依赖 Python 或 SQLite。

每个项目独立生成：

```text
项目根目录/docs/ai-index/
├── manifest.json
├── objects.jsonl
├── relations.jsonl
└── pages/*.md
```

- manifest.json：项目 ID、布局版本、生成时间和对象统计。
- objects.jsonl：页面、服务组件、过程函数、系统脚本、表和视图，以及真实相对路径、系统/数据源归属和中文别名。
- relations.jsonl：页面、GSS、过程函数、表和视图之间的调用或使用关系。
- pages/*.md：页面结构、事件脚本、SQL、GSS 数据源和依赖摘要。

索引路径统一使用：

```text
systems/SYS-XXXX/pages/...
systems/SYS-XXXX/system-script/...
datasources/0000/procedures/...
datasources/0000/tables/...
datasources/0000/views/...
```

AI 应先读取当前项目的 manifest.json 和 objects.jsonl 定位对象，再按对象的真实 path 读取源码。索引缺失、过期或路径冲突时，只在当前项目内回退到 pages/index.md 或 procedures/index.md，并提示重建索引。索引文件由插件生成，不要手工修改。

## 搜索和跳转

搜索源码对象和搜索 AI 索引并定位支持页面编码、页面中文名、系统名、过程函数 ID、过程函数中文名、服务组件 ID、系统脚本、表、视图、数据源编号和中文名。

选中结果后会自动展开当前项目的系统或数据源目录并打开真实文件。GSS 中支持 macOS Command+点击或 Windows Ctrl+点击：

```gss
$vs.proc.invoke('com.golden.bdp.gdrm.report.queryFuturesExposureMatch', 'run', $form)

#set($proc = $vs.proc.find('com.golden.bdp.gdrm.common'))
$proc.setMainState($inputForm)

$vs.proc.runServiceComp('com.golden.bdp.gdrm.project.checkHedgingSetting', $form)
```

页面服务组件和过程函数中的 @inherit() 也支持跳转到同目录父级实现。页面或 GSS 当前片段内的 @method() 调用支持跳转到同一片段的 #function method 定义。

## SVN 状态、变更和提交

插件仅对新结构的以下位置扫描工作副本：

- 项目根 .svn；
- systems/*/.svn；
- datasources/*/.svn；
- public/.svn；
- skill/.svn。

插件实际执行 svn status --xml --ignore-externals，然后把状态合并到当前项目的源代码管理视图。真实文件显示 M、A、D、冲突或未版本控制状态时，中文目录和变更列表会同步标记。

检查 SVN 状态会输出实际使用的 SVN 程序、当前项目、项目根目录、每个 .svn 工作副本、状态命令结果以及变更数量。

如果终端对文件显示 M 而插件没有显示，先确认当前选择的项目、文件是否位于上述新式工作副本，以及扩展进程是否能找到同一个 SVN 命令行程序。

变更列表中的文件名优先显示 AI 索引或 index.md 中的中文名，同时保留真实路径。右键文件可以查看脚本/SQL 可读差异、查看原始文件差异、查看 SVN 历史、取消当前文件更改、加入 SVN、设置 SVN 变更集和导出真实 SVN Patch。

完整文件差异不会修改源码。删除或缺失文件时，左侧显示 SVN BASE，右侧为空，可以看到删除内容。提交按真实工作副本分别执行，不会把多个 checkout 拼成一个 SVN 提交。

## GSS 继承和只读父级

支持的继承文件必须位于：

```text
datasources/0000/procedures/com/example/check.gss
datasources/0000/procedures/com/example/check.inherit.gss
systems/SYS-XXXX/pages/8/6/service.gss
systems/SYS-XXXX/pages/8/6/service.inherit.gss
```

.inherit.gss 是只读父级，不作为独立业务对象加入 AI 索引。子文件有效调用 @inherit(); 或 return @inherit(); 时，索引会记录 inheritance、effectiveSourcePaths 和 inherits 关系，并同时分析父子代码的依赖。

需要修改继承逻辑时，先执行展开继承到子文件：

1. 插件核对当前项目、父级路径和唯一继承调用。
2. 用户确认后，将父级业务脚本原位展开到子文件。
3. 保留子文件身份注释和继承调用前后的代码。
4. 父级文件不修改，子文件可用 VS Code 撤销恢复。

父级缺失、父级继续继承或继承调用不唯一时，操作会停止，不产生部分修改。

## Windows 和 macOS

插件通过系统命令行运行 SVN。也可以在 VS Code 设置中填写完整路径：

```json
{
  "guthonSvnNavigator.svnExecutable": "/opt/homebrew/bin/svn"
}
```

Windows 示例：

```json
{
  "guthonSvnNavigator.svnExecutable": "C:\\\\Program Files\\\\TortoiseSVN\\\\bin\\\\svn.exe"
}
```

插件会优先使用配置的路径，其次检查 VS Code PATH 和常见 macOS/Windows 安装位置。也可以执行选择 SVN 命令行程序。路径比较会兼容 Windows 大小写差异；目录移动后必须保留 .svn 元数据。

## 常用命令

- 刷新中文源码目录
- 选择当前项目
- 初始化配置项目
- 重建当前项目 AI 索引
- 检查 SVN 状态
- 更新当前存储库
- 全量更新项目
- 提交工作副本更改
- 查看文件 SVN 历史
- 展开继承到子文件

## 问题排查

1. 确认打开的是项目根目录或配置文件所在的工作区。
2. 确认项目下存在 systems 或 datasources，且至少有一个有效 .svn 工作副本。
3. 执行选择当前项目确认当前项目。
4. 执行检查 SVN 状态查看实际路径和 SVN 输出。
5. 如果索引不能使用，执行重建当前项目 AI 索引。

svn 返回 502、网络超时或认证失败属于 SVN 服务端、网络或凭据问题；插件不会删除已经下载的内容。对于 502，稍后再次初始化或更新即可继续；对于 `incomplete`/`wc-locked`，插件会自动 Cleanup 后重试。详细命令和失败路径会写入 Guthon SVN 输出通道。
