#!/usr/bin/env bash
#
# 把发行目录中的全部附件同步到指定 tag 的 Gitee Release，可重复执行。
# 已存在的同名附件跳过，缺失的附件在轮次内补齐，最后一次附件集合校验不通过就失败。
# Gitee Release 不存在时先创建，正文取自 RELEASE_NOTES_FILE。
#
# 必需环境变量：
#   GITEE_TOKEN    Gitee 私有令牌（Actions 中对应 Secret SYNCRELEASETOGITEE）
#   GITEE_OWNER    Gitee 用户名或组织名
#   GITEE_REPO     Gitee 仓库名
#   RELEASE_TAG    发行标签，例如 v0.2.7
# 可选环境变量：
#   ASSET_DIR             附件所在目录，默认 release
#   RELEASE_NOTES_FILE    发布说明文件，默认 release-notes.md
#   TARGET_COMMITISH      Gitee Release 缺失时用于创建的目标分支或标签，默认 main
set -euo pipefail

for name in GITEE_TOKEN GITEE_OWNER GITEE_REPO RELEASE_TAG; do
  if [ -z "${!name:-}" ]; then
    echo "错误：缺少环境变量 $name" >&2
    exit 1
  fi
done

ASSET_DIR="${ASSET_DIR:-release}"
NOTES_FILE="${RELEASE_NOTES_FILE:-release-notes.md}"
TARGET_COMMITISH="${TARGET_COMMITISH:-main}"
RELEASE_NAME="GuthonCodeTool $RELEASE_TAG"
MAX_ROUNDS=3
API="https://gitee.com/api/v5/repos/$GITEE_OWNER/$GITEE_REPO"

# Gitee 上传偶发 SSL 连接超时（curl 退出码 28）：连接阶段快速失败并整体重试。
CURL_RETRY=(
  --http1.1
  --retry 4
  --retry-delay 15
  --retry-all-errors
  --retry-connrefused
  --connect-timeout 30
  --max-time 1800
)

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

shopt -s nullglob
ASSETS=("$ASSET_DIR"/*)
shopt -u nullglob
if [ "${#ASSETS[@]}" -eq 0 ]; then
  echo "错误：$ASSET_DIR 中没有可同步的附件" >&2
  exit 1
fi

RELEASE_JSON="$WORK_DIR/release.json"
PRESENT_NAMES=""

# 读取 Gitee Release，写入 RELEASE_JSON。Release 不存在时返回 4，其余错误返回 1。
fetch_release() {
  local http_code
  http_code=$(curl --silent --show-error "${CURL_RETRY[@]}" \
    -o "$RELEASE_JSON" -w '%{http_code}' \
    "$API/releases/tags/$RELEASE_TAG") || return 1
  case "$http_code" in
    200)
      # Gitee also returns HTTP 200 with JSON null for an absent tag.
      if jq -e '. == null' "$RELEASE_JSON" > /dev/null; then
        return 4
      fi
      if jq -e 'type == "object" and (.id | type == "number")' "$RELEASE_JSON" > /dev/null; then
        return 0
      fi
      echo "错误：Gitee Release 响应缺少有效发行 ID（HTTP 200）" >&2
      return 1
      ;;
    404) return 4 ;;
    *)
      echo "错误：读取 Gitee Release 失败（HTTP ${http_code}）" >&2
      sed -n '1,20p' "$RELEASE_JSON" >&2
      return 1
      ;;
  esac
}

create_release() {
  local args=(
    -X POST
    -F "access_token=$GITEE_TOKEN"
    -F "tag_name=$RELEASE_TAG"
    -F "target_commitish=$TARGET_COMMITISH"
    -F "name=$RELEASE_NAME"
  )
  if [ -f "$NOTES_FILE" ]; then
    args+=(-F "body=<$NOTES_FILE")
  fi
  curl --fail-with-body --silent --show-error "${CURL_RETRY[@]}" "${args[@]}" "$API/releases"
}

# 刷新 Release 状态，供附件跳过判断和最终校验使用。
refresh_present() {
  if ! fetch_release; then
    echo "错误：无法读取 Gitee Release $RELEASE_TAG" >&2
    exit 1
  fi
  RELEASE_ID=$(jq -er '.id' "$RELEASE_JSON")
  PRESENT_NAMES=$(jq -r '.assets[]?.name' "$RELEASE_JSON" | LC_ALL=C sort)
}

asset_present() {
  grep -Fxq -- "$1" <<< "$PRESENT_NAMES"
}

upload_asset() {
  local path="$1" name size
  name=$(basename "$path")
  size=$(wc -c < "$path" | tr -d '[:space:]')
  echo "开始上传 ${name}（${size} 字节）"
  if curl --fail-with-body --silent --show-error "${CURL_RETRY[@]}" \
    --speed-limit 1024 --speed-time 60 \
    -X POST \
    -F "access_token=$GITEE_TOKEN" \
    -F "file=@$path" \
    "$API/releases/$RELEASE_ID/attach_files" > "$WORK_DIR/upload.json"; then
    echo "已上传 ${name}（${size} 字节）"
    return 0
  fi
  echo "上传失败 ${name}（${size} 字节）" >&2
  sed -n '1,20p' "$WORK_DIR/upload.json" >&2
  return 1
}

echo "同步 ${RELEASE_TAG} 到 Gitee（${GITEE_OWNER}/${GITEE_REPO}），本地附件 ${#ASSETS[@]} 个"

if fetch_release; then
  refresh_present
  echo "Gitee Release 已存在（id=${RELEASE_ID}），仅补齐缺失附件"
else
  fetch_status=$?
  if [ "$fetch_status" -ne 4 ]; then
    exit "$fetch_status"
  fi
  echo "Gitee Release 不存在，按 ${RELEASE_TAG} 创建"
  create_release > "$WORK_DIR/create.json"
  jq -er '.id' "$WORK_DIR/create.json" > /dev/null
  refresh_present
  echo "已创建 Gitee Release（id=${RELEASE_ID}）"
fi

if [ -s "$NOTES_FILE" ]; then
  curl --fail-with-body --silent --show-error "${CURL_RETRY[@]}" \
    -X PATCH \
    --data-urlencode "access_token=$GITEE_TOKEN" \
    --data-urlencode "tag_name=$RELEASE_TAG" \
    --data-urlencode "name=$(jq -er '.name' "$RELEASE_JSON")" \
    --data-urlencode "prerelease=$(jq -r '.prerelease == true' "$RELEASE_JSON")" \
    --data-urlencode "body@$NOTES_FILE" \
    "$API/releases/$RELEASE_ID" > "$WORK_DIR/update.json"
  jq -e --argjson expected "$RELEASE_ID" '.id == $expected' "$WORK_DIR/update.json" > /dev/null
  echo "已同步 Gitee 发行说明"
fi

for round in $(seq 1 "$MAX_ROUNDS"); do
  refresh_present
  pending=()
  for path in "${ASSETS[@]}"; do
    asset_present "$(basename "$path")" || pending+=("$path")
  done
  if [ "${#pending[@]}" -eq 0 ]; then
    break
  fi

  echo "第 $round/$MAX_ROUNDS 轮：待补齐 ${#pending[@]} 个附件"
  failed=0
  for path in "${pending[@]}"; do
    upload_asset "$path" || failed=1
  done
  if [ "$failed" -ne 0 ] && [ "$round" -lt "$MAX_ROUNDS" ]; then
    echo "本轮存在失败附件，20 秒后重试"
    sleep 20
  fi
done

refresh_present
missing=()
for path in "${ASSETS[@]}"; do
  name=$(basename "$path")
  asset_present "$name" || missing+=("$name")
done
if [ "${#missing[@]}" -gt 0 ]; then
  echo "错误：Gitee Release $RELEASE_TAG 仍缺少附件：${missing[*]}" >&2
  echo "已存在的附件：" >&2
  sed 's/^/  /' <<< "$PRESENT_NAMES" >&2
  exit 1
fi

extras=()
while IFS= read -r name; do
  [ -n "$name" ] || continue
  extra=1
  for path in "${ASSETS[@]}"; do
    if [ "$(basename "$path")" = "$name" ]; then
      extra=0
      break
    fi
  done
  if [ "$extra" -eq 1 ]; then
    extras+=("$name")
  fi
done <<< "$PRESENT_NAMES"
if [ "${#extras[@]}" -gt 0 ]; then
  echo "提示：Gitee 上存在本次附件之外的额外文件：${extras[*]}"
fi

echo "Gitee Release ${RELEASE_TAG} 已包含全部 ${#ASSETS[@]} 个附件："
for path in "${ASSETS[@]}"; do
  echo "  $(basename "$path")"
done
