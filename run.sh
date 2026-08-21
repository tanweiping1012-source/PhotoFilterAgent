#!/usr/bin/env bash
# 照片筛选 agent —— 一条命令跑通。
#
#   ./run.sh <照片目录> [取样张数] [人物保留数] [风景保留数] [导出目录]
#
# 例：
#   ./run.sh ~/Desktop/照片测试 50 3 3 ~/Desktop/照片筛选结果
#   ./run.sh ~/Desktop/照片测试            # 全量，人物 6 风景 6，不导出
set -euo pipefail

FOLDER="${1:?用法: ./run.sh <照片目录> [取样张数] [人物数] [风景数] [导出目录]}"
LIMIT="${2:-}"
PEOPLE="${3:-6}"
SCENERY="${4:-6}"
EXPORT_TO="${5:-}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS="${DSH_HARNESS:-/private/tmp/claude-501/-Users-bytedance-Desktop-claude-PhotoFilter/47b65fa2-7c9d-4ef7-9c0d-f2dc64f39b00/scratchpad/deepseek-harness}"
ENGINE="$ROOT/engine/.build/release/photocurate"

[[ -d "$FOLDER" ]] || { echo "照片目录不存在：$FOLDER" >&2; exit 1; }
[[ -d "$HARNESS" ]] || { echo "找不到 DeepSeek Harness：$HARNESS（可用 DSH_HARNESS 覆盖）" >&2; exit 1; }

# 引擎是本地分析的全部来源，缺了它 agent 连候选表都拿不到。
if [[ ! -x "$ENGINE" ]]; then
  echo "正在构建本地分析引擎…"
  (cd "$ROOT/engine" && swift build -c release)
fi

LIMIT_CLAUSE=""
[[ -n "$LIMIT" ]] && LIMIT_CLAUSE="limit=$LIMIT，"

TASK="完整策展 $FOLDER。${LIMIT_CLAUSE}人物保留 $PEOPLE 张、风景保留 $SCENERY 张。

按这个顺序做：
1. analyze_folder（免费，本地分析：人物/风景分类、连拍组、清晰度与曝光）
2. 每个连拍组先用 compare 比较，再用 resolve_family 定下代表——连拍之间的差别在表情和姿态，绝对打分看不出来
3. 剩余候选用 inspect detail=low 粗筛
4. 查 status；只在切线分差小于 3 时，对切线附近的照片用 detail=high 精看
5. propose 给出名单与每张的理由"

if [[ -n "$EXPORT_TO" ]]; then
  TASK="$TASK
6. export_selection 导出到 $EXPORT_TO"
fi

TASK="$TASK

请节制花费，不要把所有照片都用 high 档看一遍。"

cd "$HARNESS"
exec pnpm dsh --profile photo "$TASK"
