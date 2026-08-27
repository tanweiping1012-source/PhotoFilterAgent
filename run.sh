#!/usr/bin/env bash
# 旧命令行 profile 不能满足当前模型路由和 audit v3 契约，故 fail closed。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS="${DSH_HARNESS:-$(dirname "${ROOT}")}"

printf '%s\n' \
  '旧版 run.sh 流程已停用：它不能保证主 Agent、baseline、high、AB/BA 与独立审计使用同一当前会话模型。' \
  "请先运行：${ROOT}/install.sh ${HARNESS}" \
  "然后启动：cd ${HARNESS} && pnpm dsh --profile web" \
  '打开 http://127.0.0.1:3080，新建任务时选择 Photo Curator，并在界面选择本轮 provider/model。' >&2
exit 2
