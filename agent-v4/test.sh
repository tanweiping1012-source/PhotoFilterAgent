#!/usr/bin/env bash
# 插件的类型检查 + 行为测试。CI（.github/workflows/frozen.yml）跑的是同一套。
#
#   bash agent-v4/test.sh
#
# 依赖装在一份临时拷贝里，不装进 agent-v4/ 本身：DSH 从链接加载插件时，
# 插件目录里多出来的一套 @deepseek-ai/* 会被优先解析到，和 DSH 自己那套不是同一份。
#
# 版本与 install.sh 固定的 DSH 版本对应，升级 DSH 时一起改。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="${TMPDIR:-/tmp}/photo-filter-agent-v4-test"
DEPS=(
  typescript@5.9 @types/node
  @deepseek-ai/cordis@4.0.4 @deepseek-ai/dsh-tools@0.2.0-rc.2 @deepseek-ai/schemastery@3.18.4
)

mkdir -p "${WORK}"
rsync -a --delete --exclude node_modules --exclude package-lock.json "${HERE}/" "${WORK}/"
cd "${WORK}"
if [[ "$(cat node_modules/.deps 2>/dev/null)" != "${DEPS[*]}" ]]; then
  # 版本变了就整个重装：在旧依赖上原地升级，npm 会拿旧版的 peer 去解新版，报冲突。
  rm -rf node_modules
  npm install --loglevel=error --no-fund --no-audit --no-save --no-package-lock "${DEPS[@]}"
  echo "${DEPS[*]}" > node_modules/.deps
fi

npx tsc --noEmit
for t in src/*.test.ts; do
  node --experimental-strip-types --no-warnings "${t}"
done
echo "agent-v4：类型检查与 $(ls src/*.test.ts | wc -l | tr -d ' ') 个测试文件全部通过"
