#!/usr/bin/env bash
# 检查 DSH 跑的到底是不是最新的代码。
#
# 为什么需要这个：DSH 有五层，只有一层是天然最新的。
# 剩下四层每一层我都真实踩过 ——
#   · Swift 引擎改了没重新 build，跑的还是旧二进制
#   · preset 改了没重启 DSH，agent 读的还是旧人设
#   · preset 有两份（运行的和仓库模板），改一份忘另一份
#   · 引擎输出多了字段，但缓存按数据集指纹分片、不认 schema 变化，读到的还是旧结构
#
# 用法：DSH_HOME=~/.dsh-v4 REPO=~/deepseek-harness/PhotoFilterAgent bash doctor.sh
set -uo pipefail
DSH_HOME="${DSH_HOME:-$HOME/.dsh-v4}"
REPO="${REPO:-$HOME/deepseek-harness/PhotoFilterAgent}"
CACHE="${CACHE:-$HOME/.cache/photofilter-rank}"
FAIL=0
ok()   { printf '  ✅ %s\n' "$1"; }
bad()  { printf '  ❌ %s\n' "$1"; FAIL=1; }
warn() { printf '  ⚠️  %s\n' "$1"; }
mtime() { stat -f %m "$1" 2>/dev/null || echo 0; }
newest() { find "$1" -type f -name "$2" -exec stat -f %m {} \; 2>/dev/null | sort -rn | head -1; }

echo "═══ 1. 插件代码：DSH 加载的是不是仓库那份 ═══"
LINK="$DSH_HOME/profiles/node_modules/@photo-filter-agent/dsh-photo-filter-v4"
if [ -L "$LINK" ]; then
  T=$(readlink "$LINK")
  [ "$T" = "$REPO/agent-v4" ] && ok "符号链接 → $T" || bad "链接指向 $T，不是 $REPO/agent-v4"
else
  bad "不是符号链接 —— 可能是拷贝，改了代码不会生效"
fi

echo "═══ 2. Swift 引擎：二进制比源码新吗 ═══"
BIN="$REPO/engine/.build/release/photofilter"
if [ ! -x "$BIN" ]; then bad "二进制不存在，先 swift build -c release"
else
  # 用构建系统当权威，不用 mtime。
  #
  # 踩过：mtime 比较把「只改了一行注释」误报成过期 —— swiftpm 发现产物字节
  # 没变就不重新链接，二进制 mtime 停在上次，但它功能上是最新的。
  # 直接跑一次增量构建最准，也就几秒。
  if OUT=$(cd "$REPO/engine" && swift build -c release 2>&1); then
    if printf '%s' "$OUT" | grep -q "Compiling"; then
      warn "刚刚重新编译过 —— 之前跑的是旧引擎，现在已是最新"
    else ok "构建已是最新（无需重编）"; fi
  else bad "引擎编译失败：$(printf '%s' "$OUT" | tail -3)"; fi
  # 输出字段自检：只看有单张事实的行（连拍折叠行本来就没有）
  FIELDS=$("$BIN" analyze "${PHOTOS:-$HOME/Desktop}" --limit 8 --workdir /tmp/dsh-doctor 2>/dev/null \
    | python3 -c "import json,sys
try: d=json.load(sys.stdin)
except Exception: print(''); raise SystemExit
need={'eye_openness','eye_face_px','pitch','face_area'}
have=set()
for c in d.get('candidates',[]): have|=set(c.keys())
print(','.join(sorted(need-have)))" 2>/dev/null)
  [ -z "$FIELDS" ] && ok "输出字段齐全" || warn "缺字段 $FIELDS（也可能是这批照片没人脸）"
fi

echo "═══ 3. Agent preset：运行的那份 == 仓库模板吗 ═══"
LIVE="$DSH_HOME/.agent-presets/photo-filter-v4/agent.cordis.yml"
TPL="$REPO/dsh-v4/preset-photo-filter-v4/agent.cordis.yml"
if [ -f "$LIVE" ] && [ -f "$TPL" ]; then
  # 占位符必须**全部**替换 —— 少一个就会误报「不同步」。
  # 踩过：只替换了 REPO/DSH_HOME/CACHE，漏了照片目录和导出目录。
  if diff -q <(sed "s|$REPO|@@REPO@@|g; s|$DSH_HOME|@@DSH_HOME@@|g; s|$CACHE|@@CACHE@@|g; \
       s|${PHOTOS_ROOT:-/Users/bytedance/Desktop/照片测试}|@@PHOTOS@@|g; \
       s|${EXPORT_ROOT:-$HOME/Downloads}|@@EXPORT@@|g" "$LIVE") "$TPL" >/dev/null 2>&1
  then ok "两份一致"
  else bad "运行的 preset 与仓库模板不一致 —— 改了一份忘了另一份"; fi
else bad "preset 或模板缺失"; fi

echo "═══ 4. 运行中的 DSH：启动之后代码有没有再改 ═══"
# 不要用 $ 锚点 —— 实际命令行可能以 --no-open 结尾。
# 也要排除包着它的那层 bash -c，否则匹配到的是壳不是服务。
PID=$(pgrep -f "bin.ts --profile photo-v4" | head -1)
if [ -z "$PID" ]; then warn "DSH web 没在跑"
else
  BOOT=$(ps -o lstart= -p "$PID" | xargs -I{} date -j -f "%a %b %d %T %Y" "{}" +%s 2>/dev/null)
  NEWEST=$(printf '%s\n' "$(newest "$REPO/agent-v4/src" '*.ts')" "$(mtime "$LIVE")" | sort -rn | head -1)
  if [ -n "$BOOT" ] && [ "$BOOT" -ge "${NEWEST:-0}" ]; then ok "启动于代码最后修改之后"
  else bad "启动之后 TS 代码或 preset 改过 —— 需要重启 DSH 才生效"; fi
fi

echo "═══ 5. 引擎结果缓存：schema 跟得上引擎吗 ═══"
STALE=$(find "$CACHE/engine" -name 'facts-*.json' 2>/dev/null | while read -r f; do
  python3 -c "import json,sys
d=json.load(open('$f'))
miss={'eye_openness','eye_face_px','pitch','head_down'}-set(d)
print('$f' if miss else '')" 2>/dev/null
done | grep -c . || true)
[ "${STALE:-0}" -eq 0 ] && ok "缓存里的事实含新字段" \
  || bad "$STALE 份缓存是旧 schema —— 缓存按数据集指纹分片，不认引擎升级。清掉：rm $CACHE/engine/*/facts-*.json"

echo
[ "$FAIL" -eq 0 ] && echo "全部通过 —— DSH 跑的是最新代码" || echo "有问题，见上面 ❌"
exit "$FAIL"
