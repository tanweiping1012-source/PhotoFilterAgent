#!/usr/bin/env python3
"""make_calib_profile.py 的变异验证。0 次付费调用，不碰已部署的 profile。

每个守卫都要亲眼看它变红一次，而且是**因为它自己**变红：
崩溃（Traceback）不算抓到，报错信息对不上也不算，变红了却照样写出目标目录也不算。

做法：把已部署的 photo-v4-eval / photo-v4-eval-web 复制进临时目录，每个变异一份新副本，
注入一处毁坏，用 --profiles-dir 指向副本跑生成器。

干净运行的产物还要和已部署的 photo-v4-calib / photo-v4-calib-web 比：
逐字节一致最好；cordis.patch.yml **只允许注释行不同** —— web 版是 owner 手工建的，
注释措辞和生成器不同。这条比对规则本身也在下面变异（注释差异放行、实质差异拦下）。

用法：python3 validate_make_calib_profile.py [--deployed-dir ~/.dsh-v4/profiles]
"""
from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
GEN = HERE / "make_calib_profile.py"
PROFILES = Path.home() / ".dsh-v4/profiles"
EVAL, EVAL_WEB = "photo-v4-eval", "photo-v4-eval-web"
DST = {"headless": "photo-v4-calib", "web": "photo-v4-calib-web"}
FILES = ("cordis.patch.yml", "package.json", "cordis.yml", "pnpm-workspace.yaml")
PATCH, PKG = "cordis.patch.yml", "package.json"


def _after_key(key: str, line: str):
    """在 key: 那一行后面插一行，缩进跟它一样。"""
    return lambda t: re.sub(rf"^([ \t]*){key}:.*$", lambda m: f"{m.group(0)}\n{m.group(1)}{line}",
                            t, count=1, flags=re.M)


def _drop_disable(tool: str):
    return lambda t: re.sub(rf"^- id: {re.escape(tool)}\n  disabled: true\n?", "", t, flags=re.M)


# (名字, 变体, 改哪个源 profile, 改哪个文件, 怎么改, 输出里必须出现的话)
MUTANTS = [
    ("web：源里没有 stage2Vlm", "web", EVAL_WEB, PATCH,
     lambda t: re.sub(r"^[ \t]*stage2Vlm:.*\n", "", t, flags=re.M), "stage2Vlm: 应当恰好出现一次，实际 0 次"),
    ("web：源里 stage2Vlm 已经是 false", "web", EVAL_WEB, PATCH,
     lambda t: re.sub(r"(^[ \t]*stage2Vlm:)[ \t]*true", r"\1 false", t, flags=re.M), "预期 'true'"),
    ("web：源里有两行 stage2Vlm", "web", EVAL_WEB, PATCH,
     _after_key("stage2Vlm", "stage2Vlm: true"), "stage2Vlm: 应当恰好出现一次，实际 2 次"),
    ("web：源里已有 evalPairsDir", "web", EVAL_WEB, PATCH,
     _after_key("evalPairsFile", "evalPairsDir: /somewhere"), "已经有 evalPairsDir"),
    ("web：源 patch 带着 system-prompt persona", "web", EVAL_WEB, PATCH,
     lambda t: t + "\n- id: system-prompt\n  config:\n    persona: |-\n      占位\n", "不带 persona（web 用 preset 的）"),
    ("web：底座被换成 dsh-headless", "web", EVAL_WEB, PKG,
     lambda t: t.replace("@deepseek-ai/dsh-web-app", "@deepseek-ai/dsh-headless"),
     "web 变体要的是 @deepseek-ai/dsh-web-app"),
    ("web：两个底座都写了", "web", EVAL_WEB, PKG,
     lambda t: t.replace('"@deepseek-ai/dsh-web-app"', '"@deepseek-ai/dsh-web-app", "@deepseek-ai/dsh-headless"'),
     "web 变体要的是 @deepseek-ai/dsh-web-app"),
    ("web：包名不对", "web", EVAL_WEB, PKG,
     lambda t: t.replace('"dsh-profile-photo-v4-eval-web"', '"dsh-profile-something-else"'), "包名不是预期的"),
    ("web：少关了 tool-web", "web", EVAL_WEB, PATCH, _drop_disable("tool-web"), "缺 tool-web"),
    ("web：源 patch 里残留 /tmp/ 路径", "web", EVAL_WEB, PATCH,
     lambda t: t + "# 残留 /tmp/claude-501/x\n", "文件里没有 /tmp/ 路径"),
    ("headless：源里已有 stage2Vlm", "headless", EVAL, PATCH,
     _after_key("evalPairsFile", "stage2Vlm: false"), "已经有 stage2Vlm"),
    ("headless：源里已有 evalPairsDir", "headless", EVAL, PATCH,
     _after_key("evalPairsFile", "evalPairsDir: /somewhere"), "已经有 evalPairsDir"),
    ("headless：persona 段丢了", "headless", EVAL, PATCH,
     lambda t: t[:t.index("\n- id: system-prompt")] + "\n", "有 headless persona"),
    ("headless：底座被换成 dsh-web-app", "headless", EVAL, PKG,
     lambda t: t.replace("@deepseek-ai/dsh-headless", "@deepseek-ai/dsh-web-app"),
     "headless 变体要的是 @deepseek-ai/dsh-headless"),
    ("headless：少关了 tool-bash", "headless", EVAL, PATCH, _drop_disable("tool-bash"), "缺 tool-bash"),
]


def run(profiles: Path, variant: str, *extra: str) -> tuple[int, str]:
    p = subprocess.run([sys.executable, str(GEN), "--variant", variant, "--profiles-dir", str(profiles), *extra],
                       capture_output=True, text=True)
    return p.returncode, p.stdout + p.stderr


def fresh(tmp: Path, tag: str) -> Path:
    root = tmp / tag
    root.mkdir()
    for prof in (EVAL, EVAL_WEB):
        shutil.copytree(PROFILES / prof, root / prof)
    return root


def last_line(out: str) -> str:
    lines = out.strip().splitlines()
    return lines[-1][:160] if lines else "(无输出)"


def _code_lines(data: bytes) -> list[str]:
    return [ln for ln in data.decode("utf-8").splitlines() if not re.match(r"[ \t]*#", ln)]


def compare_deployed(mine: Path, deployed: Path) -> tuple[bool, str]:
    """逐字节一致最好；cordis.patch.yml 只允许注释行不同。其余任何差异都算不一致。"""
    bad, comment_only = [], []
    for f in FILES:
        if not (deployed / f).is_file():
            bad.append(f"{f}（已部署的没有这个文件）")
            continue
        a, b = (mine / f).read_bytes(), (deployed / f).read_bytes()
        if a == b:
            continue
        (comment_only if f == PATCH and _code_lines(a) == _code_lines(b) else bad).append(f)
    if bad:
        return False, f"与已部署的不一致（不止注释）：{', '.join(bad)}"
    if comment_only:
        return True, "与已部署的只差注释行"
    return True, "与已部署的逐字节一致"


def main() -> int:
    ap = argparse.ArgumentParser(description="make_calib_profile.py 的变异验证（0 次付费调用）")
    ap.add_argument("--deployed-dir", type=Path, default=PROFILES,
                    help="拿这个目录里的 photo-v4-calib / photo-v4-calib-web 当已部署的来比")
    args = ap.parse_args()
    if not GEN.is_file():
        raise SystemExit(f"找不到生成器：{GEN}")
    rows: list[tuple[str, bool, str]] = []
    with tempfile.TemporaryDirectory(prefix="calib-profile-mutants-") as td:
        tmp = Path(td)

        # 干净运行：必须过；已部署的话还要比（cordis.patch.yml 只允许注释不同）
        for variant in ("headless", "web"):
            root = fresh(tmp, f"clean-{variant}")
            rc, out = run(root, variant)
            ok = rc == 0 and "Traceback" not in out
            detail = f"exit {rc}"
            deployed = args.deployed_dir / DST[variant]
            if ok and deployed.is_dir():
                ok, note = compare_deployed(root / DST[variant], deployed)
                detail += f"，{note}"
            elif ok:
                detail += "，尚未部署，跳过比对"
            else:
                detail += f" | {last_line(out)}"
            rows.append((f"干净：{variant}", ok, detail))

        # 比对规则自己也要变红一次：拿干净的 web 产物当「已部署」，注入注释差异 / 实质差异
        base = tmp / "clean-web" / DST["web"]
        for i, (name, fname, fn, want) in enumerate([
            ("比对：只多一行注释 → 放行", PATCH,
             lambda t: t.replace("        evalPairsDir:", "        # 一行注释\n        evalPairsDir:", 1), True),
            ("比对：stage2Vlm 实质不同 → 拦下", PATCH,
             lambda t: re.sub(r"(^[ \t]*stage2Vlm:)[ \t]*false", r"\1 true", t, flags=re.M), False),
            ("比对：package.json 包名不同 → 拦下", PKG,
             lambda t: t.replace("photo-v4-calib-web", "photo-v4-other"), False),
        ]):
            if not base.is_dir():
                rows.append((name, False, "干净 web 没生成出来，比对变异跑不了"))
                continue
            copy = tmp / f"cmp{i}"
            shutil.copytree(base, copy)
            before = (copy / fname).read_text(encoding="utf-8")
            after = fn(before)
            if after == before:
                rows.append((name, False, "变异没改到任何东西 —— 变异本身坏了"))
                continue
            (copy / fname).write_text(after, encoding="utf-8")
            got, note = compare_deployed(base, copy)
            rows.append((name, got == want, note))

        # 变异：每个都必须因为它自己的守卫变红，且不写出目标目录
        for i, (name, variant, prof, fname, fn, expect) in enumerate(MUTANTS):
            root = fresh(tmp, f"m{i:02d}")
            path = root / prof / fname
            before = path.read_text(encoding="utf-8")
            after = fn(before)
            if after == before:
                rows.append((name, False, "变异没改到任何东西 —— 变异本身坏了"))
                continue
            path.write_text(after, encoding="utf-8")
            rc, out = run(root, variant)
            crashed = "Traceback" in out
            wrote = (root / DST[variant]).exists()
            ok = rc != 0 and not crashed and expect in out and not wrote
            detail = (f"exit {rc}" + ("，崩溃" if crashed else "") + ("，却写出了目标目录" if wrote else "")
                      + ("" if expect in out else f"，没出现「{expect}」") + f" | {last_line(out)}")
            rows.append((name, ok, detail))

        # 目标已存在：一致就不动；不一致默认拒绝且原文件不变；--overwrite 才重建
        root = fresh(tmp, "exists")
        target = root / DST["web"] / PATCH
        rc1, out1 = run(root, "web")
        stamp = target.stat().st_mtime_ns if target.exists() else None
        rc2, out2 = run(root, "web")
        same = stamp is not None and target.stat().st_mtime_ns == stamp
        rows.append(("已存在且一致 → 不动",
                     rc1 == 0 and rc2 == 0 and "没有改动" in out2 and same and "Traceback" not in out1 + out2,
                     f"exit {rc1}/{rc2}" + ("" if same else "，文件被重写了") + f" | {last_line(out2)}"))
        if target.exists():
            tampered = target.read_text(encoding="utf-8") + "# 别人加的一行\n"
            target.write_text(tampered, encoding="utf-8")
            rc3, out3 = run(root, "web")
            kept = target.read_text(encoding="utf-8") == tampered
            rows.append(("已存在且不同 → 拒绝覆盖",
                         rc3 != 0 and "不静默覆盖" in out3 and kept and "Traceback" not in out3,
                         f"exit {rc3}" + ("" if kept else "，别人那份被改掉了") + f" | {last_line(out3)}"))
            rc4, out4 = run(root, "web", "--overwrite")
            rebuilt = target.exists() and target.read_text(encoding="utf-8") != tampered
            rows.append(("--overwrite → 重建", rc4 == 0 and rebuilt and "Traceback" not in out4,
                         f"exit {rc4} | {last_line(out4)}"))
        else:
            rows.append(("已存在且不同 → 拒绝覆盖", False, "第一次生成就没写出目标，跑不了"))

    for name, ok, detail in rows:
        print(f"{'✅' if ok else '❌'} {name}  {detail}")
    bad = sum(1 for _, ok, _ in rows if not ok)
    print(f"\n{len(rows) - bad}/{len(rows)} 项通过")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
