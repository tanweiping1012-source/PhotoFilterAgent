#!/usr/bin/env bash
# 从零把照片筛选 agent 装起来（只支持 macOS）。
#
#   PHOTOS=~/Pictures/我的旅行照片 ./install.sh
#
# 做五件事，每一步都会先检查、已经做好的就跳过（可以放心重复运行）：
#   1. 检查前置工具：Xcode 命令行工具（Swift）、Node.js、pnpm、git、Python 3.9+
#   2. 准备 DeepSeek Harness（DSH）：克隆并**切到本项目验证过的版本**，装依赖、构建
#   3. 编译本地分析引擎（Swift，负责看人脸、判断闭眼）
#   4. 建 Python 环境（排序器用：CLIP 特征 + 图像质量模型，首次约 2GB）
#   5. 把 agent 的配置装进 DSH_HOME（web 界面用的 photo-v4 与命令行用的 photo-v4-headless）
#
# 可调的环境变量：
#   PHOTOS     允许 agent 读取的照片根目录（必填）。agent 只能处理这个目录里的照片，原图只读
#   HARNESS    DSH 的安装目录，默认 ~/deepseek-harness
#   DSH_HOME   agent 的配置、会话与缓存放在哪，默认 ~/.dsh-photo-filter
#
# macOS 自带 bash 3.2，所有紧跟非 ASCII 文本的变量必须用 ${} 显式界定。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS="${HARNESS:-$HOME/deepseek-harness}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh-photo-filter}"
PHOTOS="${PHOTOS:-}"

# 本项目验证过的 DSH 版本。DSH 还在预览期，版本之间会有破坏性变更（0.1 → 0.2 的变化见 dsh-v4/README.md），
# 所以这里**真的切到这个版本**，不跟着 master 走。
HARNESS_TAG="dsh-v0.2.0-rc.1"
HARNESS_REPO="https://github.com/deepseek-ai/deepseek-harness.git"

say() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }
ok()  { printf '  ✅ %s\n' "$1"; }
warn(){ printf '  ⚠️  %s\n' "$1"; }
die() { printf '\n\033[31m✖ %s\033[0m\n' "$1" >&2; exit 1; }

# ── 0. 参数 ────────────────────────────────────────────────────
[[ -n "${PHOTOS}" ]] || die "请告诉我照片放在哪：PHOTOS=~/Pictures/我的旅行照片 ./install.sh"
PHOTOS="$(cd "${PHOTOS}" 2>/dev/null && pwd)" || die "照片目录不存在：${PHOTOS}"

# ── 1. 前置工具 ────────────────────────────────────────────────
say "1/5 检查前置工具"
[[ "$(uname -s)" == "Darwin" ]] || die "只支持 macOS：人脸与闭眼判断用的是苹果的 Vision 框架"
command -v swift   >/dev/null || die "缺少 Swift：xcode-select --install"
swift --version >/dev/null 2>&1 || die "swift 用不了（常见原因：xcode-select 指向了一个已删除的 Xcode）。修复：sudo xcode-select -s /Library/Developer/CommandLineTools"
command -v node    >/dev/null || die "缺少 Node.js（需要 22.19 以上或 24 以上）"
command -v pnpm    >/dev/null || die "缺少 pnpm：npm install -g pnpm"
command -v git     >/dev/null || die "缺少 git"
command -v python3 >/dev/null || die "缺少 python3（需要 3.9 以上）"
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' >/dev/null 2>&1 \
  || die "python3 用不了或低于 3.9（常见原因同上：xcode-select 指向了已删除的 Xcode）"
ok "swift · node $(node --version) · pnpm $(pnpm --version) · $(python3 --version)"

# ── 2. DeepSeek Harness ────────────────────────────────────────
say "2/5 准备 DeepSeek Harness（${HARNESS_TAG}）"
if [[ -f "${HARNESS}/apps/cli/src/bin.ts" ]]; then
  have="$(git -C "${HARNESS}" describe --tags --exact-match 2>/dev/null || echo '不是 tag')"
  if [[ "${have}" != "${HARNESS_TAG}" ]]; then
    die "${HARNESS} 里已经有一份 DSH，但版本是「${have}」，本项目验证的是 ${HARNESS_TAG}。
  要么换个目录：HARNESS=~/dsh-for-photo ./install.sh
  要么把它切过去：git -C ${HARNESS} fetch --depth 1 origin tag ${HARNESS_TAG} && git -C ${HARNESS} checkout ${HARNESS_TAG}"
  fi
  ok "已存在且版本正确：${HARNESS}"
else
  [[ -e "${HARNESS}" ]] && die "${HARNESS} 已存在但不是 DSH 仓库，请换个目录：HARNESS=… ./install.sh"
  git clone --depth 1 --branch "${HARNESS_TAG}" "${HARNESS_REPO}" "${HARNESS}"
  ok "已克隆"
fi
if [[ ! -d "${HARNESS}/node_modules" ]]; then
  echo "  安装 DSH 的依赖 …"
  (cd "${HARNESS}" && pnpm install --frozen-lockfile)
fi
if [[ ! -f "${HARNESS}/apps/cli/lib/bin.js" ]]; then
  echo "  构建 DSH（几分钟）…"
  (cd "${HARNESS}" && pnpm run build)
fi
ok "DSH 就绪"

# ── 3. Swift 分析引擎 ──────────────────────────────────────────
say "3/5 编译本地分析引擎"
ENGINE="${ROOT}/engine/.build/release/photofilter"
if [[ -x "${ENGINE}" ]]; then
  ok "已编译：${ENGINE}"
else
  (cd "${ROOT}/engine" && swift build -c release)
  [[ -x "${ENGINE}" ]] || die "编译完成但找不到可执行文件"
  ok "已编译"
fi

# ── 4. Python 排序环境 ─────────────────────────────────────────
# 排序器（ranker/）不装进环境，插件运行时直接从源码目录导入；这里只装它的依赖。
say "4/5 准备 Python 环境"
VENV="${DSH_HOME}/ranker-venv"
if "${VENV}/bin/python" -c "import numpy, PIL, torch, pyiqa, clip" >/dev/null 2>&1; then
  ok "已就绪：${VENV}"
else
  mkdir -p "${DSH_HOME}"
  [[ -d "${VENV}" ]] || python3 -m venv "${VENV}"
  echo "  装依赖（含 torch，首次约 2GB，要几分钟）…"
  "${VENV}/bin/python" -m pip install -q --upgrade pip
  "${VENV}/bin/python" -m pip install -q -r "${ROOT}/ranker/requirements.txt"
  "${VENV}/bin/python" -c "import numpy, PIL, torch, pyiqa, clip" >/dev/null 2>&1 \
    || die "依赖装完仍然导入失败，检查 ${ROOT}/ranker/requirements.txt"
  ok "已就绪：${VENV}"
fi

# ── 5. 配置 ────────────────────────────────────────────────────
say "5/5 把 agent 装进 ${DSH_HOME}"
DSH_HOME="${DSH_HOME}" PHOTOS="${PHOTOS}" "${ROOT}/dsh-v4/sync-config.sh" push
if (cd "${HARNESS}" && DSH_HOME="${DSH_HOME}" pnpm -s dsh --profile photo-v4-headless --dump-config 2>/dev/null \
      | grep -q "dsh-photo-filter-v4"); then
  ok "DSH 认得这个 agent"
else
  die "DSH 读不到 agent 的配置，检查 ${DSH_HOME}/profiles/photo-v4-headless/"
fi

# ── 模型的 API Key ─────────────────────────────────────────────
KEY_HINT=""
if [[ -z "${MINIMAX_CN_API_KEY:-}" ]]; then
  KEY_HINT="
  还差一步：配置视觉模型的 API Key（默认用 MiniMax-M3），二选一：
    · 启动前 export MINIMAX_CN_API_KEY=你的key
    · 或启动 web 界面后，在「设置 → 模型」里填
  换别的模型也行，但必须支持图片输入，见 dsh-v4/README.md。
"
fi

cat <<EOF

$(printf '\033[1m装好了。\033[0m')
${KEY_HINT}
  图形界面（窗口别关）：
    cd ${HARNESS} && DSH_HOME=${DSH_HOME} pnpm dsh --profile photo-v4
    然后打开终端里打印出来的那个网址（带 token），对 agent 说：
    「请从 ${PHOTOS} 里挑 20 张最好的照片」

  命令行一次性任务：
    cd ${HARNESS} && DSH_HOME=${DSH_HOME} pnpm dsh --profile photo-v4-headless "从 ${PHOTOS} 挑 20 张最好的照片"

  自检（哪一层没装好会直接告诉你）：
    DSH_HOME=${DSH_HOME} REPO=${ROOT} bash ${ROOT}/dsh-v4/doctor.sh

EOF
