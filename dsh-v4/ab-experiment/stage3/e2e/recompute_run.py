#!/usr/bin/env python3
"""拿运行记录把一次端到端运行**离线重算一遍**。0 次付费调用（只跑本机排序器）。

    python3 recompute_run.py --run <运行记录目录> --folder <本轮扫描目录> [--engine …] [--exclude …]

为什么要有这一步：交付名单、运行记录、摘要都长在 agent 的闭包里，测试只能覆盖到被想到的那些形态。
把两份裁决喂回排序器重算一遍，是**逐次运行**的核对 —— 每一次运行都自己证明一遍接线没断：

    ① 只带阶段 2 的裁决重算 → selected 必须逐张等于 run.json 的 delivered_after_stage2（交付₂）
    ② 再带上阶段 3 的裁决重算 → selected 必须逐张等于 delivered_final（交付₃）；A 组没有阶段 3 裁决，交付₃ = 交付₂
    ③ 两次重算的数据集指纹必须等于 run.json 记的那个 —— 指纹对不上说明候选池不是同一批（多半是排除清单不对）
    ④ 重算出的 stage3_plan_md5 必须等于 run.json 的 plan_md5，且等于按记下来的计划重算的 md5（修订 2.5）
    ⑤ run.json 的 comparisons + preflights 必须等于 calls.jsonl 里该 stage sent=true 的行数（修订 4.4）
    ⑥ 同一阶段 anchor_jpegs_sent 必须等于 anchor_photos_sent × 2（修订 4.6）
    ⑦ stage3-verdicts.json 的 plan / plan_md5 必须与 run.json 里的是同一份

几个必须说清的前提：
  · **必须带 --engine**：不带的话闭眼资格门不生效，名单会不一样（排序器会在 warnings 里明说，但结果已经不同了）
  · 排除清单默认从 preset 读（实验期临时加了 10 张锚点）。它不进运行记录，所以这里给错了只能靠 ③ 的指纹拦
  · 标注默认为空：这一轮的指令不调 set_my_favorites。真调了的话 ① 就会红，那时把 --labels 补上
  · 阶段 2 的 verdicts 文件就在运行记录里（修订 4.5 之后不再有按指纹命名的那份）

退出码：0 全对 · 2 有一条不成立（停，别往下跑）
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

HOME = Path.home()
PROFILE = HOME / ".dsh-v4/profiles/photo-v4/cordis.patch.yml"
PRESET = HOME / ".dsh-v4/.agent-presets/photo-filter-v4/agent.cordis.yml"
RANKER_DIR = HOME / "deepseek-harness/PhotoFilterAgent/ranker"
PYTHON = HOME / ".dsh-v4/ranker-venv/bin/python"


def plan_md5(pairs: list) -> str:
    return hashlib.md5(json.dumps(pairs, separators=(",", ":")).encode()).hexdigest()


def from_yaml(path: Path, key: str) -> str | None:
    """从 profile / preset 里取一个标量键。**不解析 YAML**：只认「缩进 + key: 值」这一种写法。"""
    m = re.search(rf"^[ \t]*{re.escape(key)}:[ \t]*(.+?)[ \t]*$", path.read_text(encoding="utf-8"), re.M)
    return m.group(1).strip().strip('"\'') if m else None


def preset_excludes(path: Path) -> list[str]:
    """preset 里 excludedRelativePaths 下面那串 `- "…"`。实验期临时加的 10 张锚点也在里面。"""
    text = path.read_text(encoding="utf-8")
    m = re.search(r"^([ \t]*)excludedRelativePaths:[ \t]*$", text, re.M)
    if not m:
        return []
    out = []
    for line in text[m.end():].splitlines()[1:]:
        item = re.match(r"^[ \t]*-[ \t]*(.+?)[ \t]*$", line)
        if item:
            out.append(item.group(1).strip().strip('"\''))
        elif line.strip() and not line.strip().startswith("#"):
            break
    return out


def run_pick(folder: str, target, style, engine: str, excludes: list[str], labels: Path | None,
             verdicts: Path | None, s3_verdicts: Path | None, python: Path, ranker_dir: Path,
             cache_dir: str) -> dict:
    """与 agent 的 Ranker.rank 同一条命令行（多一个 --json 落盘，少一个信号量）。"""
    with tempfile.TemporaryDirectory(prefix="recompute-") as td:
        out = Path(td) / "out.json"
        args = [str(python), "-m", "photofilter_rank.cli", "pick", folder,
                "--target", str(target), "--style", str(style), "--engine", engine]
        if excludes:
            args += ["--exclude", *excludes]
        if labels:
            args += ["--labels", str(labels)]
        if verdicts:
            args += ["--verdicts", str(verdicts)]
        if s3_verdicts:
            args += ["--stage3-verdicts", str(s3_verdicts)]
        args += ["--json", str(out)]
        env = {**os.environ, "PYTHONPATH": str(ranker_dir), "PHOTOFILTER_CACHE": cache_dir,
               "PYTHONWARNINGS": "ignore", "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"}
        p = subprocess.run(args, cwd=str(ranker_dir), capture_output=True, text=True, env=env)
        if p.returncode != 0:
            raise SystemExit(f"排序器退出码 {p.returncode}：{(p.stderr or p.stdout).strip().splitlines()[-1:]}")
        return json.loads(out.read_text(encoding="utf-8"))


def main() -> int:
    ap = argparse.ArgumentParser(description="用运行记录离线重算一次端到端运行（0 次付费调用）")
    ap.add_argument("--run", type=Path, required=True, help="运行记录目录 <workdir>/runs/<…>")
    ap.add_argument("--folder", required=True, help="本轮扫描目录（运行记录里没记，必须显式给）")
    ap.add_argument("--engine", help="本地分析引擎；默认取 photo-v4 profile 里的 engineBinary")
    ap.add_argument("--exclude", nargs="*", help="排除清单；默认取 preset 的 excludedRelativePaths")
    ap.add_argument("--labels", type=Path, help="标注清单（这一轮默认没有）")
    ap.add_argument("--python", type=Path, default=PYTHON)
    ap.add_argument("--ranker-dir", type=Path, default=RANKER_DIR)
    ap.add_argument("--cache-dir", help="默认取 photo-v4 profile 里的 cacheDir")
    a = ap.parse_args()

    run = json.loads((a.run / "run.json").read_text(encoding="utf-8"))
    calls = [json.loads(ln) for ln in (a.run / "calls.jsonl").read_text(encoding="utf-8").splitlines() if ln.strip()] \
        if (a.run / "calls.jsonl").exists() else []
    v2f = a.run / "stage2-verdicts.json"
    v3f = a.run / "stage3-verdicts.json"
    s2, s3 = run.get("stage2") or {}, run.get("stage3") or {}
    engine = a.engine or from_yaml(PROFILE, "engineBinary")
    cache = a.cache_dir or from_yaml(PROFILE, "cacheDir")
    excludes = a.exclude if a.exclude is not None else preset_excludes(PRESET)
    if not engine or not Path(engine).exists():
        raise SystemExit(f"没有可用的 --engine（{engine!r}）—— 不带引擎跑出来的名单和运行时不是一回事")

    print(f"运行记录 {a.run.name} · 指纹 {run.get('fingerprint')} · target {run.get('target')} · style {run.get('style')}")
    print(f"排除 {len(excludes)} 条（preset）· 引擎 {engine}")
    checks: list[tuple[str, bool, str]] = []

    def ck(name, ok, detail=""):
        checks.append((name, bool(ok), detail))

    # ⑤⑥⑦ 先做只读记录的三条：不用跑排序器
    for stage, rec in ((2, s2), (3, s3)):
        if "comparisons" in rec:
            want = (rec.get("comparisons") or 0) + (rec.get("preflights") or 0)
            got = sum(1 for c in calls if c.get("stage") == stage and c.get("sent"))
            ck(f"⑤ 阶段 {stage} 的调用账 = calls.jsonl 里 sent 的行数", want == got, f"run.json {want} vs 记录 {got}")
        ph, jp = rec.get("anchor_photos_sent"), rec.get("anchor_jpegs_sent")
        if ph is not None and jp is not None:
            ck(f"⑥ 阶段 {stage} 的锚点幅数 = 张数 × 2", jp == ph * 2, f"{jp} vs {ph}×2")
    plan = s3.get("plan") or []
    if plan and s3.get("plan_md5"):
        ck("④ run.json 的计划 md5 = 按记下来的计划重算", plan_md5([[x["a"], x["b"]] for x in plan]) == s3["plan_md5"])
    if v3f.exists():
        v3 = json.loads(v3f.read_text(encoding="utf-8"))
        ck("⑦ 裁决文件与 run.json 是同一份计划",
           v3.get("plan_md5") == s3.get("plan_md5") and (v3.get("plan") or []) == plan,
           f"裁决 {str(v3.get('plan_md5'))[:8]} vs run {str(s3.get('plan_md5'))[:8]}")

    # ①③④ 只带阶段 2 的裁决重算
    kw = dict(folder=a.folder, target=run.get("target"), style=run.get("style"), engine=engine,
              excludes=excludes, labels=a.labels, python=a.python, ranker_dir=a.ranker_dir, cache_dir=cache)
    try:
        r2 = run_pick(verdicts=v2f if v2f.exists() else None, s3_verdicts=None, **kw)
    except SystemExit as e:
        r2 = None
        ck("① 只带阶段 2 的裁决重算 = 交付₂", False, f"重算跑不起来：{e.code}")
    if r2 is not None:
        ck("③ 重算的数据集指纹 = run.json 记的那个", r2.get("fingerprint") == run.get("fingerprint"),
           f"{r2.get('fingerprint')} vs {run.get('fingerprint')}")
        ck("① 只带阶段 2 的裁决重算 = 交付₂", r2.get("selected") == run.get("delivered_after_stage2"),
           f"重算 {r2.get('selected')}\n        记录 {run.get('delivered_after_stage2')}")
        ck("④ 重算出的计划 md5 = run.json 的 plan_md5",
           (r2.get("notes") or {}).get("stage3_plan_md5") == s3.get("plan_md5"),
           f"{(r2.get('notes') or {}).get('stage3_plan_md5')} vs {s3.get('plan_md5')}")

    # ② 再带上阶段 3 的裁决
    if v3f.exists():
        try:
            r3 = run_pick(verdicts=v2f if v2f.exists() else None, s3_verdicts=v3f, **kw)
        except SystemExit as e:
            r3 = None
            ck("② 两份裁决一起重算 = 交付₃", False, f"重算跑不起来：{e.code}")
        if r3 is not None:
            ck("② 两份裁决一起重算 = 交付₃", r3.get("selected") == run.get("delivered_final"),
               f"重算 {r3.get('selected')}\n        记录 {run.get('delivered_final')}")
            ck("② 排序器确认应用了阶段 3 的裁决", (r3.get("notes") or {}).get("stage3_judge") == "replay"
               and (r3.get("notes") or {}).get("stage3") is not None)
    else:
        ck("② 没有阶段 3 裁决（阶段 3 关或未执行）→ 交付₃ 必须等于交付₂",
           run.get("delivered_final") == run.get("delivered_after_stage2"))

    for name, ok, detail in checks:
        print(f"{'✅' if ok else '❌'} {name}" + ("" if ok else f"  —— {detail}"))
    bad = sum(1 for _, ok, _ in checks if not ok)
    print(f"\n{len(checks) - bad}/{len(checks)} 项成立" + ("" if bad else " —— 这次运行的接线自己证明了一遍"))
    return 2 if bad else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit as e:
        if isinstance(e.code, str):
            print(f"❌ {e.code}", file=sys.stderr)
            sys.exit(2)
        raise
    except Exception:
        import traceback
        traceback.print_exc()
        print("❌ 重算脚本自己出错了 —— 核不了，当作停", file=sys.stderr)
        sys.exit(2)
