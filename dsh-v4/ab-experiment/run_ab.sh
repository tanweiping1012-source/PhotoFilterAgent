#!/usr/bin/env bash
# AB 实验：有范例锚点 vs 没有范例锚点，跟用户标注的一致性差多少。
#
# 配额恢复后跑这一个脚本就够。它自己会先冒烟再全量。
#
# 判分线在跑之前就写死了（ab_verdict.py 已提交），跑完不管数字多好看
# 都按那条线判 —— 这个项目上已经七次遇到「指标涨了但交付更差」。
#
# 用法：bash run_ab.sh [冒烟]
set -uo pipefail
DSH_HOME="${DSH_HOME:-$HOME/.dsh-v4}"
HARNESS="${HARNESS:-$HOME/deepseek-harness}"
PAIRS="${PAIRS:-/tmp/claude-501/ab-pairs}"
OUT="${OUT:-/tmp/claude-501/ab-results}"
export DSH_HOME
mkdir -p "$OUT"

run() { (cd "$HARNESS" && pnpm dsh --profile photo-v4-ab "$1" 2>&1); }

ask() {   # $1=考题文件名  $2=结果文件  $3=limit（空=全部）
  local lim=""
  [ -n "${3:-}" ] && lim="，limit=$3"
  run "调用 run_pair_eval，参数 pairs=\"$1\"$lim，out=$2。直接调用，不要先问我。跑完把工具返回的摘要原样贴出来，不要改写任何数字。"
}

echo "═══ ① 冒烟：确认单次 32 幅图（28 锚点 + 4 考题）能被接受 ═══"
smoke=$(ask "primary__三湖__规则加范例.json" "$OUT/smoke.json" 1)
if printf '%s' "$smoke" | grep -qE 'RATE_LIMIT|429|AccountOverdue|403'; then
  echo "  ❌ 配额或账户不可用，一次调用都没花："
  printf '%s\n' "$smoke" | grep -oE '(RATE_LIMIT|AUTH)[^"]*' | head -1
  exit 2
fi
if ! printf '%s' "$smoke" | grep -q "成对评测完成"; then
  echo "  ❌ 冒烟没跑通，原样贴出："; printf '%s\n' "$smoke" | tail -15; exit 1
fi
echo "  ✅ 通过（2 次调用）"
echo
echo "  模型给的理由（要看它用不用烧进图里的名字，比如「例1丁」而不是「第 4 幅」）："
python3 -c "
import json,sys
d=json.load(open('$OUT/smoke.json'))
for r in d['rows'][:1]: print('   ', r['reason'][:400])
" 2>/dev/null || echo "   （读不到，手动看 $OUT/smoke.json）"

if [ "${1:-}" = "冒烟" ]; then echo; echo "只跑冒烟，停在这里。"; exit 0; fi

echo
echo "═══ ② 全量：三臂 × 2 方向 × （主分析 + 同层探索）═══"
# 跑之前先数考题文件。**缺了直接停，不许静默少跑一整档。**
#
# 踩过：第 ② 段的 glob 只收 primary，第 ③ 段却去读 equal 的结果文件，
# 于是同层档一次都没跑、第 ③ 段又因为 `if rows:` 安静跳过 ——
# 判分照常输出，看起来一切正常。用户批了 936 实际只花 486，
# 而他以为买到的那 42% 覆盖，拿到的是 0。
for tag in primary equal; do
  for cond in "无提示" "仅规则" "规则加范例"; do
    n=$(ls "$PAIRS"/${tag}__*__"$cond".json 2>/dev/null | wc -l | tr -d " ")
    if [ "$n" -eq 0 ]; then
      echo "  ❌ 缺考题：${tag}__*__${cond}.json 一个都没有。先跑 make_pairs.py。"
      exit 3
    fi
    echo "  考题 ${tag} / ${cond}：${n} 个文件"
  done
done
echo
# 臂名不用字母 —— 见 make_pairs.py 里那段注释。
for cond in "无提示" "仅规则" "规则加范例"; do
  # 两档都要跑。primary = 跨层（主检验），equal = 同层（探索性，正确答案是平局）。
  for f in "$PAIRS"/primary__*__"$cond".json "$PAIRS"/equal__*__"$cond".json; do
    [ -e "$f" ] || continue
    base=$(basename "$f")
    echo "--- $base ---"
    ask "$base" "$OUT/${base%.json}.result.json" | tail -8
  done
done

echo
echo "═══ ③ 同层探索档（不进主检验，判据不因它改动）═══"
echo "  问的是：标注者判「两张一样」时，模型会不会硬选一张。"
echo "  ⚠️ 同层真值只有约 61% 会重现（跨层方向是 90.5%），只当探索性证据。"
for cond in "无提示" "仅规则" "规则加范例"; do
  OUT="$OUT" COND="$cond" python3 -c '
import glob, json, os
out, cond = os.environ["OUT"], os.environ["COND"]
rows = [r for f in glob.glob(f"{out}/equal__*__{cond}.result.json")
        for r in json.load(open(f))["rows"]]
if not rows:
    raise SystemExit(f"  ERROR {cond}: 同层档没有任何结果 —— 这一档没跑成，不要当作跑过了")
ok = sum(1 for r in rows if r.get("winner") == "tie")
print(f"  {cond:<10} 答平局 {ok}/{len(rows)} = {ok/len(rows):.1%}   <- 越高越贴近标注者")
'
done

echo
echo "═══ ④ 判分（判据在跑之前就定死了）═══"
python3 "$(dirname "$0")/../ab_verdict.py" \
  --with "$OUT"/primary__*__规则加范例.result.json \
  --without "$OUT"/primary__*__无提示.result.json
echo
echo "── 仅规则 vs 无提示（rubric 能不能传递）──"
python3 "$(dirname "$0")/../ab_verdict.py" \
  --with "$OUT"/primary__*__仅规则.result.json \
  --without "$OUT"/primary__*__无提示.result.json
echo
echo "── 规则加范例 vs 仅规则（范例的增量）──"
python3 "$(dirname "$0")/../ab_verdict.py" \
  --with "$OUT"/primary__*__规则加范例.result.json \
  --without "$OUT"/primary__*__仅规则.result.json
