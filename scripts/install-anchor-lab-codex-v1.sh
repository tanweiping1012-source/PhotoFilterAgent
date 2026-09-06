#!/usr/bin/env bash
# Install the isolated Codex Anchor Lab as a user Agent Preset in an equally
# isolated DSH_HOME. It never edits the standard Web profile, Claude photo-v4,
# another preset, credentials, model settings, or photo files.
set -euo pipefail
export DSH_TELEMETRY_DISABLED=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ $# -ne 1 ]]; then
  printf '用法：%s /absolute/path/to/deepseek-harness\n' "$0" >&2
  exit 2
fi
HARNESS_ROOT="$1"
[[ "${HARNESS_ROOT}" = /* ]] || { printf 'Harness 路径必须是绝对路径。\n' >&2; exit 2; }
HARNESS_ROOT="$(cd "${HARNESS_ROOT}" && pwd)"

ANCHOR_DSH_HOME="${PHOTO_ANCHOR_LAB_CODEX_DSH_HOME:-${HOME}/.dsh-anchor-lab-codex-v1}"
ANCHOR_ARTIFACT_ROOT="${PHOTO_ANCHOR_LAB_CODEX_ARTIFACT_ROOT:-${ANCHOR_DSH_HOME}/qa-artifacts}"
ALLOWED_ROOTS="${PHOTO_ANCHOR_LAB_CODEX_ALLOWED_ROOTS:-}"
EXCLUDED_PATHS="${PHOTO_ANCHOR_LAB_CODEX_EXCLUDED_RELATIVE_PATHS:-}"

die() { printf '✖ %s\n' "$1" >&2; exit 1; }
ok() { printf '✓ %s\n' "$1"; }
require_file() { [[ -f "$2" ]] || die "$1 不存在或不是文件：$2"; }
require_absolute() { [[ "$2" = /* ]] || die "$1 必须是绝对路径：$2"; }

[[ -f "${HARNESS_ROOT}/apps/cli/src/bin.ts" ]] || die "这不是 DeepSeek Harness 源码目录：${HARNESS_ROOT}"
HARNESS_VERSION="$(node -e 'const fs=require("node:fs");process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).version)' "${HARNESS_ROOT}/package.json")"
[[ "${HARNESS_VERSION}" = '0.1.0-rc.8' ]] || die "只验收 dsh-v0.1.0-rc.8；当前 ${HARNESS_VERSION}"
[[ -d "${HARNESS_ROOT}/node_modules" ]] || die "Harness 依赖尚未安装"
require_absolute 'PHOTO_ANCHOR_LAB_CODEX_DSH_HOME' "${ANCHOR_DSH_HOME}"
require_absolute 'PHOTO_ANCHOR_LAB_CODEX_ARTIFACT_ROOT' "${ANCHOR_ARTIFACT_ROOT}"
[[ -n "${ALLOWED_ROOTS}" ]] || die 'PHOTO_ANCHOR_LAB_CODEX_ALLOWED_ROOTS 至少需要一行绝对路径'

paths_overlap() {
  node -e '
    const { isAbsolute, relative, resolve } = require("node:path")
    const [left, right] = process.argv.slice(1).map(value => resolve(value))
    const contains = (root, child) => {
      const rest = relative(root, child)
      return rest === "" || (!rest.startsWith("..") && !isAbsolute(rest))
    }
    process.exit(contains(left, right) || contains(right, left) ? 0 : 1)
  ' "$1" "$2"
}

assert_not_overlapping() {
  local label="$1"
  local left="$2"
  local right="$3"
  if paths_overlap "${left}" "${right}"; then
    die "${label}：${right}"
  else
    local status=$?
    [[ ${status} -eq 1 ]] || die "无法验证目录隔离：${left} / ${right}"
  fi
}

for variable_name in \
  PHOTO_ANCHOR_LAB_CODEX_ANCHOR_PACK_PATH \
  PHOTO_ANCHOR_LAB_CODEX_REFERENCE_SHEET_PATH \
  PHOTO_ANCHOR_LAB_CODEX_REFERENCE_SHEET_RECEIPT_PATH \
  PHOTO_ANCHOR_LAB_CODEX_ANCHOR_OVERLAP_RECEIPT_PATH
do
  variable_value="${!variable_name:-}"
  [[ -n "${variable_value}" ]] || die "缺少 ${variable_name}"
  require_absolute "${variable_name}" "${variable_value}"
  require_file "${variable_name}" "${variable_value}"
done

CANONICAL_ALLOWED_ROOTS=()
while IFS= read -r allowed_root || [[ -n "${allowed_root}" ]]; do
  [[ -z "${allowed_root}" ]] && continue
  require_absolute 'allowed root' "${allowed_root}"
  [[ -d "${allowed_root}" ]] || die "allowed root 不存在：${allowed_root}"
  allowed_root="$(cd "${allowed_root}" && pwd -P)"
  assert_not_overlapping '独立 DSH_HOME 不得与照片授权根目录重叠' \
    "${ANCHOR_DSH_HOME}" "${allowed_root}"
  assert_not_overlapping '验收 artifact 目录不得与照片授权根目录重叠' \
    "${ANCHOR_ARTIFACT_ROOT}" "${allowed_root}"
  CANONICAL_ALLOWED_ROOTS+=("${allowed_root}")
done <<< "${ALLOWED_ROOTS}"
[[ ${#CANONICAL_ALLOWED_ROOTS[@]} -gt 0 ]] || die '没有有效的 allowed root'

LINK_PARENT="${ANCHOR_DSH_HOME}/profiles/node_modules/@photo-filter-agent"
PLUGIN_LINK="${LINK_PARENT}/dsh-photo-anchor-lab-codex-v1"
if [[ -e "${PLUGIN_LINK}" && ! -L "${PLUGIN_LINK}" ]]; then
  die "插件位置已存在且不是软链接，拒绝覆盖：${PLUGIN_LINK}"
fi
if [[ -L "${PLUGIN_LINK}" ]]; then
  CURRENT_TARGET="$(readlink "${PLUGIN_LINK}")"
  case "${CURRENT_TARGET}" in
    "${ANCHOR_DSH_HOME}"/runtime-snapshots/*/agent-anchor-lab-codex-v1) ;;
    *) die "现有插件链接不属于 Codex 内容快照，拒绝覆盖：${CURRENT_TARGET}" ;;
  esac
fi
PRESET_DIRECTORY="${ANCHOR_DSH_HOME}/.agent-presets/photo-anchor-lab-codex-v1"
if [[ -f "${PRESET_DIRECTORY}/preset.yml" ]] \
  && ! grep -qx 'name: Photo Curator Anchor Lab (Codex)' "${PRESET_DIRECTORY}/preset.yml"; then
  die "同 ID preset 已存在但身份不匹配，拒绝覆盖：${PRESET_DIRECTORY}"
fi

MODULE_CACHE_ROOT="${ANCHOR_DSH_HOME}/cache/swift-module-cache"
ENGINE_BUILD_ROOT="${ANCHOR_DSH_HOME}/build/anchor-lab-codex-v1-engine"
ENGINE_BINARY="${ENGINE_BUILD_ROOT}/release/photofilter"
mkdir -p "${MODULE_CACHE_ROOT}"
(cd "${ROOT}/engine" && \
  CLANG_MODULE_CACHE_PATH="${MODULE_CACHE_ROOT}" \
  SWIFTPM_MODULECACHE_OVERRIDE="${MODULE_CACHE_ROOT}" \
  swift build --disable-sandbox --build-path "${ENGINE_BUILD_ROOT}" -c release >/dev/null)
[[ -x "${ENGINE_BINARY}" ]] || die 'Codex 专属本地分析引擎构建失败'
ok 'Codex 专属本地分析引擎已构建（未写共享 engine/.build）'

SNAPSHOT_PACKAGE_ROOT="$(node "${ROOT}/scripts/snapshot-anchor-lab-codex-runtime.mjs" \
  --repo-root "${ROOT}" \
  --snapshot-root "${ANCHOR_DSH_HOME}/runtime-snapshots")"
require_file 'runtime snapshot package' "${SNAPSHOT_PACKAGE_ROOT}/package.json"
require_file 'runtime snapshot entry' "${SNAPSHOT_PACKAGE_ROOT}/src/index.ts"
SNAPSHOT_HASH="$(basename "$(dirname "${SNAPSHOT_PACKAGE_ROOT}")")"
[[ "${SNAPSHOT_HASH}" =~ ^[a-f0-9]{64}$ ]] || die 'runtime snapshot hash 无效'
ok "Codex 运行源码已冻结为内容快照：${SNAPSHOT_HASH}"

SNAPSHOT_NODE_MODULES="${SNAPSHOT_PACKAGE_ROOT}/node_modules"
if [[ -L "${SNAPSHOT_NODE_MODULES}" ]]; then
  [[ "$(readlink "${SNAPSHOT_NODE_MODULES}")" = "${HARNESS_ROOT}/node_modules" ]] \
    || die 'runtime snapshot 的 Harness dependency bridge 指向不一致'
elif [[ -e "${SNAPSHOT_NODE_MODULES}" ]]; then
  die 'runtime snapshot 的 node_modules 位置不是受控软链接'
else
  ln -s "${HARNESS_ROOT}/node_modules" "${SNAPSHOT_NODE_MODULES}"
fi

TSX_TSCONFIG_PATH="${HARNESS_ROOT}/tsconfig.json" \
node --import "${HARNESS_ROOT}/node_modules/tsx/dist/esm/index.mjs" --input-type=module -e '
  const { pathToFileURL } = await import("node:url")
  const p = await import(pathToFileURL(process.argv[1]).href)
  if (typeof p.apply !== "function" || !p.Config) throw new Error("invalid plugin exports")
' "${SNAPSHOT_PACKAGE_ROOT}/src/index.ts" \
  >/dev/null
ok '内容快照 package 可真实导入'

ANCHOR_INSTALL_STAGE="$(mktemp -d "${TMPDIR:-/tmp}/anchor-lab-codex-install.XXXXXX")"
cleanup() {
  [[ -n "${ANCHOR_INSTALL_STAGE:-}" && -d "${ANCHOR_INSTALL_STAGE}" ]] \
    && rm -rf "${ANCHOR_INSTALL_STAGE}"
}
trap cleanup EXIT

render_preset() {
  local output="$1"
  local target_dsh_home="$2"
  local render_args=(
    --template "${ROOT}/presets/photo-anchor-lab-codex-v1/agent.cordis.yml"
    --output "${output}"
    --engine-binary "${ENGINE_BINARY}"
    --dsh-home "${target_dsh_home}"
    --artifact-root "${ANCHOR_ARTIFACT_ROOT}"
    --anchor-pack-path "${PHOTO_ANCHOR_LAB_CODEX_ANCHOR_PACK_PATH}"
    --reference-sheet-path "${PHOTO_ANCHOR_LAB_CODEX_REFERENCE_SHEET_PATH}"
    --reference-sheet-receipt-path "${PHOTO_ANCHOR_LAB_CODEX_REFERENCE_SHEET_RECEIPT_PATH}"
    --anchor-overlap-receipt-path "${PHOTO_ANCHOR_LAB_CODEX_ANCHOR_OVERLAP_RECEIPT_PATH}"
  )
  for allowed_root in "${CANONICAL_ALLOWED_ROOTS[@]}"; do
    render_args+=(--allowed-root "${allowed_root}")
  done
  while IFS= read -r excluded_path || [[ -n "${excluded_path}" ]]; do
    [[ -z "${excluded_path}" ]] && continue
    render_args+=(--excluded-relative-path "${excluded_path}")
  done <<< "${EXCLUDED_PATHS}"
  node "${ROOT}/scripts/render-anchor-lab-codex-preset.mjs" "${render_args[@]}" >/dev/null
}

STAGE_PRESET_DIRECTORY="${ANCHOR_INSTALL_STAGE}/.agent-presets/photo-anchor-lab-codex-v1"
mkdir -p "${STAGE_PRESET_DIRECTORY}" \
  "${ANCHOR_INSTALL_STAGE}/profiles/node_modules/@photo-filter-agent"
render_preset "${STAGE_PRESET_DIRECTORY}/agent.cordis.yml" "${ANCHOR_DSH_HOME}"
cp "${ROOT}/presets/photo-anchor-lab-codex-v1/preset.yml" \
  "${STAGE_PRESET_DIRECTORY}/preset.yml"
ln -s "${SNAPSHOT_PACKAGE_ROOT}" \
  "${ANCHOR_INSTALL_STAGE}/profiles/node_modules/@photo-filter-agent/dsh-photo-anchor-lab-codex-v1"

(cd "${HARNESS_ROOT}" && \
  DSH_HOME="${ANCHOR_INSTALL_STAGE}" \
  DSH_TELEMETRY_DISABLED=1 \
  TSX_TSCONFIG_PATH="${HARNESS_ROOT}/tsconfig.json" \
  node --import "${HARNESS_ROOT}/node_modules/tsx/dist/esm/index.mjs" \
    "${ROOT}/scripts/verify-anchor-lab-codex-preset.mjs" \
    "${HARNESS_ROOT}" "${ANCHOR_INSTALL_STAGE}" 'photo-anchor-lab-codex-v1')
ok 'staging 中真实 mount 与主 Agent 工具 exact-set 验收通过（未调用领域工具）'

mkdir -p "${PRESET_DIRECTORY}" "${LINK_PARENT}"
render_preset "${PRESET_DIRECTORY}/agent.cordis.yml" "${ANCHOR_DSH_HOME}"
PRESET_METADATA_TEMP="${PRESET_DIRECTORY}/preset.yml.tmp-$$"
cp "${ROOT}/presets/photo-anchor-lab-codex-v1/preset.yml" "${PRESET_METADATA_TEMP}"
mv -f "${PRESET_METADATA_TEMP}" "${PRESET_DIRECTORY}/preset.yml"

PLUGIN_LINK_TEMP="${PLUGIN_LINK}.tmp-$$"
ln -s "${SNAPSHOT_PACKAGE_ROOT}" "${PLUGIN_LINK_TEMP}"
node -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' \
  "${PLUGIN_LINK_TEMP}" "${PLUGIN_LINK}"
ok '独立 preset 与内容快照已原子安装；标准 Web/Claude v4 未修改'

printf '\n启动独立页面（不会覆盖 Claude v4）：\n  cd %q && DSH_TELEMETRY_DISABLED=1 DSH_HOME=%q pnpm dsh --profile web --port 3082 --no-open\n' \
  "${HARNESS_ROOT}" "${ANCHOR_DSH_HOME}"
printf '在新会话选择：Photo Curator Anchor Lab (Codex)\n'
