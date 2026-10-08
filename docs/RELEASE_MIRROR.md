# 维护者发行与 Gitee 镜像同步

GitHub Actions 构建、签名并发布 GitHub Release 后结束发行任务。Gitee 镜像由维护者本机单独同步，失败不需要重新构建，也不修改已发布的附件。普通同事仍按 Nexus 中所选的 GitHub/Gitee 更新源使用工具。

## 私有发行说明与公开材料

维护者在本机 `docs/private/releases/v<版本>.md` 准备提交及发行说明；该目录已被 Git 忽略，源文件不提交。提交备注与 GitHub/Gitee Release 最终正文仍是公开内容，发布前需检查正文，不将凭据或内部地址直接作为发行正文。

自动发行使用提交说明。需要直接使用私有文件中的可公开正文时，先提交并推送对应版本的代码，再从仓库根目录手动触发发行：

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

## 一条命令同步

GitHub 对应版本发布后执行：

```bash
.venv/bin/python scripts/sync_release_to_gitee.py --tag v0.3.1
```

版本必须明确指定。默认来源为 `SidWuu/GuthonCodeTool`，目标为 `sidwu/GuthonCodeTool`。同步器只接受完整的稳定签名发行：0.3.0 为 9 个附件，带三组件清单的 0.3.1 为 10 个附件，含统一安装器的 0.3.2 为 12 个附件；不用于旧的未签名版本，不自动选择最新版本或创建 Git 标签。

执行过程：

1. 下载 GitHub 正式附件到临时目录，使用仓库中已固定的公钥验证版本、独立签名和全部附件哈希。
2. 核对 Gitee 目标发行，缺失时以已有同名标签创建发行；更新对应版本说明。
3. 已存在附件先下载核对大小和 SHA-256。内容一致才跳过，内容冲突或重复同名附件则停止，不删除或覆盖远端文件。
4. 补传缺失附件。上传超时后先查询远端并下载核验，不因响应丢失盲目重复上传。每个缺失附件最多上传两次。
5. 所有正式附件逐项下载验证通过、最终集合和发行说明一致后，才报告完成。

连接上限为 8 秒，API 单次请求上限为 30 秒。文件传输按大小设置 90–300 秒上限；持续 30 秒低于 32 KiB/s 会退出当前传输。传输期间每 10 秒显示耗时，结束时显示 HTTP 状态、TLS 时间和平均速度。只读网络请求最多尝试三次；失败会保留已完成的远端附件。

本机同一仓库的同步使用进程锁。系统在进程退出后释放锁，锁文件保留以避免并发绕过；无需删除锁文件。不要同时从另一台机器或备用 CI 同步同一仓库。

## 只读验收与失败补传

无需 Gitee 令牌即可执行真实下载验收：

```bash
.venv/bin/python scripts/sync_release_to_gitee.py --tag v0.3.1 --verify-only
```

只读模式不会创建发行、修改说明或补传附件。发现缺失、签名错误、哈希冲突时返回非零退出码，不声称镜像完整。

网络恢复后，重新运行相同的同步命令即可补齐。遇到哈希冲突或重复附件，先核查 GitHub 原始发行、Gitee 下载内容及其他同步进程，再决定人工处理；同步器不会自行删除冲突文件。

## 备用 GitHub Actions 同步

本机不可用时可手动运行 `Sync Gitee Release`，填入同一发行标签。该工作流与本机使用同一个同步器，不重新构建；使用已有 Secret `SYNCRELEASETOGITEE` 和变量 `GITEE_OWNER`、`GITEE_REPO`。任务串行调度，最长运行 30 分钟。

备用任务仍经过 GitHub 托管节点到 Gitee 的链路，可能较慢。它与 GitHub 发行构建分开，失败只影响镜像状态。日常优先使用已经验证过的本机链路；本机上传 API 的实际速度以首次上传日志为准，不根据浏览器上传速度作保证。

维护者脚本也支持 `--release-dir` 与 `--notes-file` 指向已下载的对应正式附件及说明。输入会复制到独立临时快照后验签；附件目录必须只包含完整的 9、10 或 12 个正式签名文件，拒绝符号链接、额外文件及超大文件。
