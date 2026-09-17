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
S 系列是评测那两遍（run_pair_eval），R 系列是第四轮端到端那一遍（scan_folder + rank_photos）。
变异按**用例编号**指名，不按下标 —— 中间插一个用例就不会悄悄改成守着别的用例。

不进 CI：会话文件是 zstd 压的，CI 的 Linux 上没有这台 Mac 的 /opt/homebrew/bin/zstd。
退出码用 subprocess 直接拿，不经管道（管道会把 $? 换成 tail 的 0）。
"""
import json, subprocess, sys, tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
CHK = HERE / "check_session_tools.py"
ZSTD = "/opt/homebrew/bin/zstd"
ARCH = str(Path.home() / ".dsh-v4/photo-filter-v4/archive/round3-calibration")
FOLDER = str(Path.home() / "Desktop/照片测试/eval-people-309-acceptance")
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
        # args 给字符串就原样写进去 —— 造「参数解析不出来」的会话
        raw = args if isinstance(args, str) else json.dumps(args, ensure_ascii=False)
        recs.append({"type": "tool/call", "seq": len(recs),
                     "data": {"turn": 1, "step": i + 1, "name": n, "arguments": raw}})
    for j, r in enumerate(recs):
        if with_time:
            r["time"] = str(t + j * 1000)
    raw = "\n".join(json.dumps(r, ensure_ascii=False) for r in recs).encode()
    (d / "session.jsonl.zstd").write_bytes(
        subprocess.run([ZSTD, "-q", "-c"], input=raw, capture_output=True, check=True).stdout)
    return d


def run(script, d, extra):
    """返回 (退出码, 是否崩溃, 输出)。输出是 stdout + stderr —— SystemExit("…") 那类说明走的是 stderr。
    崩溃只看 stderr 里有没有 Traceback。"""
    r = subprocess.run([sys.executable, str(script), str(d), "--since", SINCE, *extra],
                       capture_output=True, text=True)
    return r.returncode, "Traceback" in r.stderr, r.stdout + r.stderr


A1, A2 = "calib-arm1-none.json", "calib-arm2-rubric.json"
O1, O2 = f"{ARCH}/arm1-smoke.json", f"{ARCH}/arm2.json"
GOOD = ("run_pair_eval", {"limit": 1, "pairs": A1, "out": O1})
FULL2 = ("run_pair_eval", {"pairs": A2, "out": O2})
SMOKE1 = ["--mode", "smoke", "--pairs", A1, "--expect-out", O1, "--out-under", ARCH]
FULL = ["--mode", "full", "--pairs", A2, "--expect-out", O2, "--out-under", ARCH]
RANK = ["--mode", "rank", "--folder", FOLDER]
SCAN = ("scan_folder", {"folder": FOLDER})
RANK20 = ("rank_photos", {"target": 20, "style": "quality"})
# cordis 这类 preset 在会话层自带的工具，名字取自真实会话 7abc4612 的 request/header
GENERIC = [("bash", {"command": "ls"}), ("read", {"path": "a"}), ("write", {"path": "b"}),
           ("glob", {"pattern": "*"}), ("grep", {"pattern": "x"}), ("subagent", {"prompt": "y"})]
# (标签, 调用, 命令行参数, 期望退出码, 会话参数)
CASES = [
    ("S1  合规冒烟（非工具记录里有字面词）", [GOOD], SMOKE1, 0, {}),
    ("S2  多调了 compare_within_groups", [GOOD, ("compare_within_groups", {})], SMOKE1, 2, {}),
    ("S3  多调了 run_instrument_check", [GOOD, ("run_instrument_check", {"phase": "probe"})], SMOKE1, 2, {}),
    ("S4  多调了 rank_photos", [("rank_photos", {}), GOOD], SMOKE1, 2, {}),
    ("S5  run_pair_eval 调了两次", [GOOD, GOOD], SMOKE1, 2, {}),
    ("S6  冒烟没带 limit", [("run_pair_eval", {**GOOD[1], "limit": None})], SMOKE1, 2, {}),
    ("S7  全量却带了 limit=1", [("run_pair_eval", {**FULL2[1], "limit": 1})], FULL, 2, {}),
    ("S8  第二遍漏传 pairs", [("run_pair_eval", {"out": O2})], FULL, 2, {}),
    ("S9  out 落进 /tmp", [("run_pair_eval", {**FULL2[1], "out": "/tmp/claude-501/arm2.json"})], FULL, 2, {}),
    ("S10 一次 run_pair_eval 都没调", [], SMOKE1, 2, {}),
    ("S11 多调了不花钱的 scan_folder", [SCAN, GOOD], SMOKE1, 1, {}),
    ("S12 合规全量（第二遍）", [FULL2], FULL, 0, {}),
    ("S13 拿错了一个旧会话（早于 --since）", [GOOD], SMOKE1, 2, {"t": NOW - 86_400_000}),
    ("S14 out 在 archive 下、但不是归档的那个文件", [("run_pair_eval", {**GOOD[1], "out": f"{ARCH}/arm1-old.json"})], SMOKE1, 2, {}),
    ("S15 会话里没有时间戳", [GOOD], SMOKE1, 2, {"with_time": False}),
    ("S16 第一遍漏传 pairs（落回同一文件也要停）", [("run_pair_eval", {"limit": 1, "out": O1})], SMOKE1, 2, {}),
    ("S18 web 正路：头部 cordis、切到 photo-filter-v4", [GOOD], SMOKE1, 0,
     {"header_preset": "cordis", "picks": ("photo-filter-v4",)}),
    ("S19 一直是 cordis（没切）", [GOOD], SMOKE1, 2, {"picks": ()}),
    ("S20 切到 photo-filter-v4 又切回 cordis", [GOOD], SMOKE1, 2, {"picks": ("photo-filter-v4", "cordis")}),
    ("S21 headless 会话（头部没有 preset、没选过）", [GOOD], SMOKE1, 2, {"header_preset": None, "picks": ()}),
    ("S22 头部直接就是 photo-filter-v4（默认值改过）", [GOOD], SMOKE1, 0,
     {"header_preset": "photo-filter-v4", "picks": ()}),
    ("S23 调了 bash / read / write / glob / grep / subagent", [*GENERIC, GOOD], SMOKE1, 1, {}),
    # ── 第四轮端到端：scan_folder 1 次 + rank_photos 1 次 ──────────────────
    ("R1  合规运行（显式 target/style）", [SCAN, RANK20], RANK, 0, {}),
    ("R2  合规运行（不给参数，用 profile 默认）", [SCAN, ("rank_photos", {})], RANK, 0, {}),
    ("R3  没调 scan_folder", [RANK20], RANK, 2, {}),
    ("R4  scan_folder 调了两次（跑完又扫一遍）", [SCAN, RANK20, SCAN], RANK, 2, {}),
    ("R5  rank_photos 调了两次", [SCAN, RANK20, RANK20], RANK, 2, {}),
    ("R6  顺序反了（先 rank_photos）", [RANK20, SCAN], RANK, 2, {}),
    ("R7  style 是 mood", [SCAN, ("rank_photos", {"target": 20, "style": "mood"})], RANK, 2, {}),
    ("R8  target 是 10", [SCAN, ("rank_photos", {"target": 10, "style": "quality"})], RANK, 2, {}),
    ("R9  扫描的不是本轮那个目录", [("scan_folder", {"folder": FOLDER + "/me-pick"}), RANK20], RANK, 2, {}),
    ("R10 多调了 compare_within_groups", [SCAN, RANK20, ("compare_within_groups", {})], RANK, 2, {}),
    ("R11 多调了 run_pair_eval", [SCAN, RANK20, GOOD], RANK, 2, {}),
    ("R12 多调了不花钱的 explain_ranking", [SCAN, RANK20, ("explain_ranking", {"ids": ["p001"]})], RANK, 1, {}),
    ("R13 会话挂的是 cordis", [SCAN, RANK20], RANK, 2, {"picks": ()}),
    ("R14 拿错了一个旧会话", [SCAN, RANK20], RANK, 2, {"t": NOW - 86_400_000}),
    ("R15 rank_photos 的参数解析不出来", [SCAN, ("rank_photos", "{坏 JSON")], RANK, 2, {}),
    ("R16 rank 模式却传了 --pairs", [SCAN, RANK20], RANK + ["--pairs", A1], 2, {}),
    ("R17 rank 模式没给 --folder", [SCAN, RANK20], ["--mode", "rank"], 2, {}),
    ("R18 smoke 模式没给 --pairs", [GOOD], ["--mode", "smoke", "--expect-out", O1, "--out-under", ARCH], 2, {}),
]
IDX = {label.split()[0]: i for i, (label, *_rest) in enumerate(CASES)}
# 这些用例还要看输出：退出码对不够，得确认确实走进了那一条
MUST_PRINT = {
    "S23": ["⚠️ 另外调了不花钱的工具", "'bash'", "'read'", "'write'", "'glob'", "'grep'", "'subagent'"],
    "R2": ["ℹ️ rank_photos 没显式给 style", "ℹ️ rank_photos 没显式给 target"],
    "R6": ["工具顺序应当是 scan_folder → rank_photos"],
    "R3": ["工具顺序应当是 scan_folder → rank_photos", "scan_folder 调了 0 次"],
    "R18": ["需要 --pairs"],
    "R12": ["⚠️ 另外调了不花钱的工具", "'explain_ranking'"],
}
EFFECTIVE = '    effective = picks[-1] if picks else header.get("agentPreset")   # 守卫：最后一次选择说了算\n'
COUNT_GUARD = "        if names[tool] != 1:   # 守卫：该调的工具各正好 1 次\n"
MUTANTS = [   # (名字, 原文, 替换, 结果应当变掉的用例编号)
    ("花钱清单凭记忆写（只有 rank_photos）", "    paid, every = paid_tools()\n",
     "    paid, every = {'rank_photos', 'run_pair_eval'}, set()\n", ("S2", "S3")),
    ("去掉会话时间守卫", "    if t0 is None or t0 < since_ms:   # 守卫：会话时间\n",
     "    if False:\n", ("S13", "R14")),
    ("去掉「out 就是归档文件」守卫",
     "            if out_res is None or out_res != a.expect_out.expanduser().resolve():   # 守卫：结果文件\n",
     "            if False:\n", ("S14",)),
    ("preset 只看头部", EFFECTIVE, '    effective = header.get("agentPreset")\n', ("S18",)),
    ("preset 只看第一次 selected", EFFECTIVE, '    effective = picks[0] if picks else header.get("agentPreset")\n', ("S20",)),
    ("去掉 preset 守卫", "    if preset != PRESET:   # 守卫：preset\n", "    if False:\n", ("S19", "S20", "S21", "R13")),
    ("去掉「各正好 1 次」守卫", COUNT_GUARD, "        if False:\n",
     ("S5", "R4", "R5", ("R3", "scan_folder 调了 0 次"))),
    ("去掉先扫描后排序守卫", "        if seq[:2] != [\"scan_folder\", \"rank_photos\"]:   # 守卫：先扫描后排序\n",
     "        if False:\n", ("R6", ("R3", "工具顺序应当是"))),
    ("去掉扫描目录守卫",
     "            if not got or Path(got).expanduser().resolve() != a.folder.expanduser().resolve():   # 守卫：扫描目录\n",
     "            if False:\n", ("R9",)),
    ("去掉 rank_photos 参数守卫", "                elif got != want:   # 守卫：rank_photos 参数\n",
     "                elif False:\n", ("R7", "R8")),
    ("该调的工具清单写死成评测那一遍",
     '    planned = ("scan_folder", "rank_photos") if a.mode == "rank" else ("run_pair_eval",)\n',
     '    planned = ("run_pair_eval",)\n', ("R1",)),
    ("参数没显式给也当成错", '                    note.append(f"rank_photos 没显式给 {key}',
     '                    stop.append(f"rank_photos 没显式给 {key}', ("R2",)),
    # 这两条守的是「说清楚哪里给串了」：少参数时退出码本来也是 2（后面的检查会响或直接崩），
    # 所以按「变异后那句话没了」判红；多参数那条则是实打实的 2 → 0
    ("去掉「模式缺参数」守卫", "    if miss:   # 守卫：模式与参数配套\n", "    if False and miss:\n",
     (("R18", "需要 --pairs"),)),
    ("去掉「模式多给参数」守卫", "    if extra:\n", "    if False and extra:\n", ("R16",)),
]


def main() -> int:
    bad = 0
    dirs = {}
    for i, (label, calls, extra, want, kw) in enumerate(CASES):
        tag = label.split()[0]
        d = session(f"s{i}", calls, **kw)
        dirs[tag] = d
        rc, crashed, out = run(CHK, d, extra)
        missing = [s for s in MUST_PRINT.get(tag, []) if s not in out]
        ok = rc == want and not crashed and not missing
        bad += not ok
        print(f"  {'✅' if ok else '❌'} {label:<40} 期望 {want} 实际 {rc}{'（崩溃）' if crashed else ''}"
              f"{f'（输出里缺 {missing}）' if missing else ''}")
    src = CHK.read_text(encoding="utf-8")
    for name, needle, repl, tags in MUTANTS:
        n = src.count(needle)
        assert n == 1, f"变异「{name}」打不准：原文出现 {n} 次（应为 1）—— check_session_tools.py 结构变了，先更新这个验证脚本"
        mut = tmp / "mutant.py"
        mut.write_text(src.replace(needle, repl), encoding="utf-8")
        for spec in tags:
            # 指名可以写成 (编号, 变异后应当消失的那句话) —— 有些守卫挡的是「说清楚」，退出码本来就一样
            tag, gone = spec if isinstance(spec, tuple) else (spec, None)
            label, calls, extra, want, kw = CASES[IDX[tag]]
            rc, crashed, out = run(mut, dirs[tag], extra)
            changed = (gone not in out if gone else rc != want) and not crashed
            why = f"输出里应当不再有「{gone}」" if gone else f"应当正常跑完且不再是 {want}"
            bad += not changed
            print(f"  {'✅' if changed else '❌'} 变异「{name}」下 {tag} 退出码 {rc}"
                  f"{'（崩溃，不算）' if crashed else ''}（{why}）")

    # 检查脚本自己失效（推导不出花钱清单 → raise SystemExit("…")）必须是 2，不能是 1
    broken = src.replace('SRC = Path.home() / "deepseek-harness/PhotoFilterAgent/agent-v4/src"',
                         'SRC = Path("/nonexistent-agent-src")')
    assert broken != src, "SRC 那一行变了，自失效用例打不上"
    m1 = tmp / "broken.py"; m1.write_text(broken, encoding="utf-8")
    rc, _, _ = run(m1, dirs["S1"], SMOKE1)
    bad += rc != 2
    print(f"  {'✅' if rc == 2 else '❌'} S17 检查脚本自己失效（推不出花钱清单）            期望 2 实际 {rc}")
    wrap = "    # 退出码 1 在这里的意思"
    assert wrap in broken, "__main__ 包装结构变了，先更新这个验证脚本"
    m2 = tmp / "broken-nowrap.py"
    m2.write_text(broken[:broken.index(wrap)] + "    sys.exit(main())\n", encoding="utf-8")
    rc, _, _ = run(m2, dirs["S1"], SMOKE1)
    bad += rc != 1
    print(f"  {'✅' if rc == 1 else '❌'} 变异「去掉 __main__ 包装」下 S17 退出码 {rc}（应当掉回 1 —— 证明包装在起作用）")
    print("全部符合期望" if not bad else f"❌ {bad} 条不符合")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
