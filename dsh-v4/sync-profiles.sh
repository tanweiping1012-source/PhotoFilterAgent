#!/usr/bin/env bash
# v4 的 profile 在仓库与 $DSH_HOME 之间同步。
#
#   ./sync-profiles.sh pull    # $DSH_HOME → 仓库（把本机路径换回占位符）
#   ./sync-profiles.sh push    # 仓库 → $DSH_HOME（把占位符换成本机路径）
#
# 为什么需要这个脚本：
# 五个 v4 profile 一直只存在于 $DSH_HOME 里，仓库里一份都没有 —— install.sh
# 只装配 v3 的 photo / photo-web。后果是**整轮 AB 实验无法从仓库复现**：
# 判据文件路径、allowNeither、两道图片上限、persona 全在那些 patch 里。
# 手工来回复制迟早再次漂移，所以做成脚本，双向都走同一张占位符表。
#
# profile 里没有密钥（凭据在 $DSH_HOME/.credentials.yaml，那个文件不进仓库）。
# 每次 pull 都会重新核对一遍，发现疑似密钥就中止。
#
# macOS 自带 bash 3.2；紧跟非 ASCII 文本的变量一律用 ${} 界定。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh-v4}"
# 考题、结果这些跑起来才有的中间文件放哪儿。默认跟实验脚本一致。
SCRATCH="${SCRATCH:-/tmp/claude-501}"
# 评测用的照片根目录。只有 eval 系 profile 引用它。
PHOTOS="${PHOTOS:-$HOME/Desktop/照片测试}"

PROFILES="photo-v4 photo-v4-ab photo-v4-eval photo-v4-eval-web photo-v4-headless"
FILES="package.json cordis.yml cordis.patch.yml pnpm-workspace.yaml"

# 占位符表。**顺序有意义**：长的先替，否则 @@HOME@@ 会先把
# /Users/x/deepseek-harness/... 的前缀吃掉，PHOTO_FILTER_HOME 就再也匹配不上。
subs_pull() {
  LC_ALL=C sed \
    -e "s|${ROOT}|@@PHOTO_FILTER_HOME@@|g" \
    -e "s|${DSH_HOME}|@@DSH_HOME@@|g" \
    -e "s|${PHOTOS}|@@PHOTOS@@|g" \
    -e "s|${SCRATCH}|@@SCRATCH@@|g" \
    -e "s|${HOME}|@@HOME@@|g"
}
subs_push() {
  LC_ALL=C sed \
    -e "s|@@PHOTO_FILTER_HOME@@|${ROOT}|g" \
    -e "s|@@DSH_HOME@@|${DSH_HOME}|g" \
    -e "s|@@PHOTOS@@|${PHOTOS}|g" \
    -e "s|@@SCRATCH@@|${SCRATCH}|g" \
    -e "s|@@HOME@@|${HOME}|g"
}

die() { printf '\n\033[31m✖ %s\033[0m\n' "$1" >&2; exit 1; }

case "${1:-}" in
pull)
  for p in ${PROFILES}; do
    src="${DSH_HOME}/profiles/${p}"
    [[ -d "${src}" ]] || { printf '  跳过 %s（$DSH_HOME 里没有）\n' "${p}"; continue; }
    mkdir -p "${ROOT}/profiles/${p}"
    for f in ${FILES}; do
      [[ -f "${src}/${f}" ]] || continue
      subs_pull < "${src}/${f}" > "${ROOT}/profiles/${p}/${f}"
    done
    printf '  ← %s\n' "${p}"
  done
  # 密钥自检：profile 本来就不该带凭据，带了说明有人手改错了地方。
  if grep -rniE 'api[_-]?key *:|secret *:|(^|[^A-Za-z])sk-[A-Za-z0-9]{16}|eyJ[A-Za-z0-9_-]{20}' \
       "${ROOT}"/profiles/photo-v4*/ >/dev/null 2>&1; then
    grep -rniE 'api[_-]?key *:|secret *:|(^|[^A-Za-z])sk-[A-Za-z0-9]{16}|eyJ[A-Za-z0-9_-]{20}' \
      "${ROOT}"/profiles/photo-v4*/ >&2
    die "profile 里出现疑似凭据，已中止。凭据只应放在 ${DSH_HOME}/.credentials.yaml"
  fi
  # 占位符自检：本机路径漏网就等于把绝对路径提交进公开仓库。
  if LC_ALL=C grep -rn "${HOME}" "${ROOT}"/profiles/photo-v4*/ >/dev/null 2>&1; then
    LC_ALL=C grep -rn "${HOME}" "${ROOT}"/profiles/photo-v4*/ >&2
    die "还有没换成占位符的本机路径，已中止"
  fi
  printf '\n已同步进仓库：%s/profiles/\n' "${ROOT}"
  ;;
push)
  for p in ${PROFILES}; do
    src="${ROOT}/profiles/${p}"
    [[ -d "${src}" ]] || { printf '  跳过 %s（仓库里没有）\n' "${p}"; continue; }
    mkdir -p "${DSH_HOME}/profiles/${p}"
    for f in ${FILES}; do
      [[ -f "${src}/${f}" ]] || continue
      subs_push < "${src}/${f}" > "${DSH_HOME}/profiles/${p}/${f}"
    done
    printf '  → %s\n' "${p}"
  done
  mkdir -p "${DSH_HOME}/profiles/node_modules/@photo-filter-agent"
  ln -sfn "${ROOT}/agent-v4" \
     "${DSH_HOME}/profiles/node_modules/@photo-filter-agent/dsh-photo-filter-v4"
  printf '\n已装配到：%s/profiles/\n' "${DSH_HOME}"
  ;;
*)
  die "用法：$0 pull|push"
  ;;
esac
