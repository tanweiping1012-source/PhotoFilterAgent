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
if [[ $# -gt 1 ]]; then
  printf '用法：%s [harness 目录]\n' "$0" >&2
  exit 2
fi
HARNESS="${1:-$(dirname "${ROOT}")}"
HARNESS="$(cd "${HARNESS}" 2>/dev/null && pwd || echo "${HARNESS}")"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"

# 本仓库开发与验证时所对应的 harness 版本。它是 v0.1 developer preview，
# 官方明确会有破坏性变更；换版本出问题先回到这个锚点。
HARNESS_PIN="dsh-v0.1.0-rc.8"
HARNESS_REPO="https://github.com/deepseek-ai/deepseek-harness.git"

say() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }
ok()  { printf '  ✅ %s\n' "$1"; }
warn(){ printf '  ⚠️  %s\n' "$1"; }
die() { printf '\n\033[31m✖ %s\033[0m\n' "$1" >&2; exit 1; }

# 目录白名单使用“每行一个绝对路径”的格式；不用逗号或冒号，避免它们与合法
# 文件名冲突。空值渲染成 []，让插件默认拒绝所有照片读取与导出。
yaml_path_array() {
  local raw="$1"
  local item escaped separator=""
  if [[ -z "${raw}" ]]; then
    printf '[]'
    return
  fi
  printf '['
  while IFS= read -r item || [[ -n "${item}" ]]; do
    [[ -z "${item}" ]] && continue
    if [[ "${item}" != /* ]]; then
      printf '目录白名单只接受绝对路径：%s\n' "${item}" >&2
      return 1
    fi
    escaped="$(printf '%s' "${item}" | sed -e 's|\\|\\\\|g' -e 's|"|\\"|g')"
    printf '%s"%s"' "${separator}" "${escaped}"
    separator=', '
  done <<EOF
${raw}
EOF
  printf ']'
}

# 候选排除规则使用“每行一个相对路径”。它们会相对于本轮明确授权的照片根目录
# 解析，并在 fingerprint/匿名 ID 生成前跳过整个子树。绝对路径、空路径与 `..`
# 都 fail closed，避免把排除配置变成越界读取或意外排除整个数据集的通道。
yaml_relative_path_array() {
  local raw="$1"
  local item escaped separator=""
  if [[ -z "${raw}" ]]; then
    printf '[]'
    return
  fi
  printf '['
  while IFS= read -r item || [[ -n "${item}" ]]; do
    [[ -z "${item}" ]] && continue
    case "/${item}/" in
      //*|*/../*|*/./*|*//*)
        printf '候选排除项必须是规范的非空相对路径：%s\n' "${item}" >&2
        return 1
        ;;
    esac
    escaped="$(printf '%s' "${item}" | sed -e 's|\\|\\\\|g' -e 's|"|\\"|g')"
    printf '%s"%s"' "${separator}" "${escaped}"
    separator=', '
  done <<EOF
${raw}
EOF
  printf ']'
}

# sed replacement 需要保护路径或 YAML 数组里的反斜杠、& 与分隔符。
sed_replacement() {
  printf '%s' "$1" | sed 's|[\\&|]|\\&|g'
}

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
  git clone --branch "${HARNESS_PIN}" --depth 1 "${HARNESS_REPO}" "${HARNESS}"
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

HARNESS_VERSION="$(node -p "require('${HARNESS}/package.json').version" 2>/dev/null || true)"
if [[ "${HARNESS_VERSION}" == "0.1.0-rc.8" ]]; then
  ok "检测到 ${HARNESS_PIN}，使用 user agent preset"
else
  die "当前 harness 是 ${HARNESS_VERSION:-未知版本}；Photo Curator 只验证于 ${HARNESS_PIN}。为避免静默加载旧 profile 或错误模型路由，安装已停止。"
fi

# ── 3. Swift 分析引擎 ──────────────────────────────────────────
say "构建本地分析引擎"
ENGINE="${ROOT}/engine/.build/release/photofilter"
# SwiftPM 会增量复用未变化的产物；每次执行 build 才能保证源码刚更新后不会继续
# 运行旧二进制（匿名 ID/安全边界变化时尤其不能靠“文件已经存在”判断）。
(cd "${ROOT}/engine" && swift build -c release)
[[ -x "${ENGINE}" ]] || die "构建完成但找不到可执行文件"
ok "已构建：${ENGINE}"

# ── 4. 装配 agent ──────────────────────────────────────────────
# rc.8 把面向模型的能力放进 per-session agent preset。这里不再静默回退
# 到旧 profile；旧版本必须先显式适配和重新验收模型路由。
say "装配 photo-curator agent preset"
preset_src="${ROOT}/presets/photo-curator"
preset_dst="${DSH_HOME}/.agent-presets/photo-curator"
allowed_roots="$(yaml_path_array "${PHOTO_FILTER_ALLOWED_ROOTS:-}")"
excluded_relative_paths="$(yaml_relative_path_array "${PHOTO_FILTER_EXCLUDED_RELATIVE_PATHS:-}")"
allowed_export_roots="$(yaml_path_array "${PHOTO_FILTER_ALLOWED_EXPORT_ROOTS:-}")"
root_replacement="$(sed_replacement "${ROOT}")"
home_replacement="$(sed_replacement "${DSH_HOME}")"
allowed_roots_replacement="$(sed_replacement "${allowed_roots}")"
excluded_relative_paths_replacement="$(sed_replacement "${excluded_relative_paths}")"
allowed_export_roots_replacement="$(sed_replacement "${allowed_export_roots}")"
mkdir -p "${preset_dst}"
sed -e "s|@@PHOTO_FILTER_HOME@@|${root_replacement}|g" \
    -e "s|@@DSH_HOME@@|${home_replacement}|g" \
    -e "s|@@PHOTO_FILTER_ALLOWED_ROOTS@@|${allowed_roots_replacement}|g" \
    -e "s|@@PHOTO_FILTER_EXCLUDED_RELATIVE_PATHS@@|${excluded_relative_paths_replacement}|g" \
    -e "s|@@PHOTO_FILTER_ALLOWED_EXPORT_ROOTS@@|${allowed_export_roots_replacement}|g" \
    "${preset_src}/agent.cordis.yml" > "${preset_dst}/agent.cordis.yml"
cp "${preset_src}/preset.yml" "${preset_dst}/preset.yml"
if grep -q '@@PHOTO_FILTER' "${preset_dst}/agent.cordis.yml"; then
  die "photo-curator preset 仍有未渲染的安装占位符"
fi
if grep -q '@deepseek-ai/dsh-tool-subagent' "${preset_dst}/agent.cordis.yml"; then
  die "photo-curator 不得加载可接收任意 prompt 的通用 subagent 工具"
fi
if ! grep -q "name: 'independent_evaluator'" "${ROOT}/agent/src/independent-evaluator.ts"; then
  die "找不到 PhotoFilterAgent 自有的五字段 independent_evaluator"
fi
ok "photo-curator → ${preset_dst}"

# 插件按包名解析，软链进 harness 维护的扁平模块层。
mkdir -p "${DSH_HOME}/profiles/node_modules/@photo-filter-agent"
PLUGIN_LINK="${DSH_HOME}/profiles/node_modules/@photo-filter-agent/dsh-photo-filter-agent"
if [[ -e "${PLUGIN_LINK}" ]] && [[ ! -L "${PLUGIN_LINK}" ]]; then
  die "${PLUGIN_LINK} 已存在且不是软链；为避免覆盖本地文件，请先移走"
fi
ln -sfn "${ROOT}/agent" "${PLUGIN_LINK}"
ok "插件已链接 → ${ROOT}/agent"

# ── 5. 视觉模型凭据 ────────────────────────────────────────────
say "检查 Harness 凭据格式"
CRED="${DSH_HOME}/.credentials.yaml"
if [[ -f "${CRED}" ]]; then
  credential_format="$(node "${ROOT}/scripts/migrate-credentials.mjs" "${CRED}" "${HARNESS}")" \
    || die "${CRED} 不是 Harness 可用的凭据格式；未读取或输出其中的值"
  if [[ "${credential_format}" == "migrated-legacy" ]]; then
    ok "已把旧版嵌套凭据格式原子迁移为 Harness rc.8 的扁平映射（值未输出）"
  fi
fi
ok "Photo Curator 不再维护独立视觉 Key；评分与审计统一经当前 Harness provider/model 路由"

# ── 6. 自检 ────────────────────────────────────────────────────
say "自检"
if grep -R -qE 'visionModel|api\.minimaxi\.com|MiniMax-M3' \
  "${ROOT}/presets" "${ROOT}/profiles" "${ROOT}/agent/src"; then
  die "产品路径仍存在固定视觉供应商/模型路由"
fi
"${ENGINE}" >/dev/null 2>&1 && ok "引擎可执行"
if (cd "${HARNESS}" && DSH_HOME="${DSH_HOME}" pnpm dsh --profile web --dump-config 2>/dev/null | grep -q "agent-presets"); then
  ok "rc.8 web profile 已装配 agent preset roster"
else
  die "rc.8 web profile 中找不到 agent-presets roster"
fi
if (cd "${HARNESS}" && DSH_HOME="${DSH_HOME}" node --import tsx/esm --input-type=module -e '
    import { scanRoot } from "@deepseek-ai/dsh-agent-presets"
    import { join } from "node:path"
    const home = process.env.DSH_HOME
    if (!home) throw new Error("DSH_HOME is required")
    const rows = await scanRoot({ path: join(home, ".agent-presets"), trust: "user" })
    const preset = rows.find((row) => row.id === "photo-curator")
    if (!preset) throw new Error("photo-curator is not discoverable")
    if (preset.broken) throw new Error(`photo-curator is broken: ${preset.broken}`)
  ' >/dev/null 2>&1); then
  ok "roster 可发现 photo-curator，且 composition 通过 rc.8 结构检查"
else
  die "roster 无法发现 photo-curator；检查 ${DSH_HOME}/.agent-presets/photo-curator"
fi

cat <<EOF

$(printf '\033[1m装好了。\033[0m')

  图形界面（前台常驻，别关窗口）：
    cd ${HARNESS} && pnpm dsh --profile web
    打开 http://127.0.0.1:3080，新建会话时选择 Photo Curator。

EOF
