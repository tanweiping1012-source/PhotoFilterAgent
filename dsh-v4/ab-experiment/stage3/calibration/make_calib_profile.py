#!/usr/bin/env python3
"""生成标定专用 profile。0 次付费调用。跑完标定就删掉它们。

原则跟 make_web_arms.py 一样：**整份复制一个已部署的 profile，只改几行**，
用文本替换而不是 YAML 重新序列化 —— 那些 patch 里的注释记着踩过的坑
（附件上限 20 会静默回落、headless 的 persona 覆盖方式），重新 dump 会全丢。

两个变体（--variant，默认 headless）：
  headless  photo-v4-eval     → photo-v4-calib      底座 dsh-headless，人设写在 profile 的 system-prompt 里
  web       photo-v4-eval-web → photo-v4-calib-web  底座 dsh-web-app，**profile 里没有人设** ——
                                                    web 会话的人设来自 preset（.agent-presets/photo-filter-v4）
起出来是 web 还是 headless，只由 package.json 的 bundles 决定；两边的 cordis.yml 都是空的 []。

两个变体都只改三处，每一处都有它防的事：
  evalPairsFile  → archive 目录下的第一遍考题。原值指向 /tmp/claude-501/pairs-people.json，
                   **那个文件已经被系统清理掉了**（/tmp 第三次吃数据）
  evalPairsDir   → 同一个 archive 目录（新增）。没有它，run_pair_eval 换不了考题
  stage2Vlm      → false。persona「固定执行顺序」写着先 rank_photos ——
                   agent 只要照人设走一步，阶段 2 就会打 60 局 / 120 次，
                   超出批准的 114 次。**不能只靠提示词说「别调」**
                   headless 源没写这一项（schema 默认 **true**）→ 新增一行；
                   web 源显式写着 true → 改成 false。源不是预期的样子就停手。

web 源里另有两项**不改**，因为 run_pair_eval 不读它们：
  anchorsFile   run_pair_eval 的锚点只取考题文件里的 anchors（pairEval.ts）；config 这一项
                只喂 rank_photos 的阶段 2，而阶段 2 已被 stage2Vlm: false 关掉
  allowNeither  三份考题都显式写了 allow_neither: true，考题优先（index.ts：spec ?? config）

**目标 profile 已存在时不静默覆盖。** web 版是 owner 手工建的；这里以前无条件 rmtree，
照着下面的「下一步」跑一遍就会把别人那份换掉。现在：逐字节一致就不动，不一致默认拒绝，
要比对就用 --profiles-dir 生成到副本目录，确认要重建才加 --overwrite。

⚠️ doctor.sh 第 3b 层**看不见**这两个 profile（它只枚举固定的五个名字），
所以它们存在期间 3b 不会变红 —— 那是盲区，不是绿。核它们靠 --dump-config。
⚠️ --dump-config 只组合 bundles + profile patch，**不含 preset**。web 会话里实际生效的，
是这份组合再叠上会话选中的那个 preset —— 选的是哪个，只有会话日志说了算。

变异验证：validate_make_calib_profile.py（在副本目录里跑，不碰已部署的 profile）。
"""
from __future__ import annotations

import argparse
import re
import shutil
import sys
from pathlib import Path

HOME = Path.home()
ARCHIVE = HOME / ".dsh-v4/photo-filter-v4/archive/round3-calibration"
FIRST_SPEC = ARCHIVE / "calib-arm1-none.json"

VARIANTS = {
    "headless": {"src": "photo-v4-eval", "dst": "photo-v4-calib",
                 "bundle": "@deepseek-ai/dsh-headless", "persona": True},
    "web": {"src": "photo-v4-eval-web", "dst": "photo-v4-calib-web",
            "bundle": "@deepseek-ai/dsh-web-app", "persona": False},
}
MODE_BUNDLES = {"@deepseek-ai/dsh-headless", "@deepseek-ai/dsh-web-app"}
# profile 关的是**宿主那一层**的行。web 会话如果选了自带这些行的 preset（比如 cordis），
# 会话里照样有这些工具 —— 那一层这里管不到，要看会话日志。
DISABLED = ("tool-bash", "tool-fs", "tool-fs-search", "skill-filesystem",
            "tool-str-replace-editor", "tool-web")

HEADLESS_STAGE2 = [
    "# 标定期间阶段 2 **显式关掉**。不写这一行 schema 默认是 true，",
    "# 而 persona 会让 agent 先 rank_photos —— 那是 120 次计划外的付费调用。",
    "stage2Vlm: false",
]
WEB_STAGE2_COMMENT = [
    "# 标定期间阶段 2 **显式关掉**：源 profile 这里是 true（上面那段说的是生产默认）。",
    "# preset 的 persona 会让 agent 先 rank_photos —— 那是 120 次计划外的付费调用。",
]


def _key(key: str) -> re.Pattern:
    # 缩进只认空格和制表符：\s* 会跨过上一行的换行，把空行吃进缩进里
    return re.compile(rf"^([ \t]*){re.escape(key)}:(.*)$", re.M)


def replace_line(text: str, key: str, value: str, expect_old: str | None = None) -> str:
    found = _key(key).findall(text)
    if len(found) != 1:
        raise SystemExit(f"{key}: 应当恰好出现一次，实际 {len(found)} 次 —— 源 profile 结构变了，停手")
    old = found[0][1].strip()
    if expect_old is not None and old != expect_old:
        raise SystemExit(f"{key}: 源里是 {old!r}，预期 {expect_old!r} —— 源 profile 变了，停手")
    return _key(key).sub(lambda m: f"{m.group(1)}{key}: {value}", text)


def insert_after(text: str, anchor_key: str, lines: list[str]) -> str:
    m = _key(anchor_key).search(text)
    if not m:
        raise SystemExit(f"找不到 {anchor_key}:，停手")
    block = "".join(f"\n{m.group(1)}{ln}" for ln in lines)
    return text[:m.end()] + block + text[m.end():]


def insert_before(text: str, anchor_key: str, lines: list[str]) -> str:
    m = _key(anchor_key).search(text)
    if not m:
        raise SystemExit(f"找不到 {anchor_key}:，停手")
    block = "".join(f"{m.group(1)}{ln}\n" for ln in lines)
    return text[:m.start()] + block + text[m.start():]


def build_patch(base: str, variant: str) -> str:
    if _key("evalPairsDir").search(base):
        raise SystemExit("源 profile 已经有 evalPairsDir: —— 不是预期的结构，停手，别盖掉它")
    out = replace_line(base, "evalPairsFile", str(FIRST_SPEC))
    if variant == "headless":
        if _key("stage2Vlm").search(base):
            raise SystemExit("源 profile 已经有 stage2Vlm: —— 不是预期的结构，停手，别盖掉它")
        return insert_after(out, "evalPairsFile", [f"evalPairsDir: {ARCHIVE}", *HEADLESS_STAGE2])
    out = insert_after(out, "evalPairsFile", [f"evalPairsDir: {ARCHIVE}"])
    out = replace_line(out, "stage2Vlm", "false", expect_old="true")
    return insert_before(out, "stage2Vlm", WEB_STAGE2_COMMENT)


def build_package(pkg: str, v: dict, variant: str) -> str:
    src_name, dst_name = f'"dsh-profile-{v["src"]}"', f'"dsh-profile-{v["dst"]}"'
    if src_name not in pkg:
        raise SystemExit("package.json 里的包名不是预期的，停手")
    m = re.search(r'"bundles"\s*:\s*\[([^\]]*)\]', pkg)
    mode = set(re.findall(r'"([^"]+)"', m.group(1))) & MODE_BUNDLES if m else set()
    if mode != {v["bundle"]}:
        raise SystemExit(f"package.json 的底座是 {sorted(mode) or '（没找到）'}，"
                         f"{variant} 变体要的是 {v['bundle']} —— 停手")
    return pkg.replace(src_name, dst_name)


def self_check(t: str, pkg: str, v: dict) -> list[tuple[str, bool]]:
    persona = bool(re.search(r"^- id: system-prompt$", t, re.M) or re.search(r"^[ \t]*persona:", t, re.M))
    undisabled = [i for i in DISABLED if not re.search(rf"^- id: {re.escape(i)}\n  disabled: true$", t, re.M)]
    return [
        ("allowedRoots", bool(re.search(r"allowedRoots:\s*\[.*照片测试.*\]", t))),
        ("engineBinary", bool(re.search(r"engineBinary:\s*\S+photofilter", t))),
        ("excludedRelativePaths 含 me-pick", bool(re.search(r'-\s*"me-pick"', t))),
        ("evalPairsFile 不在 /tmp", bool(re.search(rf"evalPairsFile:\s*{re.escape(str(FIRST_SPEC))}", t))),
        ("evalPairsDir 不在 /tmp", bool(re.search(rf"evalPairsDir:\s*{re.escape(str(ARCHIVE))}", t))),
        ("stage2Vlm: false 且只有这一行",
         bool(re.search(r"^[ \t]*stage2Vlm:[ \t]*false[ \t]*$", t, re.M)) and len(_key("stage2Vlm").findall(t)) == 1),
        ("maxImagesPerMessage: 40", bool(re.search(r"maxImagesPerMessage:\s*40", t))),
        ("六个通用能力在宿主层 disabled" + (f"（缺 {', '.join(undisabled)}）" if undisabled else ""), not undisabled),
        ("有 headless persona" if v["persona"] else "不带 persona（web 用 preset 的）", persona == v["persona"]),
        (f"bundles 是 {v['bundle']}", v["bundle"] in pkg),
        ("文件里没有 /tmp/ 路径", "/tmp/" not in t),
    ]


def main() -> int:
    ap = argparse.ArgumentParser(description="生成标定专用 profile（0 次付费调用）")
    ap.add_argument("--variant", choices=sorted(VARIANTS), default="headless")
    ap.add_argument("--profiles-dir", type=Path, default=HOME / ".dsh-v4/profiles",
                    help="生成到别的目录（比对、变异验证用），不碰已部署的 profile")
    ap.add_argument("--overwrite", action="store_true",
                    help="目标 profile 已存在且内容不同时删掉重建；默认拒绝")
    args = ap.parse_args()
    v = VARIANTS[args.variant]
    src, dst = args.profiles_dir / v["src"], args.profiles_dir / v["dst"]
    if not src.is_dir():
        raise SystemExit(f"源 profile 不存在：{src}")

    patch = build_patch((src / "cordis.patch.yml").read_text(encoding="utf-8"), args.variant)
    pkg = build_package((src / "package.json").read_text(encoding="utf-8"), v, args.variant)
    # 自检在**动目标目录之前**做完，查的就是马上要落盘的那两段文本本身
    # （上一轮 --patch 整段替换骗过 diff 的教训）。不过就什么都不写，旧的那份原样留着。
    checks = self_check(patch, pkg, v)
    miss = [label for label, ok in checks if not ok]
    if miss:
        raise SystemExit("❌ 生成的 profile 不完整：" + "；".join(miss))

    want = {
        "cordis.patch.yml": patch.encode("utf-8"),
        "package.json": pkg.encode("utf-8"),
        "cordis.yml": (src / "cordis.yml").read_bytes(),
        "pnpm-workspace.yaml": (src / "pnpm-workspace.yaml").read_bytes(),
    }
    if dst.exists():
        differ = sorted(f for f, b in want.items() if not (dst / f).is_file() or (dst / f).read_bytes() != b)
        extra = sorted(p.name for p in dst.iterdir() if p.name not in want)
        if not differ and not extra:
            print(f"✅ {dst.name} 已存在，与生成结果逐字节一致，没有改动")
            return 0
        if not args.overwrite:
            raise SystemExit(f"{dst.name} 已存在且与生成结果不同（{', '.join(differ + extra)}）—— 不静默覆盖。"
                             f"要比对就用 --profiles-dir 生成到副本目录；确认要重建再加 --overwrite")
        shutil.rmtree(dst)
    dst.mkdir(parents=True)
    for f, b in want.items():
        (dst / f).write_bytes(b)
    ARCHIVE.mkdir(parents=True, exist_ok=True)

    print(f"✅ {dst.name}（{args.variant}，源 {src.name}）")
    for label, _ in checks:
        print(f"   ✓ {label}")
    changed = ("evalPairsFile 一行改值 + 新增 evalPairsDir / stage2Vlm" if args.variant == "headless"
               else "evalPairsFile 一行改值 + 新增 evalPairsDir + stage2Vlm 由 true 改 false（前面加两行注释）")
    print(f"   与源 profile 的差异：{changed}；package.json 只改包名")
    print(f"\n下一步（0 次调用）：cd ~/deepseek-harness && DSH_HOME=~/.dsh-v4 pnpm dsh --profile {dst.name} --dump-config")
    return 0


if __name__ == "__main__":
    sys.exit(main())
