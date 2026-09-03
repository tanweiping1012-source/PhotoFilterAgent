#!/usr/bin/env bash
# 仪器标定：条件矩阵 + AA 对照 + 正对照。
#
# 和 run_ab.sh 是两件事：那个测 rubric，这个测**仪器**。
# 判据在 INSTRUMENT-CHECK.md 里，跑之前定死。
#
# 可以随时 Ctrl-C，再跑一次会**从断点续上** —— 已经跑完的对按 calls.jsonl 跳过。
set -uo pipefail
DSH_HOME="${DSH_HOME:-$HOME/.dsh-v4}"; export DSH_HOME
HARNESS="${HARNESS:-$HOME/deepseek-harness}"
RUN="${RUN:-$(cat /tmp/claude-501/instrument-check/LATEST)}"
JSONL="$RUN/calls.jsonl"

FILES=(
  "primary__三湖__无提示.json"
  "primary__me__无提示.json"
  "primary__eval-me-133__无提示.json"
  "primary__me自然瀑布线~1__无提示.json"
  "primary__me自然瀑布线~2__无提示.json"
  "primary__me自然瀑布线~3__无提示.json"
  "primary__me自然瀑布线~4__无提示.json"
)

ask() {  # $1=phase $2=file $3=limit(可空)
  local lim=""; [ -n "${3:-}" ] && lim="，limit=$3"
  (cd "$HARNESS" && pnpm dsh --profile photo-v4-ab \
    "调用 run_instrument_check，参数 phase=\"$1\"，out_dir=\"$RUN\"，pairs=\"$2\"$lim。直接调用，不要先问我。只贴工具摘要。" 2>&1 | tail -6)
}

count() { [ -f "$JSONL" ] && grep -c "\"phase\":\"$1\"" "$JSONL" 2>/dev/null || echo 0; }

echo "════ 阶段 ② 条件矩阵（每对 4 次：AB/AB2/AB3/BA）════"
for f in "${FILES[@]}"; do
  echo "── $f  [已有 matrix 行 $(count matrix)]"
  ask matrix "$f" ""
done

echo
echo "════ 阶段 ③ AA 对照（同一张照片放两槽位，烧不同码）════"
# 40 张：从前四份考题里各取一批，够估一个比例（n=40 → 95%CI 半宽约 ±15%）
for f in "${FILES[@]:3:3}"; do
  [ "$(count aa)" -ge 40 ] && break
  ask aa "$f" 14
done

echo
echo "════ 阶段 ④ 正对照（原图 vs 重度模糊副本，真值无争议）════"
ask sanity "primary__me自然瀑布线~1__无提示.json" 10

echo
echo "════ 跑完 ════"
echo "matrix $(count matrix) · aa $(count aa) · sanity $(count sanity) · probe $(count probe)"
echo "判分：python3 instrument_check.py --run-dir $RUN"
