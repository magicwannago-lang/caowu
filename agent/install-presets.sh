#!/usr/bin/env bash
# 把仓库里的 DSH preset 同步到本机 dshHome。
# 用法：
#   bash agent/install-presets.sh                # 默认 dshHome = ~/.dsh
#   DSH_HOME=/path/to/dsh bash agent/install-presets.sh
set -euo pipefail

PRESET_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DST_ROOT="${DSH_HOME:-$HOME/.dsh}/.agent-presets"

count=0
for src in "$PRESET_DIR"/*/; do
  [ -f "${src}agent.cordis.yml" ] || continue
  name="$(basename "$src")"
  dst="$DST_ROOT/$name"

  mkdir -p "$dst"
  # 只同步 preset 运行所需文件，不带笔记与 git 杂物
  cp -f "$src/agent.cordis.yml" "$dst/"
  [ -f "$src/preset.yml" ]       && cp -f "$src/preset.yml" "$dst/"
  [ -f "$src/system_prompt.md" ] && cp -f "$src/system_prompt.md" "$dst/"

  echo "已同步：$name → $dst"
  count=$((count + 1))
done

[ "$count" -gt 0 ] || { echo "未发现含 agent.cordis.yml 的 preset 目录"; exit 1; }
echo "完成，共 $count 个 preset。新建 DSH 会话即可选用；已在会话中需重启会话生效。"
