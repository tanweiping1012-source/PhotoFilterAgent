#!/usr/bin/env bash
# 从零把照片筛选 agent 装起来。
#
#   ./install.sh [harness 目录]
#
# 默认把 DeepSeek Harness 装在本仓库的上一级；已经有了就复用，不重复克隆。
# 脚本是幂等的：重复执行只会补齐缺的部分。
#
# macOS 自带 bash 3.2，所有紧跟非 ASCII 文本的变量必须用 ${} 显式界定，
# 否则中文标点的首字节会被当成变量名的一部分。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS="${1:-$(dirname "${ROOT}")}"
HARNESS="$(cd "${HARNESS}" 2>/dev/null && pwd || echo "${HARNESS}")"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"

# 本仓库开发与验证时所对应的 harness 版本。它是 v0.1 developer preview，
# 官方明确会有破坏性变更；换版本出问题先回到这个锚点。
HARNESS_PIN="dsh-v0.1.1-rc.2"
HARNESS_REPO="https://github.com/deepseek-ai/deepseek-harness.git"

say() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }
ok()  { printf '  ✅ %s\n' "$1"; }
warn(){ printf '  ⚠️  %s\n' "$1"; }
die() { printf '\n\033[31m✖ %s\033[0m\n' "$1" >&2; exit 1; }

# ── 1. 前置工具 ────────────────────────────────────────────────
say "检查前置工具"
command -v swift >/dev/null || die "缺少 Swift（装 Xcode 命令行工具：xcode-select --install）"
command -v node  >/dev/null || die "缺少 Node.js（需要 ^22.19 或 >=24）"
command -v pnpm  >/dev/null || die "缺少 pnpm（npm install -g pnpm）"
command -v git   >/dev/null || die "缺少 git"
ok "swift $(swift --version 2>&1 | head -1 | sed 's/.*version //;s/ .*//')  ·  node $(node --version)  ·  pnpm $(pnpm --version)"

case "$(uname -s)" in
  Darwin) ;;
  *) die "只支持 macOS：人物/风景分类走 Apple Vision，图像解码走 ImageIO" ;;
esac

# ── 2. DeepSeek Harness ────────────────────────────────────────
say "准备 DeepSeek Harness"
if [[ -d "${HARNESS}/.git" ]] && [[ -f "${HARNESS}/apps/cli/src/bin.ts" ]]; then
  ok "已存在：${HARNESS}"
else
  [[ -e "${HARNESS}" ]] && die "${HARNESS} 已存在但不像 harness 仓库，请换个目录或先移走"
  echo "  克隆到 ${HARNESS} …"
  git clone --depth 1 "${HARNESS_REPO}" "${HARNESS}"
  ok "已克隆（本仓库验证于 ${HARNESS_PIN}）"
fi

if [[ ! -d "${HARNESS}/node_modules" ]]; then
  echo "  安装依赖 …"
  (cd "${HARNESS}" && pnpm install)
fi
if [[ ! -d "${HARNESS}/apps/cli/lib" ]]; then
  echo "  构建（几分钟）…"
  (cd "${HARNESS}" && pnpm run build)
fi
ok "harness 就绪"

# ── 3. Swift 分析引擎 ──────────────────────────────────────────
say "构建本地分析引擎"
ENGINE="${ROOT}/engine/.build/release/photofilter"
if [[ -x "${ENGINE}" ]]; then
  ok "已构建：${ENGINE}"
else
  (cd "${ROOT}/engine" && swift build -c release)
  [[ -x "${ENGINE}" ]] || die "构建完成但找不到可执行文件"
  ok "已构建"
fi

# ── 3b. v4 的 Python 排序环境 ──────────────────────────────────
# v4 的排序跑在 Python 里（CLIP embedding + 两个质量模型），五个 v4 profile
# 的 python 项都指向 $DSH_V4_HOME/ranker-venv。此前 install.sh 不建这个 venv，
# 全新克隆装完之后 profile 指着一个不存在的解释器 —— 仓库里有 profile 也跑不起来。
#
# photofilter_rank 本身**不装进 venv**：插件用 cwd + PYTHONPATH 指向
# ${ROOT}/ranker 从源码树导入（见 agent-v4/src/ranker.ts）。这里只装依赖。
say "准备 v4 的 Python 环境"
V4_HOME="${DSH_V4_HOME:-$HOME/.dsh-v4}"
VENV="${V4_HOME}/ranker-venv"
if "${VENV}/bin/python" -c "import numpy, PIL, torch, pyiqa, clip" >/dev/null 2>&1; then
  ok "已就绪：${VENV}"
else
  command -v python3 >/dev/null || die "缺少 python3（需要 >=3.9）"
  mkdir -p "${V4_HOME}"
  [[ -d "${VENV}" ]] || python3 -m venv "${VENV}"
  echo "  装依赖（含 torch，首次约 2GB，要几分钟）…"
  "${VENV}/bin/python" -m pip install -q --upgrade pip
  "${VENV}/bin/python" -m pip install -q -r "${ROOT}/ranker/requirements.txt"
  if "${VENV}/bin/python" -c "import numpy, PIL, torch, pyiqa, clip" >/dev/null 2>&1; then
    ok "已就绪：${VENV}"
  else
    die "依赖装完仍然导入失败，检查 ${ROOT}/ranker/requirements.txt"
  fi
fi

# ── 4. 装配 profile ────────────────────────────────────────────
# 模板里的占位符在这里换成真实路径。profile 是机器本地配置，
# 落在 $DSH_HOME 下而不是仓库里。
say "装配 profile"
mkdir -p "${DSH_HOME}/profiles"
for prof in photo photo-web; do
  src="${ROOT}/profiles/${prof}"
  dst="${DSH_HOME}/profiles/${prof}"
  mkdir -p "${dst}"
  for f in package.json cordis.yml pnpm-workspace.yaml; do
    cp "${src}/${f}" "${dst}/${f}"
  done
  sed -e "s|@@PHOTO_FILTER_HOME@@|${ROOT}|g" \
      -e "s|@@DSH_HOME@@|${DSH_HOME}|g" \
      "${src}/cordis.patch.yml" > "${dst}/cordis.patch.yml"
  ok "${prof}"
done

# 插件按包名解析，软链进 harness 维护的扁平模块层。
mkdir -p "${DSH_HOME}/profiles/node_modules/@photo-filter-agent"
ln -sfn "${ROOT}/agent" "${DSH_HOME}/profiles/node_modules/@photo-filter-agent/dsh-photo-filter-agent"
ok "插件已链接"

# v4 走自己的 $DSH_HOME（默认 ~/.dsh-v4），和 v3 完全隔离 —— 两者的 profile
# 同名不同内容，混在一个 home 里会互相覆盖。装配逻辑在 dsh-v4/sync-profiles.sh，
# 那个脚本双向可跑，避免 profile 只存在于本机、仓库里没有的老问题。
say "装配 v4 profile 与 preset"
if [[ -d "${ROOT}/profiles/photo-v4" ]]; then
  # 一并装 web 版的 persona（$DSH_HOME/.agent-presets/photo-filter-v4）。
  # 以前只有 README 里一句 cp -R，没有任何脚本装它 —— 全新克隆跑起来是没有人设的。
  DSH_HOME="${DSH_V4_HOME:-$HOME/.dsh-v4}" \
  PHOTOS="${PHOTOS:-$HOME/Desktop/照片}" \
    "${ROOT}/dsh-v4/sync-config.sh" push
  ok "v4 profile 与 preset 已装配到 ${DSH_V4_HOME:-$HOME/.dsh-v4}"
  warn "照片目录默认 ${PHOTOS:-$HOME/Desktop/照片}；不对就设 PHOTOS=… 重跑这一步"
else
  warn "仓库里没有 v4 profile，跳过"
fi

# ── 5. 视觉模型凭据 ────────────────────────────────────────────
say "检查视觉模型凭据"
CRED="${DSH_HOME}/.credentials.yaml"
if [[ -n "${MINIMAX_CN_API_KEY:-}${MINIMAX_API_KEY:-}" ]]; then
  ok "已从环境变量取到"
elif [[ -f "${CRED}" ]] && grep -qE "MINIMAX_(CN_)?API_KEY" "${CRED}"; then
  ok "已在 ${CRED} 中配置"
else
  warn "没有找到视觉模型 Key —— 只能用本地确定性选片（local_fallback_selection）"
  cat <<EOF

  要启用 AI 评分，二选一：

    export MINIMAX_CN_API_KEY=你的key

  或写进 ${CRED}：

    version: 1
    refs:
      MINIMAX_CN_API_KEY: 你的key

  harness 的循环模型也走同一个 Key，在 ${DSH_HOME}/settings.yaml 里配：

    llm-pi-ai:
      providers:
        minimax-cn:
          apiKeyEnv: MINIMAX_CN_API_KEY
    agent-default-model:
      provider: minimax-cn
      model: MiniMax-M3
EOF
fi

# ── 6. 自检 ────────────────────────────────────────────────────
say "自检"
"${ENGINE}" >/dev/null 2>&1 && ok "引擎可执行"
if (cd "${HARNESS}" && pnpm dsh --profile photo --dump-config 2>/dev/null | grep -q "photo-filter-agent"); then
  ok "插件已挂进 photo profile"
else
  die "profile 里找不到 photo-filter-agent，检查 ${DSH_HOME}/profiles/photo/cordis.patch.yml"
fi

cat <<EOF

$(printf '\033[1m装好了。\033[0m')

  命令行：
    cd ${ROOT}
    ./run.sh ~/Desktop/照片 50 3 3 ~/Desktop/精选

  图形界面（前台常驻，别关窗口）：
    cd ${HARNESS} && pnpm dsh --profile photo-web
    然后打开 http://127.0.0.1:3080

EOF
