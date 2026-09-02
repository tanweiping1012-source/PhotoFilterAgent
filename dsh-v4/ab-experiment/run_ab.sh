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

# 一份结果文件算不算「已经跑过了」。
#
# 不能只用 `[ -s ... ]`：上一轮如果是在写文件的中途被杀掉的，
# 文件非空但是截断的 JSON —— 续跑会把它当成已有结果跳过，
# 然后第 ③ 段 json.load 抛错、第 ④ 段 ab_verdict.py 直接崩。
# 崩比静默好，但代价是这一轮判分拿不到。所以跳过的条件必须是
# 「能解析出来、而且 rows 非空」。
has_result() {
  [ -s "$1" ] || return 1
  python3 -c '
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(1)
sys.exit(0 if d.get("rows") else 1)
' "$1" 2>/dev/null
}

ask() {   # $1=考题文件名  $2=结果文件  $3=limit（空=全部）
  local lim=""
  [ -n "${3:-}" ] && lim="，limit=$3"
  run "调用 run_pair_eval，参数 pairs=\"$1\"$lim，out=$2。直接调用，不要先问我。跑完把工具返回的摘要原样贴出来，不要改写任何数字。"
}

# ─────────────────────────────────────────────────────────────
echo "═══ ① 冒烟：确认单次 32 幅图（28 锚点 + 4 考题）能被接受 ═══"
# 续跑时不重复花这 2 次。936 断几次就多花几个 2 次，而且会覆盖上一轮的 smoke.json。
if has_result "$OUT/smoke.json"; then
  echo "  ✅ 本轮冒烟已通过，跳过（RUN_ID=$RUN_ID）"
  smoke="成对评测完成（沿用本轮已有结果）"
else
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
fi
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

RUN_FAIL=0
for cond in "无提示" "仅规则" "规则加范例"; do
  for f in "$PAIRS"/primary__*__"$cond".json "$PAIRS"/equal__*__"$cond".json; do
    [ -e "$f" ] || continue
    base=$(basename "$f")
    dst="$OUT/${base%.json}.result.json"
    # 续跑：已经有**合法且非空**结果的跳过，不重复花钱。
    # 截断的半个 JSON 不算 —— 见 has_result 的注释。
    if has_result "$dst"; then echo "--- $base （已有结果，跳过）"; continue; fi
    echo "--- $base ---"
    ask "$base" "$dst" | tail -8
    # 失败重试一次。
    #
    # 实测一次 66 对的文件因为「模型没有且仅调用结构化工具」整份报废 ——
    # 结果是跑完才写盘，失败前花掉的 132 次调用全作废。
    # 考题已经切到每份最多 20 对，所以重试的代价有上限。
    # 只重一次：连着两次同样失败多半不是偶发，再重就是烧钱。
    if ! has_result "$dst"; then
      echo "    ⚠️ 没出结果，重试一次"
      ask "$base" "$dst" | tail -5
      has_result "$dst" || { echo "    ❌ 重试仍失败，跳过（续跑时会再补）"; RUN_FAIL=1; }
    fi
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
# 预期题量从考题文件数出来，不写死 —— 写死的数字迟早和考题漂移。
EXPECT_PRIMARY=$(PAIRS="$PAIRS" python3 -c '
import glob, json, os
print(sum(len(json.load(open(f))["pairs"])
          for f in glob.glob(os.path.join(os.environ["PAIRS"], "primary__*__无提示.json"))))
')
echo "  预期题量：primary $EXPECT_PRIMARY 对"

# 判分必须检查退出码。
#
# 踩过：三个判分全部因为「同一对出现在两个结果文件里」崩掉，
# 而脚本最后照样打印「✅ 两档三臂全部跑完」+ exit 0 ——
# 丢了一个 66 对的文件、吃了两次 429、零判据输出，它报成功。
# 跟已经修掉的两个静默成功同一类，只是换了位置。
VERDICT_FAIL=0
verdict() {   # $1=标题  $2=实验臂  $3=对照臂
  echo
  echo "── $1 ──"
  if ! python3 "$(dirname "$0")/../ab_verdict.py" --expect "$EXPECT_PRIMARY" \
    --with  "$OUT"/primary__*__"$2".result.json \
    --without "$OUT"/primary__*__"$3".result.json; then
    echo "  ❌ 这一组判分失败"
    VERDICT_FAIL=1
  fi
}
verdict "规则加范例 vs 无提示（原本的两臂问题）" "规则加范例" "无提示"
verdict "仅规则 vs 无提示（rubric 能不能传递）"   "仅规则"     "无提示"
verdict "规则加范例 vs 仅规则（范例的增量）"       "规则加范例" "仅规则"

echo
echo "本轮 RUN_ID = $RUN_ID · 结果在 $OUT"
FAIL=0
[ "$RUN_FAIL"     -ne 0 ] && { echo "❌ 有考题文件重试后仍失败 —— 数据不全"; FAIL=1; }
[ "$STAGE3_FAIL"  -ne 0 ] && { echo "❌ 同层档有臂没跑成（见第 ③ 段）"; FAIL=1; }
[ "$VERDICT_FAIL" -ne 0 ] && { echo "❌ 有判分没跑成 —— **没有判据输出**"; FAIL=1; }
if [ "$FAIL" -ne 0 ]; then
  echo
  echo "**不要把这一轮当作完整交付。** 续跑：RUN_ID=$RUN_ID bash $0"
  exit 4
fi
echo "✅ 两档三臂全部跑完，三组判分全部产出"
