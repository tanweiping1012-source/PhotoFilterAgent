#!/usr/bin/env bash
# 阶段 2 的成对评测。配额恢复后跑这一个脚本就够。
#
# 流程刻意分两步：
#   ① limit=1 冒烟 —— 每次调用要发 18 张图（3 组整组锚点 14 张 + 考题 4 张），
#      有些模型服务对单请求图片数有上限。先花 2 次调用确认能被接受，
#      不然 94 次调用跑到一半才发现被拒，钱白花。
#   ② 全量 47 对 / 94 次调用
#
# 判分线在跑之前就写死了（见下），跑完不管数字多好看都按这条线判 ——
# 这个项目上已经七次遇到「指标涨了但交付更差」。
set -uo pipefail
DSH_HOME="${DSH_HOME:-$HOME/.dsh-v4}"
HARNESS="${HARNESS:-$HOME/deepseek-harness}"
OUT="${OUT:-/tmp/claude-501/stage2-eval.json}"
export DSH_HOME

run() { (cd "$HARNESS" && pnpm dsh --profile photo-v4-eval "$1" 2>&1); }

echo "═══ ① 冒烟：确认单次 18 张图能被接受 ═══"
smoke=$(run "调用 run_pair_eval，参数 limit=1，out=/tmp/claude-501/stage2-smoke.json。直接调用，不要先问我。")
if printf '%s' "$smoke" | grep -qE 'RATE_LIMIT|429|AccountOverdue|403'; then
  echo "  ❌ 配额/账户不可用，跑不了："
  printf '%s\n' "$smoke" | grep -oE '(RATE_LIMIT|AUTH):[^"]*' | head -1
  exit 2
fi
if ! printf '%s' "$smoke" | grep -q "T0 机制"; then
  echo "  ❌ 冒烟没跑通，原样贴出："
  printf '%s\n' "$smoke" | tail -12
  exit 1
fi
echo "  ✅ 通过（2 次调用）"

echo
echo "═══ ② 全量：47 对 / 94 次调用 ═══"
full=$(run "调用 run_pair_eval，不要传 limit（跑全部 47 对），out=$OUT。直接调用，不要先确认。跑完把工具返回的摘要原样贴出来，不要改写任何数字。")
printf '%s\n' "$full" | tail -20

echo
echo "═══ ③ 判定（这四条线在跑之前就定死了）═══"
cat <<'EOF'
  T0 机制    AB/BA 双向一致率        ≥60%     （v3 的绝对打分只有 30%）
  T1 体检    睁眼 vs 闭眼            ≥13/14
  T2 增量    金标 vs 非金标          p<0.05 vs 本地分
  T3 确定性  同样的题重跑一遍         ≥90% 一致

  另外要看的：本地裁判 59% / 先知裁判 100% —— VLM 落在哪个位置。
  低于 59% 说明模型不如本地分，这一档就该关掉。
EOF
