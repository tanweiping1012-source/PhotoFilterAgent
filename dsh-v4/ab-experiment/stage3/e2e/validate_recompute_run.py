#!/usr/bin/env python3
"""recompute_run.py 的变异验证。0 次付费调用，不碰真实运行记录，也不跑真排序器。

排序器换成 agent-v4/test-fixtures/fake-ranker（行为台用的那一个，按进程协议应答），
所以七项检查都能在几秒内逐条造错、逐条看它变红。

判红标准照旧：崩溃不算，退出码对不上不算；变异之后**原本变红的那条必须变绿**。
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "recompute_run.py"
REPO = HERE.parents[3]
FAKE_RANKER = REPO / "agent-v4/test-fixtures/fake-ranker"
POOL = [f"P{i:02d}.JPG" for i in range(1, 13)]
AFTER2 = ["P02.JPG", "P03.JPG", "P05.JPG", "P08.JPG"]     # 阶段 2 把 P01→P02、P07→P08
FINAL3 = ["P02.JPG", "P09.JPG", "P05.JPG", "P08.JPG"]     # 阶段 3 段 1 换人：P03→P09
PLAN = [{"segment": 1, "a": "P03.JPG", "b": "P09.JPG", "margin": 0.01},
        {"segment": 2, "a": "P08.JPG", "b": "P10.JPG", "margin": 0.02}]


def plan_md5(pairs):
    import hashlib
    return hashlib.md5(json.dumps(pairs, separators=(",", ":")).encode()).hexdigest()


MD5 = plan_md5([[x["a"], x["b"]] for x in PLAN])


def make_run(root: Path, name: str, *, group="B1", fingerprint="fakefp0000000001", after2=None, final3=None,
             run_md5=None, verdict_md5=None, s2_comparisons=6, s2_photos=10, s2_jpegs=None,
             with_s3=True, verdict_plan=None) -> Path:
    d = root / name
    d.mkdir(parents=True)
    after2 = AFTER2 if after2 is None else after2
    final3 = (FINAL3 if with_s3 else after2) if final3 is None else final3
    s3 = ({"status": "ran", "route": "mock", "plan": PLAN, "plan_md5": run_md5 or MD5,
           "comparisons": 4, "preflights": 1, "anchor_photos_sent": 0, "anchor_jpegs_sent": 0,
           "note": {"contests": 2, "swapped": 1, "missing": 0, "unused": 0, "kept_a": 1, "kept_tie": 0,
                    "kept_neither": 0, "kept_inconsistent": 0, "kept": 1, "refused_family_cap": 0}}
          if with_s3 else {"status": "off", "plan": PLAN, "plan_md5": run_md5 or MD5})
    run = {
        "run_id": name, "fingerprint": fingerprint, "started_at": "2026-09-20T10:00:00Z",
        "finished_at": "2026-09-20T10:10:00Z", "target": 4, "style": "quality",
        "config": {"stage2Vlm": True, "stage3Vlm": with_s3, "stage3RubricFile": "", "stage3AnchorsFile": "",
                   "rubricFile": "", "anchorsFile": "/x/a2.json", "allowNeither": True},
        "stage2": {"status": "ran", "route": "mock", "matches": 2, "anchor_photos_configured": 10,
                   "anchor_photos_sent": s2_photos,
                   "anchor_jpegs_sent": s2_photos * 2 if s2_jpegs is None else s2_jpegs,
                   "comparisons": s2_comparisons, "preflights": 1},
        "stage3_inputs": {"rubric_chars": 0, "rubric_md5": None, "anchor_photos_configured": 0} if with_s3 else None,
        "stage3": s3, "delivered_after_stage2": after2, "delivered_final": final3,
    }
    (d / "run.json").write_text(json.dumps(run, ensure_ascii=False, indent=1), encoding="utf-8")
    (d / "stage2-verdicts.json").write_text(json.dumps({
        "plan": [["P01.JPG", "P02.JPG"], ["P07.JPG", "P08.JPG"]], "route": "mock",
        "verdicts": [{"a": "P01.JPG", "b": "P02.JPG", "winner": "b"}, {"a": "P07.JPG", "b": "P08.JPG", "winner": "b"}],
    }, ensure_ascii=False), encoding="utf-8")
    if with_s3:
        (d / "stage3-verdicts.json").write_text(json.dumps({
            "plan_md5": verdict_md5 or run_md5 or MD5, "plan": verdict_plan or PLAN, "route": "mock",
            "verdicts": [{"a": "P03.JPG", "b": "P09.JPG", "winner": "b"},
                         {"a": "P08.JPG", "b": "P10.JPG", "winner": "a"}],
        }, ensure_ascii=False), encoding="utf-8")
    rows = [{"stage": 2, "kind": "preflight", "jpegs": 0, "sent": True, "ok": True}]
    rows += [{"stage": 2, "kind": "compare", "jpegs": 24, "sent": True, "ok": True} for _ in range(6)]
    if with_s3:
        rows += [{"stage": 3, "kind": "preflight", "jpegs": 0, "sent": True, "ok": True}]
        rows += [{"stage": 3, "kind": "compare", "jpegs": 4, "sent": True, "ok": True} for _ in range(4)]
    (d / "calls.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
    return d


def recompute(script: Path, run_dir: Path, engine: str, scen=None) -> tuple[int, str]:
    import os
    env = {**os.environ, "FAKE_SCEN": json.dumps(scen or {})}
    p = subprocess.run([sys.executable, str(script), "--run", str(run_dir), "--folder", "/photos",
                        "--engine", engine, "--exclude", "--python", sys.executable,
                        "--ranker-dir", str(FAKE_RANKER), "--cache-dir", "/tmp/fake-cache"],
                       capture_output=True, text=True, env=env)
    return p.returncode, p.stdout + p.stderr


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="recompute-val-"))
    engine = sys.executable                      # 引擎存在即可，假排序器不看它
    rows: list[tuple[str, bool, str]] = []

    def ck(name, ok, detail=""):
        rows.append((name, bool(ok), detail))

    rc, out = recompute(SCRIPT, make_run(tmp, "ok"), engine)
    ck("一致的运行记录 → 全绿", rc == 0 and "项成立" in out and "❌" not in out, out[-200:])
    rc, out = recompute(SCRIPT, make_run(tmp, "a-group", with_s3=False), engine)
    ck("A 组（没有阶段 3 裁决）→ 全绿，交付₃ = 交付₂", rc == 0 and "❌" not in out, out[-200:])

    cases = [
        ("交付₂ 记错 → ① 红", dict(name="bad-d2", after2=["P01.JPG", "P03.JPG", "P05.JPG", "P07.JPG"]), "① 只带阶段 2"),
        ("交付₃ 记错 → ② 红", dict(name="bad-d3", final3=["P02.JPG", "P03.JPG", "P05.JPG", "P08.JPG"]), "② 两份裁决"),
        ("数据集指纹记错 → ③ 红", dict(name="bad-fp", fingerprint="deadbeef"), "③ 重算的数据集指纹"),
        ("run.json 的计划 md5 与计划本身对不上 → ④ 红", dict(name="bad-md5", run_md5="a" * 32), "④ run.json 的计划 md5"),
        ("裁决文件与 run.json 不是同一份计划 → ⑦ 红", dict(name="bad-vmd5", verdict_md5="b" * 32), "⑦ 裁决文件"),
        ("裁决文件的计划被截短（md5 仍对）→ ⑦ 红，排序器看不出来", dict(name="bad-vplan", verdict_plan=PLAN[:1]), "⑦ 裁决文件"),
        ("调用账与调用记录对不上 → ⑤ 红", dict(name="bad-calls", s2_comparisons=5), "⑤ 阶段 2 的调用账"),
        ("锚点幅数 ≠ 张数 × 2 → ⑥ 红", dict(name="bad-jpegs", s2_jpegs=19), "⑥ 阶段 2 的锚点幅数"),
        ("A 组交付₃ ≠ 交付₂ → 红", dict(name="bad-a", with_s3=False, final3=["P09.JPG"]), "交付₃ 必须等于交付₂"),
    ]
    for label, kw, needle in cases:
        rc, out = recompute(SCRIPT, make_run(tmp, **kw), engine)
        line = next((l for l in out.splitlines() if l.startswith("❌") and needle in l), "")
        ck(label, rc == 2 and bool(line) and "Traceback" not in out, f"exit {rc} | {out.splitlines()[-1][:120]}")

    rc, out = recompute(SCRIPT, make_run(tmp, "no-engine"), str(tmp / "nope"))
    ck("--engine 指到不存在的文件 → 停手（不带引擎跑出来的名单不是一回事）",
       rc == 2 and "没有可用的 --engine" in out and "Traceback" not in out, f"exit {rc}")
    rc, out = recompute(SCRIPT, make_run(tmp, "ranker-fails"), engine, scen={"force_mismatch": True})
    ck("排序器非 0 退出（计划 md5 对不上）→ 停手并带上原因",
       rc == 2 and "排序器退出码 2" in out and "Traceback" not in out, f"exit {rc} | {out.splitlines()[-1][:120]}")

    src = SCRIPT.read_text(encoding="utf-8")
    MUT = [
        ("去掉「交付₂」比较", '    ck("① 只带阶段 2 的裁决重算 = 交付₂", r2.get("selected") == run.get("delivered_after_stage2"),',
         '    ck("① 只带阶段 2 的裁决重算 = 交付₂", True,', "bad-d2"),
        ("去掉「数据集指纹」比较", '    ck("③ 重算的数据集指纹 = run.json 记的那个", r2.get("fingerprint") == run.get("fingerprint"),',
         '    ck("③ 重算的数据集指纹 = run.json 记的那个", True,', "bad-fp"),
        ("去掉「调用账对账」", '            ck(f"⑤ 阶段 {stage} 的调用账 = calls.jsonl 里 sent 的行数", want == got,',
         '            ck(f"⑤ 阶段 {stage} 的调用账 = calls.jsonl 里 sent 的行数", True,', "bad-calls"),
        ("去掉「每张两幅」", '            ck(f"⑥ 阶段 {stage} 的锚点幅数 = 张数 × 2", jp == ph * 2,',
         '            ck(f"⑥ 阶段 {stage} 的锚点幅数 = 张数 × 2", True,', "bad-jpegs"),
        ("去掉「裁决文件与 run.json 同一份计划」", '        ck("⑦ 裁决文件与 run.json 是同一份计划",\n           v3.get("plan_md5") == s3.get("plan_md5") and (v3.get("plan") or []) == plan,',
         '        ck("⑦ 裁决文件与 run.json 是同一份计划", True,', "bad-vplan"),
        ("去掉「run.json 的计划 md5 自洽」", '        ck("④ run.json 的计划 md5 = 按记下来的计划重算", plan_md5([[x["a"], x["b"]] for x in plan]) == s3["plan_md5"])\n',
         "        pass\n", "bad-md5"),
        ("去掉「引擎必须存在」守卫", '    if not engine or not Path(engine).exists():\n', "    if False:\n", "no-engine"),
    ]
    for name, needle, repl, case in MUT:
        n = src.count(needle)
        if n != 1:
            ck(f"变异「{name}」打不准（原文 {n} 次）", False)
            continue
        mut = tmp / "mutant.py"
        mut.write_text(src.replace(needle, repl), encoding="utf-8")
        kw = next((dict(k) for l, k, _ in cases if k["name"] == case), {})
        kw.pop("name", None)
        needle_line = next((nd for l, k, nd in cases if k["name"] == case), "没有可用的 --engine")
        run_dir = make_run(tmp, f"mut-{case}", **kw)
        eng = str(tmp / "nope") if case == "no-engine" else engine
        rc, out = recompute(mut, run_dir, eng)
        # 几条检查会同时红（比如裁决 md5 不对时排序器也会拒），所以判据是「那一条 ❌ 消失」，不是退出码
        gone = not any(l.startswith("❌") and needle_line in l for l in out.splitlines())
        ck(f"变异「{name}」下 {case} 的那一条不再红", gone and "Traceback" not in out, f"exit {rc}")

    for name, ok, detail in rows:
        print(f"{'✅' if ok else '❌'} {name}" + ("" if ok else f"  —— {detail}"))
    bad = sum(1 for _, ok, _ in rows if not ok)
    print(f"\n{len(rows) - bad}/{len(rows)} 项通过")
    shutil.rmtree(tmp, ignore_errors=True)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
