#!/usr/bin/env python3
"""第四轮端到端 A/B：生成 A / B1 / B2 / B3 四份 web profile（dry-run）。0 次付费调用。

判据：CRITERIA-E2E.md 修订 1.1、1.2、2.10。四份都从已部署的生产 profile `photo-v4` 整份复制
（阶段 2 配置逐字相同），只在 photo-filter-v4 配置块的 allowNeither 之后插入 4 行（1 行注释 + 3 个键）。
四组之间**只有这三个键的值不同**；package.json 只改包名。

  组   profile           stage3Vlm  stage3RubricFile   stage3AnchorsFile
  A    photo-v4-e2e-a    false      ""                 ""
  B1   photo-v4-e2e-b1   true       ""                 ""
  B2   photo-v4-e2e-b2   true       <rubric 文件>      ""
  B3   photo-v4-e2e-b3   true       <rubric 文件>      <锚点文件>

几条规矩，每条对着一个会静默测错东西的方式：
  · 空值写成显式 ""，不省略这一行 —— 省略就依赖 schema 默认值，四份文件看不出差别在哪
  · 阶段 2 的 stage2Vlm / anchorsFile / allowNeither 保持 photo-v4 原值：修订 1.1 要求四组逐字相同。
    自检是「去掉插入的 4 行后与 photo-v4 逐字节相同」，比逐个键核更严
  · 源里已经有 stage3* 或 evalPairs* → 停手：源 profile 不是预期的生产 photo-v4
  · rubric 文件必须与第三轮标定 calib-arm2 spec 的 rubric 逐字相同，且 JS 的 trim() 前后不变（agent 读文件会 trim）
  · 锚点文件必须与 calib-arm3 spec 的 anchors 在 folder / text / photos / labels 上逐项相同，
    不许残留 @@ 占位符，8 张照片在 folder 下各找到恰好 1 张
  · 排除清单（excludedRelativePaths）是 preset 层的键，写在 profile 里不生效 —— 实验期的排除改在 preset（修订 2.1），不在这里
  · **这一版只做 dry-run**：--out-dir 落在 ~/.dsh-v4/profiles 里就拒绝；目标目录已存在也拒绝，不覆盖。部署是另一个决定

用法：
  python3 make_e2e_profiles.py --out-dir <scratch> --rubric-file <rubric> --anchors-file <锚点>
变异验证：validate_make_e2e_profiles.py
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
from pathlib import Path

HOME = Path.home()
SRC = HOME / ".dsh-v4/profiles/photo-v4"
PROFILES = HOME / ".dsh-v4/profiles"
CALIB = HOME / ".dsh-v4/photo-filter-v4/archive/round3-calibration"
# 组 → (profile 名, stage3Vlm, 带 rubric, 带锚点)。修订 2.10 的表
GROUPS = {
    "A": ("photo-v4-e2e-a", False, False, False),
    "B1": ("photo-v4-e2e-b1", True, False, False),
    "B2": ("photo-v4-e2e-b2", True, True, False),
    "B3": ("photo-v4-e2e-b3", True, True, True),
}
STAGE3_KEYS = ("stage3Vlm", "stage3RubricFile", "stage3AnchorsFile")
BLOCK_COMMENT = "# 第四轮端到端 A/B（CRITERIA-E2E）：阶段 3 的三个键。四组之间只有这三行的值不同。"
DISABLED = ("tool-bash", "tool-fs", "tool-fs-search", "skill-filesystem", "tool-str-replace-editor", "tool-web")
# ECMAScript String.prototype.trim 去掉的字符（WhiteSpace + LineTerminator）
JS_WS = set("\t\n\v\f\r              "
            "    　﻿")


def md5(data: bytes) -> str:
    return hashlib.md5(data).hexdigest()


def js_trim(s: str) -> str:
    i, j = 0, len(s)
    while i < j and s[i] in JS_WS:
        i += 1
    while j > i and s[j - 1] in JS_WS:
        j -= 1
    return s[i:j]


def lines_of(text: str, key: str) -> list[tuple[str, str]]:
    return re.findall(rf"^([ \t]*){re.escape(key)}:(.*)$", text, re.M)


def check_source(patch: str, pkg: str) -> str:
    """源 profile 必须是预期的生产 photo-v4。返回插入点（allowNeither 那一行）的缩进。"""
    for key, want in (("stage2Vlm", "true"), ("allowNeither", "true")):
        found = lines_of(patch, key)
        if len(found) != 1 or found[0][1].strip() != want:
            raise SystemExit(f"源 profile 的 {key} 应当恰好一行且为 {want}，实际 {[f[1].strip() for f in found]} —— 停手")
    anchors = lines_of(patch, "anchorsFile")
    if len(anchors) != 1 or not anchors[0][1].strip():
        raise SystemExit("源 profile 应当恰好有一行非空的 anchorsFile（阶段 2 的生产锚点）—— 停手")
    for key in (*STAGE3_KEYS, "evalPairsFile", "evalPairsDir"):
        if lines_of(patch, key):
            raise SystemExit(f"源 profile 已经有 {key}: —— 不是预期的生产 photo-v4，停手")
    undisabled = [i for i in DISABLED if not re.search(rf"^- id: {re.escape(i)}\n  disabled: true$", patch, re.M)]
    if undisabled:
        raise SystemExit(f"源 profile 没关掉 {undisabled} —— 停手")
    if not re.search(r"^[ \t]*maxImagesPerMessage:[ \t]*40[ \t]*$", patch, re.M):
        raise SystemExit("源 profile 的 maxImagesPerMessage 不是 40（阶段 2 每次 24 幅、B3 阶段 3 每次 20 幅）—— 停手")
    if '"dsh-profile-photo-v4"' not in pkg:
        raise SystemExit("源 package.json 的包名不是 dsh-profile-photo-v4 —— 停手")
    m = re.search(r'"bundles"\s*:\s*\[([^\]]*)\]', pkg)
    bundles = set(re.findall(r'"([^"]+)"', m.group(1))) if m else set()
    if "@deepseek-ai/dsh-web-app" not in bundles or "@deepseek-ai/dsh-headless" in bundles:
        raise SystemExit(f"源 package.json 的底座不是 web（{sorted(bundles)}）—— 停手")
    return lines_of(patch, "allowNeither")[0][0]


def check_rubric(path: Path, calib: Path) -> tuple[int, str]:
    data = path.read_bytes()
    txt = data.decode("utf-8")
    spec = json.loads((calib / "calib-arm2-rubric.json").read_text(encoding="utf-8"))["rubric"]
    if js_trim(txt) != txt:
        raise SystemExit("rubric 文件首尾有空白：agent 读的时候会 trim()，读到的和文件不一样 —— 停手")
    if txt != spec:
        raise SystemExit(f"rubric 文件与第三轮标定 calib-arm2 spec 的 rubric 不逐字相同（文件 {len(txt)} 字，spec {len(spec)} 字）—— 停手")
    return len(txt), md5(data)


def check_anchors(path: Path, calib: Path) -> tuple[int, str]:
    raw = path.read_bytes()
    txt = raw.decode("utf-8")
    if "@@" in txt:
        raise SystemExit("锚点文件里还有 @@ 占位符没替换 —— 停手")
    a = json.loads(txt)
    spec = json.loads((calib / "calib-arm3-rubric-anchors.json").read_text(encoding="utf-8"))["anchors"]
    diff = [k for k in ("folder", "text", "photos", "labels") if a.get(k) != spec.get(k)]
    if diff:
        raise SystemExit(f"锚点文件与第三轮标定 calib-arm3 spec 的 anchors 在 {diff} 上不同 —— 停手")
    folder = Path(a["folder"])
    missing = [n for n in a["photos"] if len(list(folder.rglob(n))) != 1]
    if missing:
        raise SystemExit(f"锚点照片在 {folder} 下找不到或不唯一：{missing} —— 停手")
    return len(a["photos"]), md5(raw)


def stage3_block(indent: str, vlm: bool, rubric: str, anchors: str) -> list[str]:
    return [
        f"{indent}{BLOCK_COMMENT}",
        f"{indent}stage3Vlm: {'true' if vlm else 'false'}",
        f"{indent}stage3RubricFile: {json.dumps(rubric, ensure_ascii=False)}",
        f"{indent}stage3AnchorsFile: {json.dumps(anchors, ensure_ascii=False)}",
    ]


def build_patch(base: str, indent: str, vlm: bool, rubric: str, anchors: str) -> str:
    m = re.search(r"^[ \t]*allowNeither:.*$", base, re.M)
    block = "".join("\n" + ln for ln in stage3_block(indent, vlm, rubric, anchors))
    return base[:m.end()] + block + base[m.end():]


def strip_block(text: str) -> str:
    """去掉插入的注释行和三个键；剩下的必须与源逐字节相同。"""
    keep = [ln for ln in text.split("\n")
            if ln.strip() != BLOCK_COMMENT and not re.match(r"^[ \t]*(stage3Vlm|stage3RubricFile|stage3AnchorsFile):", ln)]
    return "\n".join(keep)


def main() -> int:
    ap = argparse.ArgumentParser(description="生成第四轮端到端 A/B 的四份 web profile（dry-run，0 次付费调用）")
    ap.add_argument("--out-dir", type=Path, required=True)
    ap.add_argument("--rubric-file", type=Path, required=True)
    ap.add_argument("--anchors-file", type=Path, required=True)
    ap.add_argument("--src", type=Path, default=SRC, help="源 profile（只给验证脚本换成副本用）")
    ap.add_argument("--calib-dir", type=Path, default=CALIB, help="第三轮标定 spec 所在目录（只给验证脚本换成副本用）")
    args = ap.parse_args()

    out = args.out_dir.expanduser().resolve()
    profiles = PROFILES.resolve()
    if out == profiles or profiles in out.parents:
        raise SystemExit(f"dry-run：拒绝写进 {PROFILES}（部署是另一个决定）")

    patch = (args.src / "cordis.patch.yml").read_text(encoding="utf-8")
    pkg = (args.src / "package.json").read_text(encoding="utf-8")
    indent = check_source(patch, pkg)
    rubric_len, rubric_md5 = check_rubric(args.rubric_file, args.calib_dir)
    n_anchors, anchors_md5 = check_anchors(args.anchors_file, args.calib_dir)
    rubric_path = str(args.rubric_file.expanduser().resolve())
    anchors_path = str(args.anchors_file.expanduser().resolve())

    built = {}
    for group, (name, vlm, with_rubric, with_anchors) in GROUPS.items():
        rubric = rubric_path if with_rubric else ""
        anchors = anchors_path if with_anchors else ""
        p = build_patch(patch, indent, vlm, rubric, anchors)
        # 自检 1：去掉插入的那几行，与源逐字节相同 —— 阶段 2 配置和其余一切都没被动过
        if strip_block(p) != patch:
            raise SystemExit(f"{name}：去掉阶段 3 那几行后与 photo-v4 不同 —— 生成逻辑动到了别处，停手")
        # 自检 2：三个键各恰好一行，值与组别一致
        want = {"stage3Vlm": "true" if vlm else "false",
                "stage3RubricFile": json.dumps(rubric, ensure_ascii=False),
                "stage3AnchorsFile": json.dumps(anchors, ensure_ascii=False)}
        for key, val in want.items():
            found = lines_of(p, key)
            if len(found) != 1 or found[0][1].strip() != val:
                raise SystemExit(f"{name}：{key} 应当恰好一行且为 {val}，实际 {[f[1].strip() for f in found]} —— 停手")
        built[group] = (name, p, pkg.replace('"dsh-profile-photo-v4"', f'"dsh-profile-{name}"'))

    existing = [name for name, _, _ in built.values() if (out / name).exists()]
    if existing:
        raise SystemExit(f"{out} 下已经有 {existing}，不覆盖 —— 停手")
    for name, p, k in built.values():
        d = out / name
        d.mkdir(parents=True)
        (d / "cordis.patch.yml").write_text(p, encoding="utf-8")
        (d / "package.json").write_text(k, encoding="utf-8")
        for f in ("cordis.yml", "pnpm-workspace.yaml"):
            shutil.copy2(args.src / f, d / f)

    print(f"✅ 四份 profile 写到 {out}（dry-run）")
    print(f"   rubric {rubric_path}：{rubric_len} 字 · md5 {rubric_md5} · 与 calib-arm2 spec 逐字相同 · trim() 前后不变")
    print(f"   锚点 {anchors_path}：{n_anchors} 张 · md5 {anchors_md5} · 与 calib-arm3 spec 逐项相同 · 照片都找到")
    print(f"   源 {args.src}：patch md5 {md5(patch.encode('utf-8'))}")
    empty = json.dumps("")
    for group, (name, p, _) in built.items():
        vals = {key: lines_of(p, key)[0][1].strip() for key in STAGE3_KEYS}
        rubric_mark = "空" if vals["stage3RubricFile"] == empty else "有"
        anchors_mark = "空" if vals["stage3AnchorsFile"] == empty else "有"
        print(f"   {group:<2} {name:<16} stage3Vlm={vals['stage3Vlm']:<5} rubric={rubric_mark} 锚点={anchors_mark}"
              f" · patch md5 {md5(p.encode('utf-8'))}")
    print("   自检：去掉插入的几行后四份都与 photo-v4 逐字节相同；三个键各一行、值与组别一致")
    return 0


if __name__ == "__main__":
    sys.exit(main())
