# 维护者发行与 Gitee 镜像同步

GitHub Actions 构建、签名并发布 GitHub Release。发布成功后，`Build Release` 自动触发独立的 `Sync Gitee Release`。镜像任务同步指定版本，再从 Gitee 重新下载全部附件校验大小和 SHA-256，并核对发行说明。镜像任务单独报告结果，GitHub 发行可独立完成。普通同事按 Nexus 中所选的 GitHub/Gitee 更新源使用工具。

## 从 main 发布

正式发行和同版本组件更新直接从 `main` 完成。仅为新功能验证创建分支，验证通过后先合入 `main`，再纳入发行。

1. 在 `main` 核对发布范围、组件版本和已确认的发行说明，执行与改动范围匹配的回归验证。
2. 在 `main` 完成发行提交并推送到 `origin/main`。同一次发行在 `[build]` 自动触发和 `--ref main` 手动触发之间选一种。
3. 发布和镜像回验完成后，核对发行来源提交、标签和本地 `main` 的基线。让本地工作区包含已发布的内容，并保留未纳入发行的改动和草稿。

## 按组件更新当前 GitHub 版本

`release.yml` 继续由 main 上含 `[build]` 的提交或手动运行触发。默认 `release_mode=auto`，以当前 `VERSION` 对应 Release 上记录的最后成功发布源码为基线判断改动范围；旧 Release 没有记录时使用原 tag 的提交。未发布的累计改动也纳入判断。

- 只有 Bridge、Nexus 或 `skills/guthon-testing/` 改动时，只重建受影响的组件附件，替换同一个 Release 中的同名附件，不改 `VERSION`、不创建新 tag，不重建 Python、Windows/macOS 应用或安装器。
- Bridge 本地服务由 Nexus 内置，因此服务端改动会同时重打包 Nexus；纯浏览器扩展改动只重打包 Chrome 附件。组件发布同步重建发行清单、完整附件摘要和签名，并在发布前验证保留附件与新附件。
- 签名发行清单从打包的 Nexus 和 Chrome 附件计算构建标识，支持在组件版本相同时识别新构建。首次向仅支持按版本更新的 Nexus 分发该能力时，须提高 Nexus 组件版本。组件安装完成后分别核对实际加载的 Nexus 构建和托管 Chrome 运行回执。
- 后端、运行配置模板、安装器、版本或构建流程等改动仍执行全量构建。文档、Python 测试、组件的 <code>*.test.js</code> 及发布范围判定脚本自身不进入组件附件，仅这些文件变化时不发布；服务目录中的测试变化也不触发 Nexus 重建。当前版本没有已发布 Release 时执行全量构建。
- 手动选择 `release_mode=full` 可强制全量构建。组件替换要求目标 Release 未启用 GitHub 不可变保护、当前发行签名有效且 CI 配有签名私钥；不能验证时停止，不以未签名元数据覆盖已签名发行。

已发布的不可变 Release 无法解除附件保护，必须提升 `VERSION` 后发布新版本；工作流会在构建前拒绝替换，不自动提升版本或修改仓库保护设置。

组件替换保留原发行说明、追加组件更新记录，不改 Release 的 tag 指向或 latest 状态。GitHub 附件逐个替换，客户端在短暂的元数据不一致期间会拒绝校验；上传或说明更新报错时流程尝试恢复原附件和说明。应用和一键安装器仍为原构建，新组件通过单独附件分发。组件更新成功后也会触发独立的 Gitee 镜像任务。遇到同名附件内容冲突时，镜像任务保留原件并报告冲突。

## 私有发行说明与公开材料

维护者在本机 `docs/private/releases/v<版本>.md` 准备提交及发行说明；该目录已被 Git 忽略，源文件不提交。提交备注与 GitHub/Gitee Release 最终正文仍是公开内容，发布前需检查正文，不将凭据或内部地址直接作为发行正文。

自动发行使用提交说明。需要直接使用私有文件中的可公开正文时，先在 `main` 提交并推送对应版本的代码，再从仓库根目录手动触发发行：

```bash
.venv/bin/python - <<'PY'
import json
from pathlib import Path
import subprocess

version = Path("VERSION").read_text().strip()
notes = Path(f"docs/private/releases/v{version}.md").read_text(encoding="utf-8")
if not notes.strip():
    raise SystemExit("发行说明不能为空")
subprocess.run(
    ["gh", "workflow", "run", "release.yml", "--ref", "main", "--json"],
    input=json.dumps({"release_notes": notes}), text=True, check=True,
)
PY
```

命令只将正文传入 `release_notes` 工作流参数，不上传私有文件，不将正文拼接进 shell。触发前确认本机 `VERSION` 与已推送的 main 一致；不要同时触发自动发行和手动发行。

Windows 指南使用的 `docs/windows-install-images/` 配图继续随指南提交和部署。额外原始全过程截图保存在本机 `docs/private/windows-install-originals/`，不提交、不被 Pages 复制。本地开发打包得到的 `*.vsix` 同样只保留在磁盘；正式 VSIX 由 CI 构建并通过 Release 分发。

## 本机准备

从 GuthonCodeTool 工具仓库根目录执行。需要 `gh`、Node.js、`curl` 和 Python；使用仓库 `.venv` 可复用已安装的 `keyring`。GitHub CLI 需能读取对应公开 Release。本机同步器不需要发行签名私钥。

准备具有目标 Gitee 仓库发行与附件写入权限的上传令牌，在本机交互终端输入一次：

```bash
.venv/bin/python scripts/sync_release_to_gitee.py --configure-token
```

输入不回显。macOS 使用系统钥匙串，服务名为 `GuthonCodeTool.ReleaseMirror`，默认账户为 `sidwu/GuthonCodeTool`；不创建令牌文件，不把令牌放进命令参数、Git 或聊天。脚本不接受明文文件凭据后端。使用其他目标仓库时，配置和同步两次命令都需显式提供相同的 `--gitee-repo owner/repository`。

## 本机手动补同步

GitHub 对应版本发布后执行：

```bash
.venv/bin/python scripts/sync_release_to_gitee.py --tag v0.3.3
```

版本必须明确指定。默认来源为 `SidWuu/GuthonCodeTool`，目标为 `sidwu/GuthonCodeTool`。同步器只接受完整的稳定签名发行：0.3.0 为 9 个附件，带三组件清单的 0.3.1 为 10 个附件，含统一安装器的 0.3.2 及后续版本为 12 个附件；不用于旧的未签名版本，不自动选择最新版本或创建 Git 标签。

执行过程：

1. 下载 GitHub 正式附件到临时目录，使用仓库中已固定的公钥验证版本、独立签名和全部附件哈希。
2. 核对 Gitee 目标发行，缺失时以已有同名标签创建发行；更新对应版本说明。
3. 已存在附件先下载核对大小和 SHA-256。内容一致才跳过，内容冲突或重复同名附件则停止。
4. 补传缺失附件。上传超时后先查询远端并下载核验。每个缺失附件最多上传两次。默认 GuthonCodeTool 镜像遇到明确的仓库附件配额错误时，按照下节规则清理旧附件再重试。
5. 所有正式附件逐项下载验证通过、最终集合和发行说明一致后，才报告完成。

连接上限为 8 秒，API 单次请求上限为 30 秒。文件传输按大小设置 90–300 秒上限；持续 30 秒低于 32 KiB/s 会退出当前传输。传输期间每 10 秒显示耗时，结束时显示 HTTP 状态、TLS 时间和平均速度。只读网络请求最多尝试三次；失败会保留已完成的远端附件。

本机同一仓库的同步使用进程锁，退出后自动释放。开始手动补同步前，确认同一目标仓库的自动镜像任务及其他机器上的同步均已结束。

## 旧发行附件保留规则

GitHub Actions 中的镜像任务遇到配额不足时会报告失败并保留旧附件。本机执行默认 GuthonCodeTool 镜像时，只有 Gitee 明确返回仓库附件配额不足才启动自动清理，也可传入 `--no-quota-cleanup` 保留旧附件。清理会保留当前同步目标和 Gitee 最近两个附件齐全的稳定版，在比目标早的稳定发行中，从最早开始选择仍带附件的版本，预计释放量达到本次待补附件的总大小即停止选择。每次同步最多执行一批配额清理。

清理前匹配每个附件的 GitHub 正式发行备份，下载 Gitee 原件并核对大小和 SHA-256。清理调用附件级接口，保留 Gitee Release、Git 标签与 GitHub 附件。按发行版回读清理结果并核对 Git 标签，再继续补传。接口失败或附件不一致时停止，并保留已经处理的结果。

维护者也可以在确认清理边界后，把一次性清理和目标镜像同步放在同一任务中。下例清理早于 `v0.3.0` 的旧附件并补传 `v0.4.0`：

```bash
.venv/bin/python scripts/sync_release_to_gitee.py --tag v0.4.0 --prune-before v0.3.0
```

## 只读验收与失败补传

无需 Gitee 令牌即可执行真实下载验收：

```bash
.venv/bin/python scripts/sync_release_to_gitee.py --tag v0.3.3 --verify-only
```

只读模式不会创建发行、修改说明或补传附件。发现缺失、签名错误、哈希冲突时返回非零退出码，不声称镜像完整。

网络恢复后，重新运行相同的同步命令即可补齐。遇到哈希冲突或重复附件，先核查 GitHub 原始发行、Gitee 下载内容及其他同步进程，再决定人工处理；同步器不会自行删除冲突文件。

## GitHub Actions 自动同步与重试

完整发布或同版本组件替换成功后，`Build Release` 向 `Sync Gitee Release` 传入版本标签与发行来源提交。镜像任务只同步该提交所发布的签名附件，排队串行运行，最长 30 分钟。该工作流使用已有 Secret `SYNCRELEASETOGITEE` 和变量 `GITEE_OWNER`、`GITEE_REPO`。

在 Actions 的 `Sync Gitee Release` 查看镜像任务摘要和失败步骤。同步或回验失败时，可重跑镜像任务，或手动运行同一工作流并填写原版本标签。触发请求失败时，`Build Release` 摘要会提供镜像工作流入口。使用已有的 GitHub 发行附件重试即可。

维护者脚本也支持 `--release-dir` 与 `--notes-file` 指向已下载的对应正式附件及说明。输入会复制到独立临时快照后验签；附件目录必须只包含完整的 9、10 或 12 个正式签名文件，拒绝符号链接、额外文件及超大文件。
