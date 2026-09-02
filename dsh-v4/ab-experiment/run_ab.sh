#!/usr/bin/env bash
# AB 实验：三臂 × 两档。跑这一个脚本就够。
#
#   臂   无提示 / 仅规则 / 规则加范例        ← 名字不用字母，见 make_pairs.py 的注释
#   档   primary 跨层（主检验，正确答案 = 赢家）
#        equal   同层（探索性，正确答案 = **平局**）
#
# 判据在跑之前就写死了（ab_verdict.py 已提交），跑完不管数字多好看都按那条线判 ——
# 这个项目上已经七次遇到「指标涨了但交付更差」。
#
# 用法：
#   bash run_ab.sh 冒烟              只跑 2 次，验负载和指代
#   bash run_ab.sh                   全量：936 次
#   RUN_ID=xxx bash run_ab.sh        指定轮次（续跑/重跑时用）
#
# 退出码：0 全部成功 · 1 冒烟没跑通 · 2 配额/账户不可用 · 3 缺考题 · 4 有档没跑成
set -uo pipefail

DSH_HOME="${DSH_HOME:-$HOME/.dsh-v4}"
HARNESS="${HARNESS:-$HOME/deepseek-harness}"
PAIRS="${PAIRS:-/tmp/claude-501/ab-pairs}"
OUT_BASE="${OUT_BASE:-/tmp/claude-501/ab-results}"
# 每一轮一个独立子目录。
#
# 不这么做的后果：936 次中途断了重跑，上一轮的 result.json 会和新结果
# **静默混在一起**进判分 —— glob 收的是目录里所有匹配的文件，不区分轮次。
# 936 次中断的概率不低，这不是假想问题。
RUN_ID="${RUN_ID:-$(date +%Y%m%d-%H%M%S)}"
OUT="$OUT_BASE/$RUN_ID"
export DSH_HOME
mkdir -p "$OUT"

echo "本轮 RUN_ID = $RUN_ID"
echo "结果目录     $OUT"
echo "续跑或重判分：RUN_ID=$RUN_ID bash $0"
echo

run() { (cd "$HARNESS" && pnpm dsh --profile photo-v4-ab "$1" 2>&1); }

ask() {   # $1=考题文件名  $2=结果文件  $3=limit（空=全部）
  local lim=""
  [ -n "${3:-}" ] && lim="，limit=$3"
  run "调用 run_pair_eval，参数 pairs=\"$1\"$lim，out=$2。直接调用，不要先问我。跑完把工具返回的摘要原样贴出来，不要改写任何数字。"
}

# ─────────────────────────────────────────────────────────────
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
echo "  模型给的理由 —— **看它用不用烧进图里的名字**（「例1丁」而不是「第 4 幅」）："
OUT="$OUT" python3 -c '
import json, os
d = json.load(open(os.path.join(os.environ["OUT"], "smoke.json")))
for r in d["rows"][:1]:
    print("   ", r["reason"][:400])
' 2>/dev/null || echo "   （读不到，手动看 $OUT/smoke.json）"

if [ "${1:-}" = "冒烟" ]; then
  echo; echo "只跑冒烟，停在这里。理由确认没问题再跑全量。"; exit 0
fi

# ─────────────────────────────────────────────────────────────
echo
echo "═══ ② 全量：三臂 × 2 方向 × （primary + equal）═══"
# 跑之前先数考题。**缺一档直接停，不许静默少跑。**
#
# 踩过：全量循环的 glob 只收了 primary，而第 ③ 段去读 equal 的结果文件，
# 于是同层档一次都没跑、③ 又因为 `if rows:` 安静跳过 —— 判分照常输出。
# 用户批了 936 实际只花 486，他以为买到的那 42% 覆盖拿到的是 0，全程不报错。
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

for cond in "无提示" "仅规则" "规则加范例"; do
  for f in "$PAIRS"/primary__*__"$cond".json "$PAIRS"/equal__*__"$cond".json; do
    [ -e "$f" ] || continue
    base=$(basename "$f")
    dst="$OUT/${base%.json}.result.json"
    # 续跑：已经有结果的跳过，不重复花钱
    if [ -s "$dst" ]; then echo "--- $base （已有结果，跳过）"; continue; fi
    echo "--- $base ---"
    ask "$base" "$dst" | tail -8
  done
done

# ─────────────────────────────────────────────────────────────
echo
echo "═══ ③ 同层探索档（不进主检验，判据不因它改动）═══"
echo "  问的是：标注者判「两张一样」时，模型会不会硬选一张。"
echo "  ⚠️ 同层真值只有约 61% 会重现（跨层方向是 90.5%），只当探索性证据。"
# 这里的失败必须是**致命**的。
#
# 脚本没有 set -e（有意的 —— set -e 会让 ② 段里单次 ask 失败就打断整轮 936）。
# 所以 python3 抛错之后循环会继续、脚本会走到 ④、最后 exit 0，
# 结果是「吵一声但少跑一整档」，退出码仍然是 0，调用方还是当成功。
# 用一个标志位收住：任何一臂缺结果，最后 exit 4。
STAGE3_FAIL=0
for cond in "无提示" "仅规则" "规则加范例"; do
  OUT="$OUT" COND="$cond" python3 -c '
import glob, json, os
out, cond = os.environ["OUT"], os.environ["COND"]
rows = [r for f in glob.glob(os.path.join(out, f"equal__*__{cond}.result.json"))
        for r in json.load(open(f))["rows"]]
if not rows:
    raise SystemExit(f"  ❌ {cond}：同层档没有任何结果 —— 这一档没跑成，不要当作跑过了")
ok = sum(1 for r in rows if r.get("winner") == "tie")
print(f"  {cond:<10} 答平局 {ok}/{len(rows)} = {ok/len(rows):.1%}   ← 越高越贴近标注者")
' || STAGE3_FAIL=1
done

# ─────────────────────────────────────────────────────────────
echo
echo "═══ ④ 判分（判据在跑之前就定死了；只收 primary，同层不进主检验）═══"
verdict() {   # $1=标题  $2=实验臂  $3=对照臂
  echo
  echo "── $1 ──"
  python3 "$(dirname "$0")/../ab_verdict.py" \
    --with  "$OUT"/primary__*__"$2".result.json \
    --without "$OUT"/primary__*__"$3".result.json
}
verdict "规则加范例 vs 无提示（原本的两臂问题）" "规则加范例" "无提示"
verdict "仅规则 vs 无提示（rubric 能不能传递）"   "仅规则"     "无提示"
verdict "规则加范例 vs 仅规则（范例的增量）"       "规则加范例" "仅规则"

echo
echo "本轮 RUN_ID = $RUN_ID · 结果在 $OUT"
if [ "$STAGE3_FAIL" -ne 0 ]; then
  echo "❌ 同层档有臂没跑成（见第 ③ 段）。**不要把这一轮当作完整交付。**"
  exit 4
fi
echo "✅ 两档三臂全部跑完"
