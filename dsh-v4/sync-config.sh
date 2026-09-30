#!/usr/bin/env bash
# v4 的 DSH 配置在仓库与 $DSH_HOME 之间同步。
#
#   ./sync-config.sh pull    # $DSH_HOME → 仓库（本机路径换回占位符）
#   ./sync-config.sh push    # 仓库 → $DSH_HOME（占位符换成本机路径）
#
# 管两样东西，它们都决定 agent 的行为：
#   profiles/photo-v4/                 web 界面用的 profile（DSH 0.2 起 preset 也写在它里面）
#   profiles/photo-v4-headless/        命令行一次性任务用的 profile
#   dsh-v4/anchors-default.json        范例锚点（提示词原话 + 组内照片名；只在本机有那些照片时才装）
#
# 插件以 profile 依赖的方式装进去（package.json 里的 link:@@REPO@@/agent-v4，push 后跑 pnpm install），
# 这样插件引用的 @deepseek-ai/* 由 DSH 自己提供。DSH 0.2 不再给手工软链进来的插件解析这些包。
# 仓库里另外三个 profile（photo-v4-ab / -eval / -eval-web）是 DSH 0.1 时期做实验用的，
# 默认不装；要装就 PROFILES="…" 显式点名，但它们没有迁到 0.2。
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
DSH_HOME="${DSH_HOME:-$HOME/.dsh-photo-filter}"
CACHE="${CACHE:-$HOME/.cache/photofilter-rank}"
EXPORT_ROOT="${EXPORT_ROOT:-$HOME/Downloads}"
# 照片根目录没有通用默认值：猜错了，push 会把 agent 的授权目录装成一个不存在的地方，
# pull 会把真实路径原样写进公开仓库。所以必须显式给，与 install.sh 时用的相同。
PHOTOS="${PHOTOS:-}"
# 考题、结果这些跑起来才有的中间文件。只有 eval / ab 系 profile 引用。
SCRATCH="${SCRATCH:-/tmp/claude-501}"

PROFILES="${PROFILES:-photo-v4 photo-v4-headless}"
PROFILE_FILES="package.json cordis.yml cordis.patch.yml pnpm-workspace.yaml"
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

[[ -n "${PHOTOS}" ]] || die "请用 PHOTOS 指明照片根目录（与 install.sh 时用的相同）：PHOTOS=~/Pictures/我的旅行照片 $0 ${1:-push}"

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
  if [[ -f "${ANCHORS_DST}" ]]; then
    subs_pull < "${ANCHORS_DST}" > "${ANCHORS_SRC}"
    printf '  ← anchors\n'
  fi
  # 凭据自检：profile / preset 本来就不该带凭据。
  if grep -rniE 'api[_-]?key *:|secret *:|(^|[^A-Za-z])sk-[A-Za-z0-9]{16}|eyJ[A-Za-z0-9_-]{20}' \
       "${ROOT}"/profiles/photo-v4*/ "${ANCHORS_SRC}" >/dev/null 2>&1; then
    die "配置里出现疑似凭据，已中止。凭据只放在 ${DSH_HOME}/.credentials.yaml"
  fi
  # 占位符自检：漏网就等于把本机绝对路径提交进公开仓库。
  if LC_ALL=C grep -rn "${HOME}" "${ROOT}"/profiles/photo-v4*/ "${ANCHORS_SRC}" >/dev/null 2>&1; then
    LC_ALL=C grep -rn "${HOME}" "${ROOT}"/profiles/photo-v4*/ "${ANCHORS_SRC}" >&2
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
  # 锚点是作者本人的范例照片，别的机器上没有：装上去阶段 2 会在付费调用之前失败
  # （判据与两种失败形态见 check_anchors.py）。所以逐张核齐了才装；
  # 不齐时把以前 push 装过的那份改名停用（不删），否则它会一直留着、照样坏。
  # 核对**自己**失败（退出码既不是 0 也不是 3）时锚点一律不动：那不是「不齐」，
  # 当成不齐就会停用作者本机好好的锚点。其余照常装完，最后再以失败退出。
  anchors_check_failed=""
  if [[ -f "${ANCHORS_SRC}" ]]; then
    anchors_tmp="$(mktemp)"
    subs_push < "${ANCHORS_SRC}" > "${anchors_tmp}"
    anchors_rc=0
    anchors_miss="$(python3 "${ROOT}/dsh-v4/check_anchors.py" "${anchors_tmp}")" || anchors_rc=$?
    case "${anchors_rc}" in
      0)
        cat "${anchors_tmp}" > "${ANCHORS_DST}"
        printf '  → anchors\n'
        ;;
      3)
        if [[ -f "${ANCHORS_DST}" ]]; then
          mv "${ANCHORS_DST}" "${ANCHORS_DST}.disabled"
          printf '  ⚠ anchors 本机不齐（缺 %s），已把之前装的改名为 anchors.json.disabled\n' "${anchors_miss}"
        else
          printf '  · anchors 不装：作者的范例照片本机不齐（缺 %s）。阶段 2 不带范例照常跑\n' "${anchors_miss}"
        fi
        ;;
      *)
        anchors_check_failed="${anchors_rc}"
        printf '  ✖ 锚点核对自己失败了（退出码 %s），已装的锚点没有改动\n' "${anchors_rc}"
        ;;
    esac
    rm -f "${anchors_tmp}"
  fi
  # 插件是 profile 的 link: 依赖：在每个 profile 目录里让 pnpm 建好它（本地链接，不联网）。
  # pnpm-workspace.yaml 关掉了自动装 peer 依赖，所以 @deepseek-ai/* 不会被装第二份，由 DSH 提供。
  for p in ${PROFILES}; do
    [[ -d "${DSH_HOME}/profiles/${p}" ]] || continue
    (cd "${DSH_HOME}/profiles/${p}" && pnpm install --silent) \
      || die "profile ${p} 里 pnpm install 失败"
    printf '  → 插件已链接进 %s\n' "${p}"
  done
  # 旧版（DSH 0.1）装在这里的插件软链，DSH 0.2 不再读取；留着只会让人以为它在起作用。
  rm -f "${DSH_HOME}/profiles/node_modules/@photo-filter-agent/dsh-photo-filter-v4"
  printf '\n已装配到：%s\n' "${DSH_HOME}"
  [[ -z "${anchors_check_failed}" ]] || die "锚点核对自己失败了（退出码 ${anchors_check_failed}）—— 其余已装好，锚点没动；修好后重跑 push"
  ;;
*)
  die "用法：$0 pull|push"
  ;;
esac
