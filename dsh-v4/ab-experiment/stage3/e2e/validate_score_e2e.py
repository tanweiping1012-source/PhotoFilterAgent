#!/usr/bin/env python3
"""score_e2e.py 的变异验证。0 次付费调用，不碰任何真实运行记录。

    python3 validate_score_e2e.py

造出来的运行记录用**冻结件**当骨架（duel-table.json 的 10 局计划 + pick-299-baseline 的 20 张交付），
所以每个数都能手算核对：基线命中 7/20，段 7 换人 +1，段 1/3/5/6/9 换人各 −1。

判红的标准和别处一样：崩溃不算，退出码对不上不算；变异之后**该变的字段必须真的变**。
算分脚本正常跑完都是退出码 0，所以用例断言的是 --json 里的字段，不是退出码。
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCORE = HERE / "score_e2e.py"
REPO = HERE.parents[3]
DUEL_TABLE = REPO / "dsh-v4/ab-experiment/stage3/duel-table.json"
BASELINE = REPO / "dsh-v4/ab-experiment/stage3/pick-299-baseline.json"
GOLD_FILE = REPO / "dsh-v4/eval-sets/eval-people-309-acceptance.gold.txt"
RUBRIC_MD5 = "e018ae40ec7aecaae30df81c4e49d033"

FROZEN = json.loads(DUEL_TABLE.read_text(encoding="utf-8"))
BASE = json.loads(BASELINE.read_text(encoding="utf-8"))
GOLD = {ln.strip() for ln in GOLD_FILE.read_text(encoding="utf-8").splitlines() if ln.strip()}
PLAN = [{"segment": x["seg"], "a": x["incumbent"], "b": x["challenger"],
         "margin": round(float(x["inc_score"]) - float(x["chal_score"]), 6)}
        for x in FROZEN["duels"] if x["challenger"]]
SELECTED = list(BASE["selected"])
SEG = {x["segment"]: x for x in PLAN}
UP_SEG = FROZEN["reach"]["up"][0]              # 段 7：挑战者是金标
DOWN_SEG = FROZEN["reach"]["down"][0]          # 段 1：在位是金标


def plan_md5(pairs):
    import hashlib
    return hashlib.md5(json.dumps(pairs, separators=(",", ":")).encode()).hexdigest()


def make_run(root: Path, name: str, group: str, outcomes=None, *, reverse=(), stage2="ran",
             stage3_status=None, note_extra=None, rubric_md5=RUBRIC_MD5, anchor_photos=None,
             s3_jpegs=None, plan=None, plan_md5_override=None, verdict_plan_override=None,
             delivered_final=None, s2_anchor_photos=10, s3_anchor_photos=None,
             s2_jpegs_sent=None, drop_calls=0):
    """造一份运行记录。outcomes: {段号: winner}，缺省判擂主赢（'a'）。"""
    d = root / name
    d.mkdir(parents=True)
    plan = PLAN if plan is None else plan
    outcomes = outcomes or {}
    md5 = plan_md5_override or plan_md5([[x["a"], x["b"]] for x in plan])
    want_rubric = group in ("B2", "B3")
    want_anchors = group == "B3"
    verdicts, note = [], {k: 0 for k in ("swapped", "missing", "refused_family_cap",
                                         "kept_a", "kept_tie", "kept_neither", "kept_inconsistent")}
    final = list(SELECTED)
    for row in plan:
        w = outcomes.get(row["segment"], "a")
        if w == "b":
            final[final.index(row["a"])] = row["b"]
            note["swapped"] += 1
        else:
            note["kept_" + w] += 1
        a, b, wr = row["a"], row["b"], w
        if row["segment"] in reverse:                       # 反向键：甲乙对调，答案跟着翻
            a, b = b, a
            wr = {"a": "b", "b": "a"}.get(w, w)
        verdicts.append({"a": a, "b": b, "winner": wr, "consistent": wr in ("a", "b", "neither"),
                         "ab": "JIA", "ba": "YI", "reason_ab": "mock", "reason_ba": "mock",
                         "code_a": "1111", "code_b": "2222", "code_read_ok": True, "contradiction": False})
    note["kept"] = sum(note["kept_" + k] for k in ("a", "tie", "neither", "inconsistent"))
    note["unused"] = 0
    note.update(note_extra or {})
    final = delivered_final if delivered_final is not None else final
    status = stage3_status or ("off" if group == "A" else "ran")
    # 修订 4.6：张数与幅数分开记；修订 4.3：B3 实发 8 张，A/B1/B2 为 0
    s3_photos = (8 if want_anchors else 0) if s3_anchor_photos is None else s3_anchor_photos
    # 修订 4.5：A 组（阶段 3 关）也记计划与 plan_md5
    s3 = ({"status": "off", "plan": plan, "plan_md5": md5} if group == "A"
          else {"status": status, "error": "mock 失败", "plan": plan, "plan_md5": md5,
                "comparisons": 0, "preflights": 0} if status == "failed"
          else {"status": status, "route": "mock/mock-vision", "plan": plan, "plan_md5": md5,
                "comparisons": 2 * len(plan), "preflights": 1,
                "anchor_photos_sent": s3_photos, "anchor_jpegs_sent": s3_photos * 2, "note": note})
    run = {
        "run_id": name, "fingerprint": "5e9947ea9eae8391",
        "started_at": f"2026-09-20T10:{sum(map(ord, name)) % 60:02d}:00.000Z",
        "finished_at": "2026-09-20T10:30:00.000Z", "target": 20, "style": "quality",
        "config": {"stage2Vlm": True, "rubricFile": "/x/rubric2.txt", "anchorsFile": "/x/anchors2.json",
                   "allowNeither": True, "stage3Vlm": group != "A",
                   "stage3RubricFile": "/x/rubric3.txt" if want_rubric else "",
                   "stage3AnchorsFile": "/x/anchors3.json" if want_anchors else ""},
        "stage2": {
            "status": "failed" if stage2 == "failed" else stage2,
            **({"error": "mock 阶段 2 失败"} if stage2 == "failed" else {"route": "mock/mock-vision", "matches": 3}),
            "anchor_photos_configured": 10, "anchor_photos_sent": s2_anchor_photos,
            "anchor_jpegs_sent": s2_anchor_photos * 2 if s2_jpegs_sent is None else s2_jpegs_sent,
            "comparisons": 6 - drop_calls, "preflights": 1,
        },
        "stage3_inputs": None if group == "A" else {
            "rubric_chars": 1154 if want_rubric else 0,
            "rubric_md5": rubric_md5 if want_rubric else None,
            "anchor_photos_configured": (8 if want_anchors else 0) if anchor_photos is None else anchor_photos},
        "stage3": s3,
        "delivered_after_stage2": SELECTED,
        "delivered_final": SELECTED if group == "A" else final,
    }
    (d / "run.json").write_text(json.dumps(run, ensure_ascii=False, indent=1), encoding="utf-8")
    rows = [{"stage": 2, "ts": 1, "elapsed_ms": 10, "route": "mock/mock-vision", "kind": "preflight",
             "i": 0, "dir": None, "a": None, "b": None, "jpegs": 0, "sent": True, "ok": True}]
    for i in range(3):                                   # 阶段 2：3 局 × 2 次
        for dr in ("AB", "BA"):
            rows.append({"stage": 2, "ts": 1, "elapsed_ms": 10, "route": "mock/mock-vision", "kind": "compare",
                         "i": i, "dir": dr, "a": "x.JPG", "b": "y.JPG", "jpegs": 24, "sent": True, "ok": True})
    if group != "A" and status != "failed":
        rows.append({"stage": 3, "ts": 1, "elapsed_ms": 10, "route": "mock/mock-vision", "kind": "preflight",
                     "i": 0, "dir": None, "a": None, "b": None, "jpegs": 0, "sent": True, "ok": True})
        jp = s3_jpegs if s3_jpegs is not None else (20 if want_anchors else 4)
        for i, row in enumerate(plan):
            for dr in ("AB", "BA"):
                rows.append({"stage": 3, "ts": 1, "elapsed_ms": 10, "route": "mock/mock-vision", "kind": "compare",
                             "i": i, "dir": dr, "a": row["a"], "b": row["b"], "jpegs": jp, "sent": True, "ok": True})
    (d / "calls.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")
    if group != "A" and status != "failed":
        (d / "stage3-verdicts.json").write_text(json.dumps(
            {"plan_md5": md5, "plan": verdict_plan_override if verdict_plan_override is not None else plan,
             "route": "mock/mock-vision", "verdicts": verdicts}, ensure_ascii=False, indent=1), encoding="utf-8")
    return d


def score(script: Path, dirs, gold=GOLD_FILE):
    out_json = Path(tempfile.mkdtemp(prefix="score-")) / "out.json"
    # 冻结件的路径显式给：变异副本放在临时目录里，按 __file__ 往上推会推错
    p = subprocess.run([sys.executable, str(script), "--runs", *[str(x) for x in dirs],
                        "--gold", str(gold), "--duel-table", str(DUEL_TABLE), "--baseline", str(BASELINE),
                        "--json", str(out_json)], capture_output=True, text=True)
    data = json.loads(out_json.read_text(encoding="utf-8")) if out_json.exists() else None
    return p.returncode, p.stdout + p.stderr, {x["dir"]: x for x in data} if data else {}


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="score-e2e-"))
    runs = {}
    runs["a1"] = make_run(tmp, "a1", "A")
    runs["b1-up"] = make_run(tmp, "b1-up", "B1", {UP_SEG: "b"})
    runs["b1-down"] = make_run(tmp, "b1-down", "B1", {DOWN_SEG: "b"})
    runs["b2-mix"] = make_run(tmp, "b2-mix", "B2",
                              {UP_SEG: "b", DOWN_SEG: "tie", 3: "neither", 5: "inconsistent", 6: "a", 9: "b"},
                              reverse=(6,))
    runs["b3-ok"] = make_run(tmp, "b3-ok", "B3", {UP_SEG: "b"})
    runs["v-s2fail"] = make_run(tmp, "v-s2fail", "B1", stage2="failed")
    runs["v-s3fail"] = make_run(tmp, "v-s3fail", "B1", stage3_status="failed")
    runs["v-missing"] = make_run(tmp, "v-missing", "B1", note_extra={"missing": 2})
    runs["v-unused"] = make_run(tmp, "v-unused", "B1", note_extra={"unused": 1})
    runs["v-rubric"] = make_run(tmp, "v-rubric", "B2", rubric_md5="0" * 32)
    runs["v-anchors"] = make_run(tmp, "v-anchors", "B3", anchor_photos=7, s3_anchor_photos=7)
    runs["v-s2anchor"] = make_run(tmp, "v-s2anchor", "B1", s2_anchor_photos=0)
    runs["v-md5"] = make_run(tmp, "v-md5", "B1", plan_md5_override="a" * 32)
    runs["v-vplan"] = make_run(tmp, "v-vplan", "B1", verdict_plan_override=PLAN[:5])
    runs["v-callcount"] = make_run(tmp, "v-callcount", "B1", drop_calls=1)        # run.json 少记一次调用
    runs["v-jpegs"] = make_run(tmp, "v-jpegs", "B1", s2_jpegs_sent=19)            # 幅数 ≠ 张数 × 2
    runs["v-s3anchor"] = make_run(tmp, "v-s3anchor", "B3", s3_anchor_photos=7)    # B3 实发只有 7 张
    runs["jpegs"] = make_run(tmp, "jpegs", "B1", {UP_SEG: "b"}, s3_jpegs=3)
    shifted = [dict(x) for x in PLAN]
    shifted[0] = {**shifted[0], "segment": 99}          # 同一对挪到别的段号
    runs["plan-shift"] = make_run(tmp, "plan-shift", "B1", plan=shifted)

    rc, out, S = score(SCORE, runs.values())
    checks = []

    def ck(name, cond, detail=""):
        checks.append((name, bool(cond), detail))

    ck("正常跑完、每个 run 都算出来了", rc == 0 and len(S) == len(runs) and "Traceback" not in out, f"exit {rc}")
    a1, up, down, mix, b3 = S.get("a1", {}), S.get("b1-up", {}), S.get("b1-down", {}), S.get("b2-mix", {}), S.get("b3-ok", {})
    ck("A 组：组别 A、无作废、交付₃ 命中 7、净变化 0",
       a1.get("group") == "A" and not a1.get("void") and a1.get("overlap3") == 7 and a1.get("net") == 0, json.dumps(a1.get("void")))
    ck("B1 段 7 换人：交付₂ 7 → 交付₃ 8，净变化 +1，换上的是金标",
       up.get("overlap2") == 7 and up.get("overlap3") == 8 and up.get("net") == 1
       and up.get("swaps") and up["swaps"][0]["segment"] == UP_SEG and up["swaps"][0]["in_is_gold"] is True,
       json.dumps(up.get("swaps"), ensure_ascii=False))
    ck("B1 段 1 换人：净变化 −1（把金标换下去了）",
       down.get("net") == -1 and down["swaps"][0]["in_is_gold"] is False, str(down.get("net")))
    ck("决定性对局：6 局（冻结计划里甲乙恰有一张是金标的）", up.get("decisive") == 6, str(up.get("decisive")))
    ck("上行 1 局、下行 5 局（修订 2.3 按本次计划现算）",
       up.get("up") == 1 and up.get("down") == 5, f"{up.get('up')}/{up.get('down')}")
    ck("B2 五种取值：有方向 3 局、判中 2 局（段 6/7 判中，段 9 判的是非金标）",
       mix.get("dec_directional") == 3 and mix.get("dec_correct") == 2,
       f"有方向 {mix.get('dec_directional')} 判中 {mix.get('dec_correct')}")
    ck("B2：段 7 换上金标、段 9 把金标换下去 → 净变化 0，换人 2 局",
       mix.get("net") == 0 and len(mix.get("swaps") or []) == 2
       and {w["in_is_gold"] for w in mix["swaps"]} == {True, False},
       f"net {mix.get('net')} swaps {json.dumps(mix.get('swaps'), ensure_ascii=False)}")
    ck("「都不够格」单独一栏、不进有方向的分母", mix.get("dec_neither") == 1, str(mix.get("dec_neither")))
    ck("未表态 = 翻覆 + 正反都平局，共 2 局", mix.get("dec_unstated") == 2, str(mix.get("dec_unstated")))
    ck("反向键写的裁决也认（段 6 不算「没判」）", mix.get("dec_unjudged") == 0, str(mix.get("dec_unjudged")))
    ck("计划稳定性：全用冻结计划时 10 段全同、上行局是段 7",
       up.get("frozen_same_segments") == sorted(x["segment"] for x in PLAN)
       and up.get("up_segments") == [UP_SEG] and up.get("down_segments") == sorted(FROZEN["reach"]["down"]),
       f"同段 {up.get('frozen_same_segments')} 上行 {up.get('up_segments')} 下行 {up.get('down_segments')}")
    ck("计划稳定性：同一对挪到别的段号 → 不算「与冻结相同」",
       len(S["plan-shift"]["frozen_same_segments"]) == len(PLAN) - 1
       and PLAN[0]["segment"] not in S["plan-shift"]["frozen_same_segments"],
       json.dumps(S["plan-shift"]["frozen_same_segments"]))
    ck("B3：组别 B3、锚点 8 张、每次 20 幅、无作废",
       b3.get("group") == "B3" and not b3.get("void") and not b3["calls"]["stage3"]["jpegs_off"],
       json.dumps(b3.get("void"), ensure_ascii=False))
    voids = {
        "v-s2fail": "阶段 2 未执行", "v-s3fail": "阶段 3 未执行", "v-missing": "note.missing > 0",
        "v-unused": "note.unused > 0", "v-rubric": "rubric md5", "v-anchors": "锚点应为 8 张",
        "v-s2anchor": "阶段 2 实发锚点应为 10 张", "v-md5": "按记下来的计划重算", "v-vplan": "不是同一份",
        "v-callcount": "calls.jsonl 里 sent 的行数", "v-jpegs": "锚点图取残了",
        "v-s3anchor": "阶段 3 实发锚点应为 8 张",
    }
    for k, needle in voids.items():
        ck(f"作废：{k}", S.get(k, {}).get("void") and any(needle in x for x in S[k]["void"]),
           json.dumps(S.get(k, {}).get("void"), ensure_ascii=False))
    ck("图数不对：不作废，但打出来要人核", not S["jpegs"].get("void") and S["jpegs"]["calls"]["stage3"]["jpegs_off"]
       and "图数不等于本组应有值" in out, json.dumps(S["jpegs"]["calls"]["stage3"]["jpegs_off"]))
    ck("成本记账：作废运行的调用单独报", "作废运行" in out and "调用单独记账" in out)

    # 发布措辞（修订 2.4）：净变化 < 0 的次数决定档位
    one = tmp / "wording1"
    one.mkdir()
    for i in range(5):
        make_run(one, f"w{i:02d}", "B1", {DOWN_SEG: "b"} if i < 3 else {})
    rc2, out2, _ = score(SCORE, [one / f"w{i:02d}" for i in range(5)])
    ck("5 次里 3 次净变化 < 0 → 文档写作「不推荐开启」", "不推荐开启" in out2 and rc2 == 0)
    rc3, out3, _ = score(SCORE, [tmp / "b1-up", tmp / "b3-ok"])
    ck("没有一次净变化 < 0 → 「实测未发现阶段 3 把精选换下去」", "实测未发现阶段 3 把精选换下去" in out3)
    ck("合并数不给置信区间（修订 2.7）", "不给置信区间" in out2 and "置信区间" not in out2.split("不给置信区间")[0])

    # 金标清单换一张就必须停（启动自检）
    bad_gold = tmp / "bad.gold.txt"
    undelivered = sorted(GOLD - set(SELECTED))[0]          # 换一张没进交付的：命中数与决定性分类都不变
    bad_gold.write_text("\n".join(sorted((GOLD - {undelivered}) | {"DSCF0001.JPG"})), encoding="utf-8")
    rc4, out4, _ = score(SCORE, [tmp / "a1"], gold=bad_gold)
    ck(f"金标清单换掉一张没进交付的（{undelivered}）→ 停手：命中数不变，只有整份比对拦得住",
       rc4 != 0 and "停手" in out4 and "Traceback" not in out4, f"exit {rc4}")

    for name, ok, detail in checks:
        print(f"{'✅' if ok else '❌'} {name}" + ("" if ok else f"  —— {detail}"))
    bad = sum(1 for _, ok, _ in checks if not ok)

    # ── 变异：每条算法与守卫都要亲眼看它变 ─────────────────────────────
    src = SCORE.read_text(encoding="utf-8")
    MUT = [
        ("主指标用交付₂", '"overlap3": len(set(d3) & gold),', '"overlap3": len(set(d2) & gold),',
         lambda S2: S2["b1-up"]["overlap3"] != 8),
        ("「都不够格」算进有方向的分母", 'directional = [x for x in dec if x["winner"] in ("a", "b")]',
         'directional = [x for x in dec if x["winner"] in ("a", "b", "neither")]',
         lambda S2: S2["b2-mix"]["dec_directional"] != 3),
        ("平局算判中", '"dec_correct": sum(1 for x in directional if x["winner"] == x["gold_side"]),',
         '"dec_correct": sum(1 for x in dec if x["winner"] == x["gold_side"] or x["winner"] == "tie"),',
         lambda S2: S2["b2-mix"]["dec_correct"] != 2),
        ("上行 / 下行的定义调换", '"up": sum(1 for x in dec if x["gold_side"] == "b"),\n        "down": sum(1 for x in dec if x["gold_side"] == "a"),',
         '"up": sum(1 for x in dec if x["gold_side"] == "a"),\n        "down": sum(1 for x in dec if x["gold_side"] == "b"),',
         lambda S2: (S2["b1-up"]["up"], S2["b1-up"]["down"]) != (1, 5)),
        ("换人不从交付名单反查（照单全收）", '"swapped": a in d2 and a not in d3 and b in d3,', '"swapped": True,',
         lambda S2: len(S2["b1-up"]["swaps"]) != 1),
        ("反向键的裁决不认", 'v = verdicts.get((a, b)) or verdicts.get((b, a))', 'v = verdicts.get((a, b))',
         lambda S2: S2["b2-mix"]["dec_unjudged"] != 0),
        ("与冻结表比对时不看段号，只看对子",
         'same_frozen = sorted(x["segment"] for x in duels if frozen.get(x["segment"]) == (x["a"], x["b"]))',
         'same_frozen = sorted(x["segment"] for x in duels if (x["a"], x["b"]) in set(frozen.values()))',
         lambda S2: len(S2["plan-shift"]["frozen_same_segments"]) != len(PLAN) - 1),
        ("上行局按在位是金标算（定义反了）",
         '"up_segments": sorted(x["segment"] for x in dec if x["gold_side"] == "b"),',
         '"up_segments": sorted(x["segment"] for x in dec if x["gold_side"] == "a"),',
         lambda S2: S2["b1-up"]["up_segments"] != [UP_SEG]),
        ("去掉 note.missing 的作废规则", '        if note.get("missing"):\n', '        if False:\n',
         lambda S2: not S2["v-missing"]["void"]),
        ("组别只看 config、不看实际读到什么",
         '        if want_rubric and (ins.get("rubric_md5") != RUBRIC_MD5):\n', '        if False:\n',
         lambda S2: not S2["v-rubric"]["void"]),
        ("去掉计划 md5 自洽检查", '        if got != s3["plan_md5"]:\n', '        if False:\n',
         lambda S2: not S2["v-md5"]["void"]),
        ("去掉裁决文件与 run.json 的计划比对", '        if (v3.get("plan") or []) != plan:\n', '        if False:\n',
         lambda S2: not S2["v-vplan"]["void"]),
        ("去掉「调用账与调用记录对账」（修订 4.4）", "        if want != got:   # 修订 4.4：闭包计数器与调用记录必须对得上\n",
         "        if False:\n", lambda S2: not S2["v-callcount"]["void"]),
        ("去掉「每张锚点两幅」（修订 4.6）",
         "        if photos is not None and jpegs is not None and jpegs != photos * 2:   # 修订 4.6：每张两幅\n",
         "        if False:\n", lambda S2: not S2["v-jpegs"]["void"]),
        ("阶段 3 锚点核 configured 而不是实发（修订 4.3 反着来）",
         '        sent3 = ((run.get("stage3") or {}).get("anchor_photos_sent") or 0)\n',
         '        sent3 = (ins.get("anchor_photos_configured") or 0)\n',
         lambda S2: not S2["v-s3anchor"]["void"]),
    ]
    for name, needle, repl, changed in MUT:
        n = src.count(needle)
        if n != 1:
            print(f"❌ 变异「{name}」打不准：原文出现 {n} 次（应为 1）")
            bad += 1
            continue
        mut = tmp / "mutant.py"
        mut.write_text(src.replace(needle, repl), encoding="utf-8")
        rc5, out5, S2 = score(mut, runs.values())
        ok = rc5 == 0 and "Traceback" not in out5 and S2 and changed(S2)
        bad += not ok
        print(f"{'✅' if ok else '❌'} 变异「{name}」下结果变了"
              + ("" if ok else f"  —— exit {rc5}{'（崩溃，不算）' if 'Traceback' in out5 else ''}"))
    # 金标自检那条单独验：变异之后「换一张金标」不再停
    mut = tmp / "mutant-gold.py"
    needle = "    if gold != whole:\n"
    assert src.count(needle) == 1, "金标自检那一行变了，先更新这个验证脚本"
    mut.write_text(src.replace(needle, "    if False:\n"), encoding="utf-8")
    rc6, out6, _ = score(mut, [tmp / "a1"], gold=bad_gold)
    ok = rc6 == 0 and "Traceback" not in out6
    bad += not ok
    print(f"{'✅' if ok else '❌'} 变异「去掉金标自检」下换一张金标也照跑（证明是它拦的）")

    print(f"\n{len(checks) + len(MUT) + 1 - bad}/{len(checks) + len(MUT) + 1} 项通过")
    shutil.rmtree(tmp, ignore_errors=True)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
