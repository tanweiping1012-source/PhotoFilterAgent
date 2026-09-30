#!/usr/bin/env bash
# 检查 DSH 跑的到底是不是最新的代码。
#
# 为什么需要这个：DSH 有五层，只有一层是天然最新的。
# 剩下四层每一层我都真实踩过 ——
#   · Swift 引擎改了没重新 build，跑的还是旧二进制
#   · profile（人设与插件配置）改了没重启 DSH，agent 读的还是旧人设
#   · profile 有两份（部署的和仓库模板），改一份忘另一份
#   · 引擎输出多了字段，但缓存按数据集指纹分片、不认 schema 变化，读到的还是旧结构
#
# 用法：DSH_HOME=~/.dsh-photo-filter REPO=~/PhotoFilterAgent bash doctor.sh
set -uo pipefail
DSH_HOME="${DSH_HOME:-$HOME/.dsh-photo-filter}"
# 这一份带 PyYAML；系统 python3 不一定有。要在下面读 preset 之前就绪。
RANKER_PY="${RANKER_PY:-$DSH_HOME/ranker-venv/bin/python}"
REPO="${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
PROFILES="${PROFILES:-photo-v4 photo-v4-headless}"
CACHE="${CACHE:-$HOME/.cache/photofilter-rank}"
# 占位符替换用。词汇以 dsh-v4/README.md 的表为准，sync-config.sh 用的是同一套。
# 以前这里把标注者的私人照片目录写死成默认值 —— 私人路径不该进公开仓库，
# 而且换一台机器第 3 项就会假报「不一致」。
#
# 但改成通用默认值 `~/Desktop/照片` 之后又踩了第二个坑（2026-09-06）：
# 真实目录是 `~/Desktop/照片测试`，而 `照片` 是它的**前缀** ——
# sed 替换出 `@@PHOTOS@@测试`，于是第 3、3b 层六份文件全部假报不一致。
# 假警报比漏报更坏：它会把人训练成忽略这个工具。
#
# 所以不猜，**从部署的 preset 里把 allowedRoots 读出来**。
# 读不到才退回通用默认值，并明说这一层的结果不可信。
_photos_from_preset() {
  "$RANKER_PY" - "$DSH_HOME/profiles/photo-v4-headless/cordis.patch.yml" <<'PY' 2>/dev/null
import sys, yaml
try:
    doc = yaml.safe_load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    raise SystemExit(1)
def walk(n):
    if isinstance(n, dict):
        yield n
        for v in n.values(): yield from walk(v)
    elif isinstance(n, list):
        for v in n: yield from walk(v)
for e in walk(doc):
    if e.get("id") == "photo-filter-v4":
        roots = (e.get("config") or {}).get("allowedRoots") or []
        if roots:
            print(roots[0]); raise SystemExit(0)
raise SystemExit(1)
PY
}
PHOTOS_ROOT="${PHOTOS_ROOT:-${PHOTOS:-$(_photos_from_preset)}}"
PHOTOS_ROOT="${PHOTOS_ROOT:-$HOME/Desktop/照片}"
EXPORT_ROOT="${EXPORT_ROOT:-$HOME/Downloads}"
SCRATCH="${SCRATCH:-/tmp/claude-501}"
FAIL=0
ok()   { printf '  ✅ %s\n' "$1"; }
bad()  { printf '  ❌ %s\n' "$1"; FAIL=1; }
warn() { printf '  ⚠️  %s\n' "$1"; }
# ranker venv 不在时，下面每个用 $RANKER_PY 的检查都会各报一个 127，看起来像几处互不相干的故障。
# 所以开头报一次，依赖它的几项跳过并各记「未核」。
VENV_OK=1
if [ ! -x "$RANKER_PY" ]; then
  VENV_OK=0
  echo "═══ 0. ranker venv ═══"
  bad "ranker venv 不在（$RANKER_PY）—— 先跑 install.sh；下面依赖它的几项跳过"
fi
mtime() { stat -f %m "$1" 2>/dev/null || echo 0; }
newest() { find "$1" -type f -name "$2" -exec stat -f %m {} \; 2>/dev/null | sort -rn | head -1; }
# 把一份「已装配」的文件还原成模板形态，用来和仓库里的模板比。
# 占位符必须**全部**替换 —— 少一个就会误报「不同步」。
# 踩过：只替换了 REPO/DSH_HOME/CACHE，漏了照片目录和导出目录。
tpl_of() {
  LC_ALL=C sed -e "s|$REPO|@@REPO@@|g" -e "s|$DSH_HOME|@@DSH_HOME@@|g" \
               -e "s|$CACHE|@@CACHE@@|g" -e "s|$PHOTOS_ROOT|@@PHOTOS@@|g" \
               -e "s|$SCRATCH|@@SCRATCH@@|g" -e "s|$EXPORT_ROOT|@@EXPORT@@|g" "$1"
}

echo "═══ 1. 插件代码：DSH 加载的是不是仓库那份 ═══"
# DSH 0.2 起插件是每个 profile 的 link: 依赖（sync-config.sh push 时 pnpm 建的链接）。
for prof in $PROFILES; do
  LINK="$DSH_HOME/profiles/$prof/node_modules/@photo-filter-agent/dsh-photo-filter-v4"
  if [ -L "$LINK" ]; then
    T=$(cd "$LINK" 2>/dev/null && pwd -P)
    [ "$T" = "$(cd "$REPO/agent-v4" && pwd -P)" ] && ok "$prof → 仓库的 agent-v4" || bad "$prof 的插件链接指向 $T，不是 $REPO/agent-v4"
  else
    bad "$prof 里没有插件链接 —— 跑 dsh-v4/sync-config.sh push"
  fi
done

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

echo "═══ 3. Profile：运行的那几份 == 仓库模板吗 ═══"
# profile 决定人设、判据文件、allowNeither、图片上限、关掉哪些工具（DSH 0.2 起 web 的 preset 也在里面），
# 它漂了，跑出来的就不是仓库里描述的那个 agent。
# cordis.patch.yml 按条目、按内容比（见 check_profile_drift.py：DSH 0.2 会把界面设置写回这个文件并重排格式，
# 逐字节比会在用户每改一次设置后都假报不一致）；其余三个文件 DSH 不写，仍逐字节比。
PROF_BAD=0
SUBS=$(mktemp)
printf '{"@@REPO@@":"%s","@@DSH_HOME@@":"%s","@@CACHE@@":"%s","@@PHOTOS@@":"%s","@@SCRATCH@@":"%s","@@EXPORT@@":"%s"}' \
  "$REPO" "$DSH_HOME" "$CACHE" "$PHOTOS_ROOT" "$SCRATCH" "$EXPORT_ROOT" > "$SUBS"
for prof in $PROFILES; do
  for f in package.json cordis.yml cordis.patch.yml pnpm-workspace.yaml; do
    L="$DSH_HOME/profiles/$prof/$f"; T="$REPO/profiles/$prof/$f"
    [ -f "$T" ] || continue
    if [ ! -f "$L" ]; then bad "$prof/$f 没装到 \$DSH_HOME（跑 dsh-v4/sync-config.sh push）"; PROF_BAD=1
    elif [ "$f" = cordis.patch.yml ]; then
      if [ "$VENV_OK" -eq 0 ]; then warn "$prof/$f 未核：ranker venv 不在"
      elif ! DRIFT=$("$RANKER_PY" "$REPO/dsh-v4/check_profile_drift.py" "$L" "$T" "$SUBS"); then
        bad "$prof/$f 与仓库模板不一致：$DRIFT"; PROF_BAD=1
      elif [ -n "$DRIFT" ]; then printf '     %s\n' "$DRIFT"
      fi
    elif ! diff -q <(tpl_of "$L") "$T" >/dev/null 2>&1; then
      bad "$prof/$f 与仓库模板不一致"; PROF_BAD=1
    fi
  done
done
rm -f "$SUBS"
[ "$PROF_BAD" -eq 0 ] && ok "profile（$PROFILES）与仓库模板一致"
# DSH 0.1 时期这里还有一项「preset 与 profile 的同名键」（check_preset_shadow.py）：
# 那时 preset 放在 .agent-presets 目录里、插件配置有两份。0.2 起 preset 写进 profile，只剩一份，这一项不再需要。

echo "═══ 3d. 锚点：装了的话，本机的锚点照片齐不齐 ═══"
# 以前的 push 不管齐不齐都装，留下的那份在别的机器上会让阶段 2 每次失败（见 check_anchors.py）。
# 退出码三路：0 齐全、3 不齐、其他是核对脚本自己失败（见 check_anchors.py），后两种不能混报。
ANCHORS="$DSH_HOME/anchors.json"
if [ ! -f "$ANCHORS" ]; then ok "没装锚点 —— 阶段 2 不带范例照常跑"
elif [ "$VENV_OK" -eq 0 ]; then warn "未核：ranker venv 不在"
else
  ANCHORS_RC=0
  ANCHORS_MISS=$("$RANKER_PY" "$REPO/dsh-v4/check_anchors.py" "$ANCHORS") || ANCHORS_RC=$?
  case "$ANCHORS_RC" in
    0) ok "锚点照片在本机齐全" ;;
    3) bad "装了锚点但本机缺 $ANCHORS_MISS —— 阶段 2 会每次失败。重跑 dsh-v4/sync-config.sh push（会把它改名停用）" ;;
    *) bad "锚点核对脚本自己失败了（退出码 $ANCHORS_RC）—— 这一项没核成" ;;
  esac
fi

echo "═══ 4. 运行中的 DSH：启动之后代码有没有再改 ═══"
# 不要用 $ 锚点 —— 实际命令行可能以 --no-open 结尾。
# 也要排除包着它的那层 bash -c，否则匹配到的是壳不是服务。
PID=$(pgrep -f "bin.ts --profile photo-v4" | head -1)
if [ -z "$PID" ]; then warn "DSH web 没在跑"
else
  BOOT=$(ps -o lstart= -p "$PID" | xargs -I{} date -j -f "%a %b %d %T %Y" "{}" +%s 2>/dev/null)
  NEWEST=$(printf '%s\n' "$(newest "$REPO/agent-v4/src" '*.ts')" "$(mtime "$DSH_HOME/profiles/photo-v4/cordis.patch.yml")" | sort -rn | head -1)
  if [ -n "$BOOT" ] && [ "$BOOT" -ge "${NEWEST:-0}" ]; then ok "启动于代码最后修改之后"
  else bad "启动之后 TS 代码或 profile 改过 —— 需要重启 DSH 才生效"; fi
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
