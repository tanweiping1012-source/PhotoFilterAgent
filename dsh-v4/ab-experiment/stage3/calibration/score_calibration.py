#!/usr/bin/env python3
"""判官能力标定的算分脚本。**在第一次付费调用之前提交**，跑完一个字不改。

    python score_calibration.py --spec <calib-armN.json> <结果文件> [--spec … <结果文件> …]

口径全部来自 CRITERIA-CALIBRATION.md，这里只做实现，不做新决定：

  §4① 答对率     平局与翻覆 = 未表态，**不计入分母，单独报**
                 报法一律 `k/n（95% CI a~b）（+ 未表态 N 局）`，不许只报百分比
  §3.5 / §6.2    **不做任何推断**：只报点估计与置信区间，不报 p 值，
                 不写「显著」「优于」「强于本地分」—— 脚本输出自带一道断言守着
  §5.2           理由里写明「按个人偏好判的」的局单独一栏
  §4 读法        不与 10/10 比，与人类自洽上限 9/10（n=10，粗估）并列摆出

winner 的取值语义以代码为准（compare.ts:392-393）：
  consistent ? abPick('a'|'b'|'neither') : (bothTie ? 'tie' : 'inconsistent')
  —— 'a'/'b' 一定是双向一致的；'tie' 是两次都**主动**答平局；'inconsistent' 是翻覆
     （含「给的码两张都不是」那种作废局）。

⚠️ 有一条判据没写到的，这里先按下面的办法处理，**等 owner 定**：
  NEITHER_POLICY  双向一致地答「两张都不够格」。它是表态，但不是「选出赢家」。
                  现按：计入「表态率」、**不计入答对率的分母**、单独一栏报。
"""
from __future__ import annotations

import argparse, json, math, re, sys
from pathlib import Path

N_EXPECTED = 19
HUMAN_CEILING = (9, 10)            # 抽查那 10 组里标注者与自己的精选一致 9/10
FORBIDDEN = re.compile(r"显著|p\s*值|p\s*[=<>]|优于|强于|更好地|打败")
PERSONAL_MARK = "个人偏好"


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return (float("nan"), float("nan"))
    p = k / n
    den = 1 + z * z / n
    c = (p + z * z / (2 * n)) / den
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return (max(0.0, c - h), min(1.0, c + h))


def fmt(k: int, n: int) -> str:
    if n == 0:
        return f"{k}/0（无法计算）"
    lo, hi = wilson(k, n)
    return f"{k}/{n}（95% CI {lo:.2f}~{hi:.2f}）"


def load_rows(path: Path) -> list[dict]:
    """接受 `{route, rows}` 整份 JSON，也接受逐对追加的 JSONL（每行一条带 winner 的记录）。"""
    text = path.read_text(encoding="utf-8")
    try:
        doc = json.loads(text)
        rows = doc["rows"] if isinstance(doc, dict) else doc
    except json.JSONDecodeError:
        rows = [json.loads(ln) for ln in text.splitlines() if ln.strip()]
    return [r for r in rows if isinstance(r, dict) and "winner" in r]


def score(spec: dict, rows: list[dict]) -> tuple[list[str], list[str]]:
    """返回 (报告行, 必须停下来查的问题)。问题非空时报告里的数一律不许引用。"""
    out: list[str] = []
    problems: list[str] = []

    # ── 守卫 1：结果必须恰好是这份 spec 的那 19 对，a/b 槽位也一致 ──
    want = [(p["a"], p["b"]) for p in spec["pairs"]]
    got = [(r.get("a"), r.get("b")) for r in rows]
    if len(rows) != N_EXPECTED:
        problems.append(f"结果有 {len(rows)} 对，判据是 {N_EXPECTED} 对")
    if sorted(got) != sorted(want):
        problems.append("结果里的对与 spec 不一致（拿错了文件，或者 a/b 槽位变了）")
    answer = {(p["a"], p["b"]): p["answer"] for p in spec["pairs"]}
    local_ok = {(p["a"], p["b"]): bool(p["local_correct"]) for p in spec["pairs"]}

    n = len(rows)
    cat = {"gold": 0, "other": 0, "neither": 0, "tie": 0, "inconsistent": 0}
    personal = {"gold": 0, "dir": 0, "n": 0}
    unknown = []
    for r in rows:
        w = r["winner"]
        key = (r.get("a"), r.get("b"))
        if w in ("a", "b"):
            hit = (w == answer.get(key))
            cat["gold" if hit else "other"] += 1
        elif w in cat:
            cat[w] += 1
        else:
            unknown.append(w)
        txt = f"{r.get('reason_ab') or r.get('reasonAb') or ''} {r.get('reason_ba') or r.get('reasonBa') or ''}"
        if PERSONAL_MARK in txt:
            personal["n"] += 1
            if w in ("a", "b"):
                personal["dir"] += 1
                personal["gold"] += int(w == answer.get(key))
    if unknown:
        problems.append(f"winner 出现未知取值：{sorted(set(unknown))}")

    directional = cat["gold"] + cat["other"]
    abstain = cat["tie"] + cat["inconsistent"]
    out.append(f"对数            {n}")
    out.append(f"有方向率        {fmt(directional, n)}    ← 本轮真正要的产出")
    out.append(f"答对率          {fmt(cat['gold'], directional)}（+ 未表态 {abstain} 局，+ 都不够格 {cat['neither']} 局）")
    out.append(f"  明细          金标赢 {cat['gold']} · 非金标赢 {cat['other']} · 都不够格 {cat['neither']}"
               f" · 主动平局 {cat['tie']} · 翻覆 {cat['inconsistent']}")
    out.append(f"表态率（含都不够格）{fmt(directional + cat['neither'], n)}")
    out.append(f"双向一致率      {fmt(sum(1 for r in rows if r.get('consistent')), n)}")

    # ── 守卫 2：没烧码时读码率一律无效 ──
    # compare.ts:367 `codeReadOk = !withCodes || …` —— 不烧码时每一对都是 true。
    has_codes = n > 0 and all(r.get("codeA") and r.get("codeB") for r in rows)
    if has_codes:
        ok = sum(1 for r in rows if r.get("codeReadOk") is True)
        out.append(f"读码率          {fmt(ok, n)}")
        out.append(f"contradiction   {sum(1 for r in rows if r.get('contradiction'))}/{n}")
    else:
        problems.append("结果行里没有 codeA/codeB —— 这一遍**没烧码**，读码率与 contradiction 无效"
                        "（不烧码时 codeReadOk 恒为 true，照抄会得到假的 100%）")
        out.append("读码率          无效：未烧码")

    out.append(f"按个人偏好判的  {personal['n']} 局（其中有方向 {personal['dir']}，选中金标 {personal['gold']}）")
    lk = sum(1 for p in spec["pairs"] if p["local_correct"])
    out.append(f"参照 · 本地分    {fmt(lk, len(spec['pairs']))}（同一批对，确定性，0 次调用）")
    hk, hn = HUMAN_CEILING
    out.append(f"参照 · 人类自洽  {fmt(hk, hn)}（抽查 10 组，粗估上限，n=10）")
    return out, problems


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("items", nargs="+", help="成对给出：--spec 文件 结果文件")
    ap.add_argument("--spec", action="append", required=True)
    a = ap.parse_args(argv)
    if len(a.spec) != len(a.items):
        raise SystemExit("--spec 与结果文件要一一对应")

    lines: list[str] = []
    bad = False
    for spec_path, res_path in zip(a.spec, a.items):
        spec = json.loads(Path(spec_path).read_text(encoding="utf-8"))
        arm = spec.get("_meta", {}).get("arm", Path(spec_path).stem)
        body, problems = score(spec, load_rows(Path(res_path)))
        lines.append(f"━━ {arm} ━━  结果 {Path(res_path).name}")
        lines += [f"  {x}" for x in body]
        if problems:
            bad = True
            lines += [f"  ❌ {x}" for x in problems]
            lines.append("  ⛔ 上面有问题：这一遍的数字一律不许引用，先停下来查")
        lines.append("")
    lines.append("只报点估计与 95% 置信区间（Wilson）。本轮不做推断。")
    text = "\n".join(lines)
    # 守卫 3：脚本自己的输出也不许出现推断性措辞
    m = FORBIDDEN.search(text)
    assert m is None, f"算分脚本的输出里出现了不许用的措辞：{m.group(0)!r}"
    print(text)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
