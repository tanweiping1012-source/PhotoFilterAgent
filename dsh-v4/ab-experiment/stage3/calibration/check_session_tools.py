#!/usr/bin/env python3
"""冒烟 / 正式运行之后，核这次 headless 会话里 agent 实际调了哪些工具。0 次调用。

    python check_session_tools.py <session 目录> --mode smoke|full --pairs <考题文件名> --out-under <目录>

退出码：0 全对 · 1 只有不花钱的多余调用（警告）· 2 **停**（多花了钱，或者跑的不是该跑的那一遍）

几条规矩，每条都对着一个会静默多花钱或测错对象的方式：
  · 只看 type == "tool/call" 的记录，读 data.name。**不 grep 字面词** —— persona 文本里就写着
    「固定执行顺序 … rank_photos」，一个会话的非工具记录能命中十几次
  · 「会花钱的工具」清单**运行时从 agent-v4/src 里注册的工具推出来**（注册块里拿了 ctx.get('llm') 的就算），
    不凭记忆写。除 run_pair_eval 外出现一次就停
  · run_pair_eval 本身也要数：每次运行**正好 1 次**。多一次就是多一遍 19×2=38 次调用
  · 冒烟必须 limit=1；全量必须不带 limit
  · pairs 必须是这一遍的考题文件 —— 漏传的话会静默落回 evalPairsFile（第一遍），
    第二、三遍就等于把第一遍又跑了一次，处理变量被吃掉，而数字一切正常
  · out 必须在 archive 目录下，不许落进 /tmp
"""
import argparse, json, re, subprocess, sys
from collections import Counter
from pathlib import Path

ZSTD = "/opt/homebrew/bin/zstd"
SRC = Path.home() / "deepseek-harness/PhotoFilterAgent/agent-v4/src"


def paid_tools() -> tuple[set[str], set[str]]:
    """从注册块推「会花钱的工具」。注册块读不出 name、或一个花钱工具都推不出来，就停手。"""
    paid, every = set(), set()
    for f in sorted(SRC.glob("*.ts")):
        if f.name.endswith(".test.ts"):
            continue
        t = f.read_text(encoding="utf-8")
        starts = [m.start() for m in re.finditer(r"ctx\.tools\.register\(\s*defineTool\(", t)]
        for i, s in enumerate(starts):
            # 最后一个块会一直延到文件尾：多算只会多报，不会漏报 —— 往安全的方向错
            blk = t[s:(starts[i + 1] if i + 1 < len(starts) else len(t))]
            m = re.search(r"name:\s*'([^']+)'", blk)
            if not m:
                raise SystemExit(f"{f.name} 有一个注册块读不出 name —— 清单可能漏工具，停手")
            every.add(m.group(1))
            if "ctx.get('llm')" in blk:
                paid.add(m.group(1))
    if "run_pair_eval" not in paid:
        raise SystemExit(f"推出来的花钱清单里没有 run_pair_eval（{sorted(paid)}）—— 推导规则失效了，停手")
    return paid, every


def tool_calls(session: Path) -> list[tuple[str, dict]]:
    f = session / "session.jsonl.zstd" if session.is_dir() else session
    raw = subprocess.run([ZSTD, "-dc", str(f)], capture_output=True, check=True).stdout.decode("utf-8")
    out = []
    for ln in raw.splitlines():
        if not ln.strip():
            continue
        r = json.loads(ln)
        if r.get("type") != "tool/call":
            continue
        d = r.get("data") or {}
        a = d.get("arguments")
        try:
            args = json.loads(a) if isinstance(a, str) else (a or {})
        except json.JSONDecodeError:
            args = {"__unparsable__": a}
        out.append((d.get("name"), args))
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("session", type=Path)
    ap.add_argument("--mode", choices=["smoke", "full"], required=True)
    ap.add_argument("--pairs", required=True, help="这一遍的考题文件名，如 calib-arm2-rubric.json")
    ap.add_argument("--out-under", type=Path, required=True)
    a = ap.parse_args(argv)

    paid, every = paid_tools()
    calls = tool_calls(a.session)
    names = Counter(n for n, _ in calls)
    print(f"注册的工具 {len(every)} 个；推出来会花钱的 {sorted(paid)}")
    print(f"本会话 tool/call {len(calls)} 次：{dict(names)}")

    stop, warn = [], []
    other_paid = sorted({n for n in names if n in paid and n != "run_pair_eval"})
    if other_paid:
        stop.append(f"调了计划外的花钱工具 {other_paid}（各 {[names[n] for n in other_paid]} 次）")
    rpe = [args for n, args in calls if n == "run_pair_eval"]
    if len(rpe) != 1:
        stop.append(f"run_pair_eval 调了 {len(rpe)} 次，应当正好 1 次（多一次就是多 38 次调用）")
    for args in rpe:
        if "__unparsable__" in args:
            stop.append("run_pair_eval 的参数解析不出来，核不了 —— 停")
            continue
        lim = args.get("limit")
        if a.mode == "smoke" and lim != 1:
            stop.append(f"冒烟必须 limit=1，实际 limit={lim!r}")
        if a.mode == "full" and lim not in (None, 0):
            stop.append(f"全量不许带 limit，实际 limit={lim!r}")
        if args.get("pairs") != a.pairs:
            stop.append(f"pairs 应为 {a.pairs}，实际 {args.get('pairs')!r} —— 漏传会静默落回第一遍的考题")
        out = str(args.get("out") or "")
        root = str(a.out_under.expanduser().resolve())
        if not out or not str(Path(out).expanduser().resolve()).startswith(root + "/"):
            stop.append(f"out 应在 {root}/ 下，实际 {out!r}")
    free_extra = sorted({n for n in names if n not in paid})
    if free_extra:
        warn.append(f"另外调了不花钱的工具 {free_extra} —— 不多花钱，但说明 agent 没照提示词直接调")

    for s in stop:
        print(f"❌ {s}")
    for w in warn:
        print(f"⚠️ {w}")
    if stop:
        return 2
    if warn:
        return 1
    print("✅ 只调了 1 次 run_pair_eval，参数符合这一遍")
    return 0


if __name__ == "__main__":
    sys.exit(main())
