#!/usr/bin/env bash
# v4 的 DSH 配置在仓库与 $DSH_HOME 之间同步。
#
#   ./sync-config.sh pull    # $DSH_HOME → 仓库（本机路径换回占位符）
#   ./sync-config.sh push    # 仓库 → $DSH_HOME（占位符换成本机路径）
#
# 管两样东西，它们都决定 agent 的行为：
#   profiles/photo-v4*                 五个 profile（含 headless 的 persona）
#   dsh-v4/preset-photo-filter-v4/     web 版的 persona
#   dsh-v4/anchors-default.json        范例锚点（提示词原话 + 组内照片名）
#
# 为什么需要它：
# ① 五个 profile 里只有三个曾经进过仓库，而且是**手工 cp 的副本**，
#    其中 photo-v4-ab 那份还带着本机绝对路径推到了公开仓库。
#    另外两个（eval / eval-web）仓库里根本没有 —— 整轮 AB 实验无法从克隆复现。
# ② 手工 cp 必然漂移：README 里那段 `cp -R` + `sed` 就是漂移的来源。
#
# 占位符词汇以 dsh-v4/README.md 的表为准，doctor.sh 第 3 项也用同一套。
# 别再发明第二套。
#
# 凭据不归这个脚本管，也不该进仓库：它在 $DSH_HOME/.credentials.yaml。
# 每次 pull 都重新核对一遍，发现疑似密钥就中止。
#
# macOS 自带 bash 3.2；紧跟非 ASCII 文本的变量一律用 ${} 界定。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh-v4}"
CACHE="${CACHE:-$HOME/.cache/photofilter-rank}"
EXPORT_ROOT="${EXPORT_ROOT:-$HOME/Downloads}"
PHOTOS="${PHOTOS:-$HOME/Desktop/照片测试}"
# 考题、结果这些跑起来才有的中间文件。只有 eval / ab 系 profile 引用。
SCRATCH="${SCRATCH:-/tmp/claude-501}"

PROFILES="photo-v4 photo-v4-ab photo-v4-eval photo-v4-eval-web photo-v4-headless"
PROFILE_FILES="package.json cordis.yml cordis.patch.yml pnpm-workspace.yaml"
PRESET_SRC="${ROOT}/dsh-v4/preset-photo-filter-v4"
PRESET_DST="${DSH_HOME}/.agent-presets/photo-filter-v4"
PRESET_FILES="preset.yml agent.cordis.yml"
# 锚点也走同一套装配。以前它由 profile 用绝对路径直接读仓库那份，
# 于是 folder 字段必须写成本机路径 —— 一个私人目录就这么留在了公开仓库里。
ANCHORS_SRC="${ROOT}/dsh-v4/anchors-default.json"
ANCHORS_DST="${DSH_HOME}/anchors.json"

# **顺序有意义**：长的先替。$HOME 若先替，@@REPO@@ 和 @@CACHE@@ 就再也匹配不上。
subs_pull() {
  LC_ALL=C sed \
    -e "s|${ROOT}|@@REPO@@|g" \
    -e "s|${DSH_HOME}|@@DSH_HOME@@|g" \
    -e "s|${CACHE}|@@CACHE@@|g" \
    -e "s|${PHOTOS}|@@PHOTOS@@|g" \
    -e "s|${SCRATCH}|@@SCRATCH@@|g" \
    -e "s|${EXPORT_ROOT}|@@EXPORT@@|g"
}
subs_push() {
  LC_ALL=C sed \
    -e "s|@@REPO@@|${ROOT}|g" \
    -e "s|@@DSH_HOME@@|${DSH_HOME}|g" \
    -e "s|@@CACHE@@|${CACHE}|g" \
    -e "s|@@PHOTOS@@|${PHOTOS}|g" \
    -e "s|@@SCRATCH@@|${SCRATCH}|g" \
    -e "s|@@EXPORT@@|${EXPORT_ROOT}|g"
}

die() { printf '\n\033[31m✖ %s\033[0m\n' "$1" >&2; exit 1; }

case "${1:-}" in
pull)
  for p in ${PROFILES}; do
    src="${DSH_HOME}/profiles/${p}"
    [[ -d "${src}" ]] || { printf '  跳过 %s（$DSH_HOME 里没有）\n' "${p}"; continue; }
    mkdir -p "${ROOT}/profiles/${p}"
    for f in ${PROFILE_FILES}; do
      [[ -f "${src}/${f}" ]] || continue
      subs_pull < "${src}/${f}" > "${ROOT}/profiles/${p}/${f}"
    done
    printf '  ← profile %s\n' "${p}"
  done
  for f in ${PRESET_FILES}; do
    [[ -f "${PRESET_DST}/${f}" ]] || continue
    mkdir -p "${PRESET_SRC}"
    subs_pull < "${PRESET_DST}/${f}" > "${PRESET_SRC}/${f}"
    printf '  ← preset  %s\n' "${f}"
  done
  if [[ -f "${ANCHORS_DST}" ]]; then
    subs_pull < "${ANCHORS_DST}" > "${ANCHORS_SRC}"
    printf '  ← anchors\n'
  fi
  # 凭据自检：profile / preset 本来就不该带凭据。
  if grep -rniE 'api[_-]?key *:|secret *:|(^|[^A-Za-z])sk-[A-Za-z0-9]{16}|eyJ[A-Za-z0-9_-]{20}' \
       "${ROOT}"/profiles/photo-v4*/ "${PRESET_SRC}" "${ANCHORS_SRC}" >/dev/null 2>&1; then
    die "配置里出现疑似凭据，已中止。凭据只放在 ${DSH_HOME}/.credentials.yaml"
  fi
  # 占位符自检：漏网就等于把本机绝对路径提交进公开仓库。
  if LC_ALL=C grep -rn "${HOME}" "${ROOT}"/profiles/photo-v4*/ "${PRESET_SRC}" "${ANCHORS_SRC}" >/dev/null 2>&1; then
    LC_ALL=C grep -rn "${HOME}" "${ROOT}"/profiles/photo-v4*/ "${PRESET_SRC}" "${ANCHORS_SRC}" >&2
    die "还有没换成占位符的本机路径，已中止"
  fi
  printf '\n已同步进仓库\n'
  ;;
push)
  for p in ${PROFILES}; do
    src="${ROOT}/profiles/${p}"
    [[ -d "${src}" ]] || { printf '  跳过 %s（仓库里没有）\n' "${p}"; continue; }
    mkdir -p "${DSH_HOME}/profiles/${p}"
    for f in ${PROFILE_FILES}; do
      [[ -f "${src}/${f}" ]] || continue
      subs_push < "${src}/${f}" > "${DSH_HOME}/profiles/${p}/${f}"
    done
    printf '  → profile %s\n' "${p}"
  done
  mkdir -p "${PRESET_DST}"
  for f in ${PRESET_FILES}; do
    [[ -f "${PRESET_SRC}/${f}" ]] || continue
    subs_push < "${PRESET_SRC}/${f}" > "${PRESET_DST}/${f}"
    printf '  → preset  %s\n' "${f}"
  done
  if [[ -f "${ANCHORS_SRC}" ]]; then
    subs_push < "${ANCHORS_SRC}" > "${ANCHORS_DST}"
    printf '  → anchors\n'
  fi
  # 插件按包名解析，软链进 harness 维护的扁平模块层。
  mkdir -p "${DSH_HOME}/profiles/node_modules/@photo-filter-agent"
  ln -sfn "${ROOT}/agent-v4" \
     "${DSH_HOME}/profiles/node_modules/@photo-filter-agent/dsh-photo-filter-v4"
  printf '\n已装配到：%s\n' "${DSH_HOME}"
  ;;
*)
  die "用法：$0 pull|push"
  ;;
esac
