#!/usr/bin/env python3
"""验 check_session_tools.py 的每一条规矩都能红、合规的是绿的。0 次调用。

    python validate_check_session_tools.py

不进 CI：会话文件是 zstd 压的，CI 的 Linux 上没有这台 Mac 的 /opt/homebrew/bin/zstd。
开跑前在本机跑一遍即可。退出码用 subprocess 直接拿，不经管道（管道会把 $? 换成 tail 的 0）。
"""
import json, subprocess, sys, tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
CHK = HERE / "check_session_tools.py"
ZSTD = "/opt/homebrew/bin/zstd"
ARCH = str(Path.home() / ".dsh-v4/photo-filter-v4/archive/round3-calibration")
tmp = Path(tempfile.mkdtemp(prefix="check-session-tools-"))


def session(name, calls):
    d = tmp / name
    d.mkdir()
    recs = [{"type": "session", "seq": 0},
            # 非工具记录里故意带上字面词：确认不会被当成调用
            {"type": "assistant/chunk", "data": {"text": "固定执行顺序：scan_folder → rank_photos；compare_within_groups 唯一花钱"}}]
    for i, (n, args) in enumerate(calls):
        recs.append({"type": "tool/call", "seq": i + 1,
                     "data": {"turn": 1, "step": i + 1, "name": n, "arguments": json.dumps(args, ensure_ascii=False)}})
    raw = "\n".join(json.dumps(r, ensure_ascii=False) for r in recs).encode()
    (d / "session.jsonl.zstd").write_bytes(
        subprocess.run([ZSTD, "-q", "-c"], input=raw, capture_output=True, check=True).stdout)
    return d


def run(script, d, mode, pairs):
    return subprocess.run([sys.executable, str(script), str(d), "--mode", mode, "--pairs", pairs, "--out-under", ARCH],
                          capture_output=True, text=True).returncode


GOOD = ("run_pair_eval", {"limit": 1, "pairs": "calib-arm1-none.json", "out": f"{ARCH}/arm1-smoke.json"})
FULL2 = ("run_pair_eval", {"pairs": "calib-arm2-rubric.json", "out": f"{ARCH}/arm2.json"})
CASES = [
    ("S1  合规冒烟（非工具记录里有字面词）", [GOOD], "smoke", "calib-arm1-none.json", 0),
    ("S2  多调了 compare_within_groups", [GOOD, ("compare_within_groups", {})], "smoke", "calib-arm1-none.json", 2),
    ("S3  多调了 run_instrument_check", [GOOD, ("run_instrument_check", {"phase": "probe"})], "smoke", "calib-arm1-none.json", 2),
    ("S4  多调了 rank_photos", [("rank_photos", {}), GOOD], "smoke", "calib-arm1-none.json", 2),
    ("S5  run_pair_eval 调了两次", [GOOD, GOOD], "smoke", "calib-arm1-none.json", 2),
    ("S6  冒烟没带 limit", [("run_pair_eval", {**GOOD[1], "limit": None})], "smoke", "calib-arm1-none.json", 2),
    ("S7  全量却带了 limit=1", [("run_pair_eval", {**FULL2[1], "limit": 1})], "full", "calib-arm2-rubric.json", 2),
    ("S8  第二遍漏传 pairs", [("run_pair_eval", {"out": f"{ARCH}/arm2.json"})], "full", "calib-arm2-rubric.json", 2),
    ("S9  out 落进 /tmp", [("run_pair_eval", {**FULL2[1], "out": "/tmp/claude-501/arm2.json"})], "full", "calib-arm2-rubric.json", 2),
    ("S10 一次 run_pair_eval 都没调", [], "smoke", "calib-arm1-none.json", 2),
    ("S11 多调了不花钱的 scan_folder", [("scan_folder", {"folder": "x"}), GOOD], "smoke", "calib-arm1-none.json", 1),
    ("S12 合规全量（第二遍）", [FULL2], "full", "calib-arm2-rubric.json", 0),
]


def main() -> int:
    bad = 0
    dirs = []
    for i, (label, calls, mode, pairs, want) in enumerate(CASES):
        d = session(f"s{i}", calls)
        dirs.append(d)
        rc = run(CHK, d, mode, pairs)
        bad += rc != want
        print(f"  {'✅' if rc == want else '❌'} {label:<30} 期望 {want} 实际 {rc}")
    # 变异：花钱清单改回「凭记忆写」—— S2/S3 必须从 2 掉下来，才能说明推导在起作用
    src = CHK.read_text(encoding="utf-8")
    needle = "    paid, every = paid_tools()\n"
    assert needle in src, "check_session_tools.py 结构变了，变异打不上 —— 先更新这个验证脚本"
    mut = tmp / "mutant.py"
    mut.write_text(src.replace(needle, "    paid, every = {'rank_photos', 'run_pair_eval'}, set()\n"), encoding="utf-8")
    for label, idx in (("S2", 1), ("S3", 2)):
        rc = run(mut, dirs[idx], "smoke", "calib-arm1-none.json")
        dropped = rc != 2
        bad += not dropped
        print(f"  {'✅' if dropped else '❌'} 变异「清单凭记忆写」下 {label} 退出码 {rc}（应当不再是 2）")
    print("全部符合期望" if not bad else f"❌ {bad} 条不符合")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
