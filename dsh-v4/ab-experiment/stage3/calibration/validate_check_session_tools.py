#!/usr/bin/env python3
"""验 check_session_tools.py 的每一条规矩都能红、合规的是绿的。0 次调用。

    python validate_check_session_tools.py

**被测代码每合并一次，开跑前都要重跑这个** —— 花钱清单靠注册块里的字面量 ctx.get('llm') 推，
代码一改清单可能悄悄漏工具，S2/S3 会变红，前提是有人重跑。

**用 ranker venv 的 python 跑**（3.9，和开跑时用的是同一个）—— 换成更新的 python 会漏掉 3.9 才有的崩溃。

每个用例都查 stderr 里有没有 Traceback：检查脚本崩溃的退出码若恰好等于期望值，
用例会**假通过**（第一次跑就这样：崩溃退出码 1 撞上了「警告」的 1）。变异也一样 ——
「结果变了」必须是**正常跑完**得出的，崩出来的不算。

造出来的会话默认是 **web 正路**，与真实会话 70e6731d 同形状：头部按默认 preset（cordis）建，
空白时一条 agent-preset/selected 切到 photo-filter-v4。preset 那条规矩的正反例在 S18–S22。

不进 CI：会话文件是 zstd 压的，CI 的 Linux 上没有这台 Mac 的 /opt/homebrew/bin/zstd。
退出码用 subprocess 直接拿，不经管道（管道会把 $? 换成 tail 的 0）。
"""
import json, subprocess, sys, tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
CHK = HERE / "check_session_tools.py"
ZSTD = "/opt/homebrew/bin/zstd"
ARCH = str(Path.home() / ".dsh-v4/photo-filter-v4/archive/round3-calibration")
NOW = 1_790_000_000_000                     # 造出来的「这次运行」的时间（epoch 毫秒）
SINCE = str(NOW - 60_000)                   # 发起运行前一分钟记下的时间
tmp = Path(tempfile.mkdtemp(prefix="check-session-tools-"))


def session(name, calls, t=NOW, with_time=True, header_preset="cordis", picks=("photo-filter-v4",)):
    d = tmp / name
    d.mkdir()
    header = {"type": "session", "seq": 0}
    if header_preset is not None:
        header["agentPreset"] = header_preset
    recs = [header]
    for p in picks:
        recs.append({"type": "agent-preset/selected", "seq": len(recs), "data": {"agentPreset": p}})
    # 非工具记录里故意带上字面词：确认不会被当成调用
    recs.append({"type": "assistant/chunk", "data": {"text": "固定执行顺序：scan_folder → rank_photos；compare_within_groups 唯一花钱"}})
    for i, (n, args) in enumerate(calls):
        recs.append({"type": "tool/call", "seq": len(recs),
                     "data": {"turn": 1, "step": i + 1, "name": n, "arguments": json.dumps(args, ensure_ascii=False)}})
    for j, r in enumerate(recs):
        if with_time:
            r["time"] = str(t + j * 1000)
    raw = "\n".join(json.dumps(r, ensure_ascii=False) for r in recs).encode()
    (d / "session.jsonl.zstd").write_bytes(
        subprocess.run([ZSTD, "-q", "-c"], input=raw, capture_output=True, check=True).stdout)
    return d


def run(script, d, mode, pairs, expect_out):
    """返回 (退出码, 是否崩溃, stdout)。崩溃 = stderr 里有 Traceback。"""
    r = subprocess.run([sys.executable, str(script), str(d), "--mode", mode, "--pairs", pairs,
                        "--since", SINCE, "--expect-out", expect_out, "--out-under", ARCH],
                       capture_output=True, text=True)
    return r.returncode, "Traceback" in r.stderr, r.stdout


A1, A2 = "calib-arm1-none.json", "calib-arm2-rubric.json"
O1, O2 = f"{ARCH}/arm1-smoke.json", f"{ARCH}/arm2.json"
GOOD = ("run_pair_eval", {"limit": 1, "pairs": A1, "out": O1})
FULL2 = ("run_pair_eval", {"pairs": A2, "out": O2})
# cordis 这类 preset 在会话层自带的工具，名字取自真实会话 7abc4612 的 request/header
GENERIC = [("bash", {"command": "ls"}), ("read", {"path": "a"}), ("write", {"path": "b"}),
           ("glob", {"pattern": "*"}), ("grep", {"pattern": "x"}), ("subagent", {"prompt": "y"})]
# (标签, 调用, 模式, pairs, expect_out, 期望退出码, 会话参数)
CASES = [
    ("S1  合规冒烟（非工具记录里有字面词）", [GOOD], "smoke", A1, O1, 0, {}),
    ("S2  多调了 compare_within_groups", [GOOD, ("compare_within_groups", {})], "smoke", A1, O1, 2, {}),
    ("S3  多调了 run_instrument_check", [GOOD, ("run_instrument_check", {"phase": "probe"})], "smoke", A1, O1, 2, {}),
    ("S4  多调了 rank_photos", [("rank_photos", {}), GOOD], "smoke", A1, O1, 2, {}),
    ("S5  run_pair_eval 调了两次", [GOOD, GOOD], "smoke", A1, O1, 2, {}),
    ("S6  冒烟没带 limit", [("run_pair_eval", {**GOOD[1], "limit": None})], "smoke", A1, O1, 2, {}),
    ("S7  全量却带了 limit=1", [("run_pair_eval", {**FULL2[1], "limit": 1})], "full", A2, O2, 2, {}),
    ("S8  第二遍漏传 pairs", [("run_pair_eval", {"out": O2})], "full", A2, O2, 2, {}),
    ("S9  out 落进 /tmp", [("run_pair_eval", {**FULL2[1], "out": "/tmp/claude-501/arm2.json"})], "full", A2, O2, 2, {}),
    ("S10 一次 run_pair_eval 都没调", [], "smoke", A1, O1, 2, {}),
    ("S11 多调了不花钱的 scan_folder", [("scan_folder", {"folder": "x"}), GOOD], "smoke", A1, O1, 1, {}),
    ("S12 合规全量（第二遍）", [FULL2], "full", A2, O2, 0, {}),
    ("S13 拿错了一个旧会话（早于 --since）", [GOOD], "smoke", A1, O1, 2, {"t": NOW - 86_400_000}),
    ("S14 out 在 archive 下、但不是归档的那个文件", [("run_pair_eval", {**GOOD[1], "out": f"{ARCH}/arm1-old.json"})], "smoke", A1, O1, 2, {}),
    ("S15 会话里没有时间戳", [GOOD], "smoke", A1, O1, 2, {"with_time": False}),
    ("S16 第一遍漏传 pairs（落回同一文件也要停）", [("run_pair_eval", {"limit": 1, "out": O1})], "smoke", A1, O1, 2, {}),
    ("S18 web 正路：头部 cordis、切到 photo-filter-v4", [GOOD], "smoke", A1, O1, 0,
     {"header_preset": "cordis", "picks": ("photo-filter-v4",)}),
    ("S19 一直是 cordis（没切）", [GOOD], "smoke", A1, O1, 2, {"picks": ()}),
    ("S20 切到 photo-filter-v4 又切回 cordis", [GOOD], "smoke", A1, O1, 2, {"picks": ("photo-filter-v4", "cordis")}),
    ("S21 headless 会话（头部没有 preset、没选过）", [GOOD], "smoke", A1, O1, 2, {"header_preset": None, "picks": ()}),
    ("S22 头部直接就是 photo-filter-v4（默认值改过）", [GOOD], "smoke", A1, O1, 0,
     {"header_preset": "photo-filter-v4", "picks": ()}),
    ("S23 调了 bash / read / write / glob / grep / subagent", [*GENERIC, GOOD], "smoke", A1, O1, 1, {}),
]
# 这些用例还要看输出：退出码 1 不够，得确认那几个名字确实走进了「警告」那一条
MUST_PRINT = {21: ["⚠️ 另外调了不花钱的工具", "'bash'", "'read'", "'write'", "'glob'", "'grep'", "'subagent'"]}
EFFECTIVE = '    effective = picks[-1] if picks else header.get("agentPreset")   # 守卫：最后一次选择说了算\n'
MUTANTS = [   # (名字, 原文, 替换, 结果应当变掉的用例下标)
    ("花钱清单凭记忆写（只有 rank_photos）", "    paid, every = paid_tools()\n",
     "    paid, every = {'rank_photos', 'run_pair_eval'}, set()\n", (1, 2)),
    ("去掉会话时间守卫", "    if t0 is None or t0 < since_ms:   # 守卫：会话时间\n",
     "    if False:\n", (12,)),
    ("去掉「out 就是归档文件」守卫",
     "        if out_res is None or out_res != a.expect_out.expanduser().resolve():   # 守卫：结果文件\n",
     "        if False:\n", (13,)),
    ("preset 只看头部", EFFECTIVE, '    effective = header.get("agentPreset")\n', (16,)),
    ("preset 只看第一次 selected", EFFECTIVE, '    effective = picks[0] if picks else header.get("agentPreset")\n', (18,)),
    ("去掉 preset 守卫", "    if preset != PRESET:   # 守卫：preset\n", "    if False:\n", (17, 18, 19)),
]


def main() -> int:
    bad = 0
    dirs = []
    for i, (label, calls, mode, pairs, eo, want, kw) in enumerate(CASES):
        d = session(f"s{i}", calls, **kw)
        dirs.append(d)
        rc, crashed, out = run(CHK, d, mode, pairs, eo)
        missing = [s for s in MUST_PRINT.get(i, []) if s not in out]
        ok = rc == want and not crashed and not missing
        bad += not ok
        print(f"  {'✅' if ok else '❌'} {label:<40} 期望 {want} 实际 {rc}{'（崩溃）' if crashed else ''}"
              f"{f'（输出里缺 {missing}）' if missing else ''}")
    src = CHK.read_text(encoding="utf-8")
    for name, needle, repl, idxs in MUTANTS:
        assert needle in src, f"变异「{name}」打不上 —— check_session_tools.py 结构变了，先更新这个验证脚本"
        mut = tmp / "mutant.py"
        mut.write_text(src.replace(needle, repl), encoding="utf-8")
        for idx in idxs:
            label, calls, mode, pairs, eo, want, kw = CASES[idx]
            rc, crashed, _ = run(mut, dirs[idx], mode, pairs, eo)
            changed = rc != want and not crashed
            bad += not changed
            print(f"  {'✅' if changed else '❌'} 变异「{name}」下 {label.split()[0]} 退出码 {rc}"
                  f"{'（崩溃，不算）' if crashed else ''}（应当正常跑完且不再是 {want}）")

    # 检查脚本自己失效（推导不出花钱清单 → raise SystemExit("…")）必须是 2，不能是 1
    broken = src.replace('SRC = Path.home() / "deepseek-harness/PhotoFilterAgent/agent-v4/src"',
                         'SRC = Path("/nonexistent-agent-src")')
    assert broken != src, "SRC 那一行变了，自失效用例打不上"
    m1 = tmp / "broken.py"; m1.write_text(broken, encoding="utf-8")
    rc, _, _ = run(m1, dirs[0], "smoke", A1, O1)
    bad += rc != 2
    print(f"  {'✅' if rc == 2 else '❌'} S17 检查脚本自己失效（推不出花钱清单）            期望 2 实际 {rc}")
    wrap = "    # 退出码 1 在这里的意思"
    assert wrap in broken, "__main__ 包装结构变了，先更新这个验证脚本"
    m2 = tmp / "broken-nowrap.py"
    m2.write_text(broken[:broken.index(wrap)] + "    sys.exit(main())\n", encoding="utf-8")
    rc, _, _ = run(m2, dirs[0], "smoke", A1, O1)
    bad += rc != 1
    print(f"  {'✅' if rc == 1 else '❌'} 变异「去掉 __main__ 包装」下 S17 退出码 {rc}（应当掉回 1 —— 证明包装在起作用）")
    print("全部符合期望" if not bad else f"❌ {bad} 条不符合")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
