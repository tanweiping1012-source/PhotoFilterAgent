#!/usr/bin/env python3
"""make_e2e_profiles.py 的变异验证。0 次付费调用，不写 ~/.dsh-v4/profiles。

每个守卫都要亲眼看它变红一次，而且是**因为它自己**变红：崩溃（Traceback）不算，报错信息对不上也不算，
变红了却照样写出目录也不算。生成逻辑里的自检和「不写 profiles」守卫用「改生成器源码」来验：
先让它拦一次，再把守卫本身去掉、确认结果变成 exit 0 —— 证明是它拦的，不是别处碰巧拦的。
「不写 profiles」那条连验证本身也不碰真目录：变异副本把 PROFILES 指到临时目录。

用法：
  python3 validate_make_e2e_profiles.py --rubric-file <部署好的 rubric> --anchors-file <部署好的锚点>
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
GEN = HERE / "make_e2e_profiles.py"
HOME = Path.home()
SRC = HOME / ".dsh-v4/profiles/photo-v4"
CALIB = HOME / ".dsh-v4/photo-filter-v4/archive/round3-calibration"
NAMES = ("photo-v4-e2e-a", "photo-v4-e2e-b1", "photo-v4-e2e-b2", "photo-v4-e2e-b3")

# 生成器源码里的原文，变异按它们打。每条必须恰好出现一次，否则变异打偏了也看不出来
PROFILES_LINE = 'PROFILES = HOME / ".dsh-v4/profiles"\n'
PROFILES_GUARD = "    if inside and not args.deploy:   # 守卫：不写 profiles\n"
DEPLOY_GUARD = "    if args.deploy and out != profiles:   # 守卫：部署只认 profiles 根目录\n"
GUARD1 = "        if strip_block(p) != patch:\n"
GUARD2 = "            if len(found) != 1 or found[0][1].strip() != val:\n"
BUILD_RETURN = "    return base[:m.end()] + block + base[m.end():]\n"
FLIP_ALLOW = ("    out = base[:m.end()] + block + base[m.end():]\n"
              "    return out.replace('allowNeither: true', 'allowNeither: false') if vlm else out\n")
VLM_LINE = "        f\"{indent}stage3Vlm: {'true' if vlm else 'false'}\",\n"
VLM_ALWAYS_TRUE = "        f\"{indent}stage3Vlm: true\",\n"


def run(gen: Path, root: Path, out: Path, calib: Path = CALIB, extra=()) -> tuple[int, str]:
    p = subprocess.run([sys.executable, str(gen), "--src", str(root / "src"), "--out-dir", str(out),
                        "--rubric-file", str(root / "rubric.txt"), "--anchors-file", str(root / "anchors.json"),
                        "--calib-dir", str(calib), *extra], capture_output=True, text=True)
    return p.returncode, p.stdout + p.stderr


def last_line(out: str) -> str:
    lines = out.strip().splitlines()
    return lines[-1][:170] if lines else "(无输出)"


def setup(tmp: Path, tag: str, rubric: Path, anchors: Path) -> Path:
    root = tmp / tag
    root.mkdir()
    shutil.copytree(SRC, root / "src")
    shutil.copy2(rubric, root / "rubric.txt")
    shutil.copy2(anchors, root / "anchors.json")
    return root


def edit(path: Path, fn) -> bool:
    before = path.read_text(encoding="utf-8")
    after = fn(before)
    path.write_text(after, encoding="utf-8")
    return after != before


def mutant_gen(tmp: Path, tag: str, *replacements: tuple[str, str]) -> Path:
    src = GEN.read_text(encoding="utf-8")
    for needle, repl in replacements:
        n = src.count(needle)
        assert n == 1, f"变异「{tag}」打不准：生成器里 {needle!r} 出现 {n} 次（应为 1）—— 结构变了，先更新这个验证脚本"
        src = src.replace(needle, repl)
    path = tmp / f"gen-{tag}.py"
    path.write_text(src, encoding="utf-8")
    return path


def with_anchor_field(key: str, fn):
    """只改锚点 JSON 的一个字段（按结构改，不按文本替换 —— 同一个标签字样在 text 里也出现）。"""
    def apply(t: str) -> str:
        a = json.loads(t)
        a[key] = fn(a[key])
        return json.dumps(a, ensure_ascii=False, indent=2)
    return apply


def main() -> int:
    ap = argparse.ArgumentParser(description="make_e2e_profiles.py 的变异验证（0 次付费调用）")
    ap.add_argument("--rubric-file", type=Path, required=True)
    ap.add_argument("--anchors-file", type=Path, required=True)
    args = ap.parse_args()
    rows: list[tuple[str, bool, str]] = []

    def expect_red(name: str, rc: int, out: str, expect: str, out_dir: Path) -> None:
        crashed = "Traceback" in out
        wrote = any((out_dir / n).exists() for n in NAMES)
        ok = rc != 0 and not crashed and expect in out and not wrote
        rows.append((name, ok, f"exit {rc}" + ("，崩溃" if crashed else "") + ("，却写出了目录" if wrote else "")
                     + ("" if expect in out else f"，没出现「{expect}」") + f" | {last_line(out)}"))

    with tempfile.TemporaryDirectory(prefix="e2e-profiles-") as td:
        tmp = Path(td)

        # 干净运行：exit 0、四份目录齐全、去掉插入行后与源逐字节相同、值表与修订 2.10 一致
        root = setup(tmp, "clean", args.rubric_file, args.anchors_file)
        out = root / "out"
        rc, text = run(GEN, root, out)
        src_patch = (root / "src/cordis.patch.yml").read_text(encoding="utf-8")
        detail, ok = f"exit {rc}", rc == 0 and "Traceback" not in text
        if ok:
            want = {"photo-v4-e2e-a": ("false", False, False), "photo-v4-e2e-b1": ("true", False, False),
                    "photo-v4-e2e-b2": ("true", True, False), "photo-v4-e2e-b3": ("true", True, True)}
            rpath = json.dumps(str((root / "rubric.txt").resolve()), ensure_ascii=False)
            apath = json.dumps(str((root / "anchors.json").resolve()), ensure_ascii=False)
            for name, (vlm, r, a) in want.items():
                p = (out / name / "cordis.patch.yml").read_text(encoding="utf-8")
                kept = "\n".join(ln for ln in p.split("\n")
                                 if not ln.strip().startswith(("# 第四轮端到端", "stage3Vlm:", "stage3RubricFile:", "stage3AnchorsFile:")))
                vals = {k: [ln.split(":", 1)[1].strip() for ln in p.split("\n") if ln.strip().startswith(k + ":")]
                        for k in ("stage3Vlm", "stage3RubricFile", "stage3AnchorsFile")}
                others_same = all((out / name / f).read_bytes() == (root / "src" / f).read_bytes()
                                  for f in ("cordis.yml", "pnpm-workspace.yaml"))
                pkg = (out / name / "package.json").read_text(encoding="utf-8")
                pkg_ok = pkg == (root / "src/package.json").read_text(encoding="utf-8").replace('"dsh-profile-photo-v4"', f'"dsh-profile-{name}"')
                good = (kept == src_patch and vals["stage3Vlm"] == [vlm]
                        and vals["stage3RubricFile"] == [rpath if r else '""'] and vals["stage3AnchorsFile"] == [apath if a else '""']
                        and others_same and pkg_ok)
                ok = ok and good
                if not good:
                    detail += f"，{name} 不符 {vals} 其余文件相同={others_same} package 只改包名={pkg_ok}"
            detail += "，四份值表与修订 2.10 一致、去掉插入行后与源逐字节相同、package 只改包名" if ok else ""
        else:
            detail += f" | {last_line(text)}"
        rows.append(("干净运行", ok, detail))

        # 输入与源的守卫：每个一份新副本
        cases = [
            ("源 stage2Vlm 是 false", "src/cordis.patch.yml", lambda t: t.replace("stage2Vlm: true", "stage2Vlm: false"), "stage2Vlm 应当恰好一行且为 true"),
            ("源 allowNeither 缺失", "src/cordis.patch.yml", lambda t: t.replace("allowNeither: true", "# allowNeither 删掉了"), "allowNeither 应当恰好一行且为 true"),
            ("源已有 stage3Vlm", "src/cordis.patch.yml", lambda t: t.replace("stage2Vlm: true", "stage2Vlm: true\n        stage3Vlm: true"), "已经有 stage3Vlm"),
            ("源带 evalPairsFile", "src/cordis.patch.yml", lambda t: t.replace("defaultTarget: 20", "defaultTarget: 20\n        evalPairsFile: /x.json"), "已经有 evalPairsFile"),
            ("源 anchorsFile 缺失", "src/cordis.patch.yml", lambda t: "\n".join(l for l in t.split("\n") if not l.strip().startswith("anchorsFile:")), "非空的 anchorsFile"),
            ("源没关 tool-web", "src/cordis.patch.yml", lambda t: t.replace("- id: tool-web\n  disabled: true", "- id: tool-web\n  disabled: false"), "没关掉 ['tool-web']"),
            ("源 maxImagesPerMessage 20", "src/cordis.patch.yml", lambda t: t.replace("maxImagesPerMessage: 40", "maxImagesPerMessage: 20"), "maxImagesPerMessage 不是 40"),
            ("源包名不对", "src/package.json", lambda t: t.replace('"dsh-profile-photo-v4"', '"dsh-profile-other"'), "包名不是 dsh-profile-photo-v4"),
            ("源底座是 headless", "src/package.json", lambda t: t.replace("@deepseek-ai/dsh-web-app", "@deepseek-ai/dsh-headless"), "底座不是 web"),
            ("rubric 末尾多一个换行", "rubric.txt", lambda t: t + "\n", "首尾有空白"),
            ("rubric 改了一个字", "rubric.txt", lambda t: t.replace("闭眼", "闭嘴", 1), "不逐字相同"),
            ("锚点残留占位符", "anchors.json", lambda t: t.replace(str(Path(json.loads(t)["folder"]).parent), "@@PHOTOS@@", 1), "占位符"),
            ("锚点 folder 指到上一级", "anchors.json", with_anchor_field("folder", lambda v: str(Path(v).parent)), "['folder']"),
            ("锚点 text 改了一个字", "anchors.json", with_anchor_field("text", lambda v: v.replace("例1甲", "例1丙", 1)), "['text']"),
            ("锚点 photos 顺序换了", "anchors.json", with_anchor_field("photos", lambda v: v[1:] + v[:1]), "['photos']"),
            ("锚点 labels 改了一个", "anchors.json", with_anchor_field("labels", lambda v: {**v, next(iter(v)): "例1丙"}), "['labels']"),
        ]
        for i, (name, rel, fn, expect) in enumerate(cases):
            root = setup(tmp, f"case{i:02d}", args.rubric_file, args.anchors_file)
            if not edit(root / rel, fn):
                rows.append((name, False, "变异没改到任何东西 —— 变异本身坏了"))
                continue
            rc, text = run(GEN, root, root / "out")
            expect_red(name, rc, text, expect, root / "out")

        # 输出目录已有同名 profile → 拒绝，原有文件不动
        root = setup(tmp, "exists", args.rubric_file, args.anchors_file)
        out = root / "out"
        (out / NAMES[2]).mkdir(parents=True)
        (out / NAMES[2] / "marker").write_text("别人的", encoding="utf-8")
        rc, text = run(GEN, root, out)
        kept = (out / NAMES[2] / "marker").read_text(encoding="utf-8") == "别人的" and not (out / NAMES[0]).exists()
        rows.append(("目标已有同名目录 → 不覆盖", rc != 0 and "不覆盖" in text and kept and "Traceback" not in text,
                     f"exit {rc}" + ("" if kept else "，原有目录被动了或写出了别的组") + f" | {last_line(text)}"))

        # 锚点照片找不到：副本 calib 目录，把 folder 指到只放了 7 张（符号链接）的临时目录
        root = setup(tmp, "photo-missing", args.rubric_file, args.anchors_file)
        anchors = json.loads((root / "anchors.json").read_text(encoding="utf-8"))
        real = Path(anchors["folder"])
        fake_photos = tmp / "fake-photos"
        fake_photos.mkdir()
        for n in anchors["photos"][:7]:
            (fake_photos / n).symlink_to(next(real.rglob(n)))
        fake_calib = tmp / "fake-calib"
        fake_calib.mkdir()
        shutil.copy2(CALIB / "calib-arm2-rubric.json", fake_calib / "calib-arm2-rubric.json")
        spec3 = json.loads((CALIB / "calib-arm3-rubric-anchors.json").read_text(encoding="utf-8"))
        spec3["anchors"]["folder"] = str(fake_photos)
        (fake_calib / "calib-arm3-rubric-anchors.json").write_text(json.dumps(spec3, ensure_ascii=False), encoding="utf-8")
        anchors["folder"] = str(fake_photos)
        (root / "anchors.json").write_text(json.dumps(anchors, ensure_ascii=False), encoding="utf-8")
        rc, text = run(GEN, root, root / "out", calib=fake_calib)
        expect_red("锚点照片少一张", rc, text, "找不到或不唯一", root / "out")
        (fake_photos / anchors["photos"][7]).symlink_to(next(real.rglob(anchors["photos"][7])))
        rc, text = run(GEN, root, root / "out2", calib=fake_calib)
        rows.append(("对照：同一副本补上第 8 张 → 通过", rc == 0 and "Traceback" not in text, f"exit {rc} | {last_line(text)}"))

        # 「不写 profiles」守卫：变异副本把 PROFILES 指到临时目录，真目录一次都不碰
        fake_profiles = tmp / "fake-profiles"
        fake_profiles.mkdir()
        (tmp / "link-to-profiles").symlink_to(fake_profiles)
        point = (PROFILES_LINE, f"PROFILES = Path({str(fake_profiles)!r})\n")
        gen_fp = mutant_gen(tmp, "fake-profiles", point)
        for name, out_dir in (("输出目录在 profiles 下一层 → 拒绝", fake_profiles / "x"),
                              ("输出目录就是 profiles 本身 → 拒绝", fake_profiles),
                              ("输出目录经符号链接落进 profiles → 拒绝", tmp / "link-to-profiles" / "x")):
            root = setup(tmp, f"fp-{len(rows)}", args.rubric_file, args.anchors_file)
            rc, text = run(gen_fp, root, out_dir)
            wrote = any(fake_profiles.rglob("cordis.patch.yml"))
            rows.append((name, rc != 0 and "拒绝写进" in text and not wrote and "Traceback" not in text,
                         f"exit {rc}" + ("，profiles 下写出了东西" if wrote else "") + f" | {last_line(text)}"))
        # --deploy：只认 profiles 根目录本身；给对了就真写
        root = setup(tmp, f"fp-{len(rows)}", args.rubric_file, args.anchors_file)
        rc, text = run(gen_fp, root, fake_profiles / "sub", extra=["--deploy"])
        rows.append(("--deploy 指到 profiles 下面某一层 → 拒绝",
                     rc != 0 and "只能写" in text and not any(fake_profiles.rglob("cordis.patch.yml")) and "Traceback" not in text,
                     f"exit {rc} | {last_line(text)}"))
        root = setup(tmp, f"fp-{len(rows)}", args.rubric_file, args.anchors_file)
        rc, text = run(gen_fp, root, fake_profiles, extra=["--deploy"])
        deployed = all((fake_profiles / n / "cordis.patch.yml").exists() for n in NAMES)
        rows.append(("--deploy 指到 profiles 本身 → 四份都写出来、打印每个文件的 md5",
                     rc == 0 and deployed and "部署" in text and "md5" in text and "Traceback" not in text,
                     f"exit {rc}，四份齐全={deployed} | {last_line(text)}"))
        root = setup(tmp, f"fp-{len(rows)}", args.rubric_file, args.anchors_file)
        rc, text = run(gen_fp, root, fake_profiles, extra=["--deploy"])
        rows.append(("再部署一次 → 拒绝覆盖", rc != 0 and "不覆盖" in text and "Traceback" not in text,
                     f"exit {rc} | {last_line(text)}"))
        root = setup(tmp, f"fp-{len(rows)}", args.rubric_file, args.anchors_file)
        rc, text = run(mutant_gen(tmp, "no-deploy-guard", point, (DEPLOY_GUARD, "    if False:\n")),
                       root, fake_profiles / "sub2", extra=["--deploy"])
        rows.append(("去掉「部署只认根目录」守卫 → 写进了下面一层",
                     rc == 0 and (fake_profiles / "sub2" / NAMES[0] / "cordis.patch.yml").exists(),
                     f"exit {rc} | {last_line(text)}"))
        root = setup(tmp, f"fp-{len(rows)}", args.rubric_file, args.anchors_file)
        rc, text = run(mutant_gen(tmp, "no-profiles-guard", point, (PROFILES_GUARD, "    if False:\n")), root, fake_profiles / "y")
        wrote = (fake_profiles / "y" / NAMES[0] / "cordis.patch.yml").exists()
        rows.append(("去掉「不写 profiles」守卫 → 变 exit 0 且写进去了", rc == 0 and wrote and "Traceback" not in text,
                     f"exit {rc}，写进去了={wrote} | {last_line(text)}"))

        # 生成逻辑的两道自检：注入错误 → 红；再去掉守卫本身 → 变 exit 0（证明是它拦的）
        for name, reps, expect in (
            ("自检 1：B 组把 allowNeither 改成 false", [(BUILD_RETURN, FLIP_ALLOW)], "与 photo-v4 不同"),
            ("自检 2：A 组 stage3Vlm 写成 true", [(VLM_LINE, VLM_ALWAYS_TRUE)], "stage3Vlm 应当恰好一行且为 false"),
        ):
            root = setup(tmp, f"gen-{len(rows)}", args.rubric_file, args.anchors_file)
            rc, text = run(mutant_gen(tmp, f"m{len(rows)}", *reps), root, root / "out")
            expect_red(name, rc, text, expect, root / "out")
        for name, reps in (
            ("去掉自检 1 后同一错误 → 变 exit 0", [(BUILD_RETURN, FLIP_ALLOW), (GUARD1, "        if False:\n")]),
            ("去掉自检 2 后同一错误 → 变 exit 0", [(VLM_LINE, VLM_ALWAYS_TRUE), (GUARD2, "            if False:\n")]),
        ):
            root = setup(tmp, f"gen-{len(rows)}", args.rubric_file, args.anchors_file)
            rc, text = run(mutant_gen(tmp, f"m{len(rows)}", *reps), root, root / "out")
            rows.append((name, rc == 0 and "Traceback" not in text, f"exit {rc} | {last_line(text)}"))

    for name, ok, detail in rows:
        print(f"{'✅' if ok else '❌'} {name}  {detail}")
    bad = sum(1 for _, ok, _ in rows if not ok)
    print(f"\n{len(rows) - bad}/{len(rows)} 项通过")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
