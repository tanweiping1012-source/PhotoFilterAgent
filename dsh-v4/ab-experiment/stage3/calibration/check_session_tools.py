#!/usr/bin/env python3
"""冒烟 / 正式运行之后，核这次会话实际挂了哪个 preset、agent 实际调了哪些工具。0 次调用。

    python check_session_tools.py <session 目录> --mode smoke|full --pairs <考题文件名>
        --since <发起运行前记下的时间> --expect-out <这一遍归档的结果文件> --out-under <archive 目录>

退出码：0 全对 · 1 只有不花钱的多余调用（警告）· 2 **停**（多花了钱、跑的不是该跑的那一遍、核的不是这次的会话、
        挂错了 preset，或者**检查脚本自己出错了** —— 崩溃和 SystemExit("…") 默认也是 1，已统一改成 2）

几条规矩，每条都对着一个会静默多花钱、测错对象、或者核错东西的方式：
  · 会话实际挂的 preset 必须是 photo-filter-v4：取**最后一次** agent-preset/selected，一次都没选过才看头部的
    agentPreset（与 DSH 的 resolveSessionPreset 同一个口径）。web 会话按 settings 里的默认 preset 建 ——
    这台机器上是 cordis —— 要在会话还空着时切过去。cordis preset 自带 bash / read / write / glob / grep /
    subagent 这些工具，挂在会话层，profile 里写的 disabled 管不到（09-02 会话 7abc4612 的 request/header
    里就实际列着）。headless 会话头部没有 agentPreset，也停：标定只在 web 里跑
  · 只看 type == "tool/call" 的记录，读 data.name。**不 grep 字面词** —— persona 文本里就写着
    「固定执行顺序 … rank_photos」，一个会话的非工具记录能命中十几次
  · 「会花钱的工具」清单**运行时从 agent-v4/src 里注册的工具推出来**（注册块里拿了 ctx.get('llm') 的就算），
    不凭记忆写。除 run_pair_eval 外出现一次就停。清单之外的**任何**名字都至少警告 —— bash、read 这类一样；
    subagent 这种自己会花钱的也只是警告，因为它只出现在别的 preset 里，那种会话已经被上面 preset 那条停下
    ⚠️ 推导靠的是注册块里的**字面量** ctx.get('llm')：代码一改（比如取 services 包成 helper），
    清单可能悄悄漏工具 —— 所以被测代码每合并一次，都要先重跑 validate_check_session_tools.py
  · run_pair_eval 本身也要数：每次运行**正好 1 次**。多一次就是多一遍 19×2=38 次调用
  · 冒烟必须 limit=1；全量必须不带 limit
  · pairs 必须是这一遍的考题文件，**三遍都要显式传**（第一遍漏传虽然会落回同一个文件，也照样停）——
    漏传会静默落回 evalPairsFile（第一遍），第二、三遍就等于把第一遍又跑了一次
  · out 必须**就是**这一遍归档的那个结果文件，并且在 archive 目录下，不许落进 /tmp
  · 会话的最早一条记录不许早于 --since —— 检查只吃你给的路径，给错一个旧会话，照样可能报 0
"""
from __future__ import annotations   # ranker venv 是 Python 3.9：没有这行，`int | None` 注解在定义时就崩

import argparse, json, re, subprocess, sys, traceback
from collections import Counter
from datetime import datetime
from pathlib import Path

ZSTD = "/opt/homebrew/bin/zstd"
SRC = Path.home() / "deepseek-harness/PhotoFilterAgent/agent-v4/src"
PRESET = "photo-filter-v4"


def paid_tools() -> tuple[set[str], set[str]]:
    """从注册块推「会花钱的工具」。注册块读不出 name、或推出来的清单里没有 run_pair_eval，就停手。"""
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


def load_records(session: Path) -> list[dict]:
    f = session / "session.jsonl.zstd" if session.is_dir() else session
    raw = subprocess.run([ZSTD, "-dc", str(f)], capture_output=True, check=True).stdout.decode("utf-8")
    return [json.loads(ln) for ln in raw.splitlines() if ln.strip()]


def effective_preset(recs: list[dict]) -> tuple[str | None, str | None, list[str]]:
    """会话实际挂的 preset，与 DSH 的 resolveSessionPreset 同口径：最后一次 agent-preset/selected 说了算，
    一次都没选过才看头部。只看头部会把「按 cordis 建、再切过去」的正路判成停；
    只看第一次选择会放过「切过去又切回 cordis」。"""
    header = next((r for r in recs if r.get("type") == "session"), {})
    picks = [str((r.get("data") or {}).get("agentPreset"))
             for r in recs if r.get("type") == "agent-preset/selected"]
    effective = picks[-1] if picks else header.get("agentPreset")   # 守卫：最后一次选择说了算
    return effective, header.get("agentPreset"), picks


def tool_calls(recs: list[dict]) -> list[tuple[str, dict]]:
    out = []
    for r in recs:
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


def to_ms(s: str) -> int:
    return int(s) if s.isdigit() else int(datetime.fromisoformat(s).timestamp() * 1000)


def fmt_ms(ms: int | None) -> str:
    return datetime.fromtimestamp(ms / 1000).strftime("%Y-%m-%d %H:%M:%S") if ms is not None else "（无时间戳）"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("session", type=Path)
    ap.add_argument("--mode", choices=["smoke", "full"], required=True)
    ap.add_argument("--pairs", required=True, help="这一遍的考题文件名，如 calib-arm2-rubric.json")
    ap.add_argument("--since", required=True, help="发起这次运行之前记下的时间：ISO（2026-09-14T20:30:00）或 epoch 毫秒")
    ap.add_argument("--expect-out", type=Path, required=True, help="这一遍归档的结果文件")
    ap.add_argument("--out-under", type=Path, required=True)
    a = ap.parse_args(argv)

    paid, every = paid_tools()
    recs = load_records(a.session)
    times = [int(r["time"]) for r in recs if str(r.get("time", "")).isdigit()]
    t0, t1 = (min(times), max(times)) if times else (None, None)
    preset, header_preset, picks = effective_preset(recs)
    calls = tool_calls(recs)
    names = Counter(n for n, _ in calls)
    print(f"会话 {a.session.name} · {fmt_ms(t0)} → {fmt_ms(t1)} · 记录 {len(recs)} 条")
    print(f"preset：实际 {preset!r}（头部 {header_preset!r}，切换记录 {picks}）")
    print(f"注册的工具 {len(every)} 个；推出来会花钱的 {sorted(paid)}")
    print(f"本会话 tool/call {len(calls)} 次：{dict(names)}")

    stop, warn = [], []
    since_ms = to_ms(a.since)
    if t0 is None or t0 < since_ms:   # 守卫：会话时间
        stop.append(f"会话最早一条记录 {fmt_ms(t0)} 早于 --since {fmt_ms(since_ms)}（或没有时间戳）—— 这不是这次运行的会话")
    if preset != PRESET:   # 守卫：preset
        stop.append(f"会话实际挂的 preset 是 {preset!r}，应为 {PRESET!r} —— 别的 preset（比如默认的 cordis）"
                    f"自带 bash / read / write / subagent 这类工具，profile 管不到；headless 会话没有 preset，也不算")
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
            stop.append(f"pairs 应为 {a.pairs}，实际 {args.get('pairs')!r} —— 三遍都必须显式传；漏传会静默落回第一遍的考题")
        out = str(args.get("out") or "")
        out_res = Path(out).expanduser().resolve() if out else None
        if out_res is None or out_res != a.expect_out.expanduser().resolve():   # 守卫：结果文件
            stop.append(f"out 应就是归档的结果文件 {a.expect_out}，实际 {out!r}")
        root = str(a.out_under.expanduser().resolve())
        if out_res is None or not str(out_res).startswith(root + "/"):
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
    print("✅ 这是这次运行的会话，挂的是 photo-filter-v4，只调了 1 次 run_pair_eval，参数符合这一遍")
    return 0


if __name__ == "__main__":
    # 退出码 1 在这里的意思是「只有不花钱的多余调用，警告」。
    # 但 Python 自己崩了、或者 raise SystemExit("…") 时，默认退出码**也是 1** ——
    # 检查自己失效，会被读成「警告、可以继续」。所以统一改成 2：检查失效就是停。
    try:
        sys.exit(main())
    except SystemExit as e:
        if isinstance(e.code, str):
            print(f"❌ {e.code}", file=sys.stderr)
            sys.exit(2)
        raise
    except Exception:
        traceback.print_exc()
        print("❌ 检查脚本自己出错了 —— 核不了，当作停", file=sys.stderr)
        sys.exit(2)
