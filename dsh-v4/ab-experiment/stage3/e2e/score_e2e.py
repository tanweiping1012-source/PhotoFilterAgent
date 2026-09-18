#!/usr/bin/env python3
"""第四轮端到端 A/B 的算分。0 次付费调用，只读运行记录。

    python3 score_e2e.py --runs <run 目录…> [--gold <金标清单>] [--json <输出文件>]

每个 run 目录是产品写的 `<workdir>/runs/<时间戳>-<6 位 hex>/`：run.json、calls.jsonl、
stage2-verdicts.json、stage3-verdicts.json。**判据写在看到数据之前**（CRITERIA-E2E 修订 1.3/2.3/2.6/2.7/2.8/2.10）。

口径，每条都对着一个会把结论算歪的方式：
  · **金标以仓库的答案清单为准**（eval-sets/eval-people-309-acceptance.gold.txt）。启动时用冻结件自检三项：
    **整份 20 张**必须等于 duel-table.json 的 gold_hits + undelivered_gold；在冻结基线上的命中必须是那 7 张；
    重算冻结对局表的上行 / 下行必须是 up=[7] / down=[1,3,5,6,9]。对不上就停 —— 答案换一张，主指标和决定性分类
    都会跟着变，而两边都不报错；只比命中数还不够，换掉一张没进交付的金标命中数一点不变
  · **主指标是交付₃**（最终交付）与金标的重合；**阶段 3 自己的作用看净变化 = 重合(交付₃) − 重合(交付₂)**（修订 1.3 §5.2b）。
    A 与 B 的差值混着阶段 2 的噪声，只并列摆出，不做推断
  · **决定性对局按每次运行自己的计划现算**（修订 1.3、2.3）：甲乙恰有一张是金标的局才算。
    「都不够格」算表态但没有赢家 → 不进有方向的分母，单独报；翻覆与正反都平局 → 未表态（修订 2.6）
  · **合并只做描述性汇总，不给置信区间**（修订 2.7）：同一组 5 次里大量是同一对照片重复问，不是独立样本。
    主报法是逐对报「这一对出现 n 次、判中金标 x 次、未表态 y 次」
  · **作废规则**（修订 2.8、1.5、4.4、4.6）：阶段 2 failed（任一组）/ 阶段 3 failed（B 组）/ note.missing > 0 /
    note.unused > 0 / 阶段 3 的输入与本组应有值不符 / run.json 的 comparisons+preflights ≠ calls.jsonl 里该 stage
    sent 的行数 / 同阶段 anchor_jpegs_sent ≠ anchor_photos_sent × 2。作废运行的调用**单独记账、计入成本、不进指标**
  · **调用数以 run.json 的 comparisons / preflights 为准**（修订 4.2），不再用「对数 × 2」倒推；预检计入总数
  · **锚点核实发不核配置**（修订 4.3、4.6）：阶段 2 `anchor_photos_sent` = 10；B3 阶段 3 = 8，A/B1/B2 = 0
  · **组别按运行记录自己判**：config 里配了什么路径 → 应当是哪一组；stage3_inputs 记的是实际读到什么。
    两者对不上就是作废（修订 2.10），不是「按配置当成那一组算」
  · 换人、不换的原因、双向一致率、读码率、contradiction、实际调用数、每次调用的图数、跨次一致性：照 §5.3 全报
  · **每次的计划稳定性**：阶段 2 的判决会换掉一部分对局，所以每次运行报「与冻结对局表相同的段」
    以及**本次计划里有没有上行局**（挑战者是金标、在位不是）。没有上行局的那次，+1 结构上就够不着 ——
    不报这一项，单看「某次 +1」会被读成「阶段 3 能加分」

**不许做的事**（§6）：不把重合数的变化写成「准确率提升 / 下降 X%」；不与第二步 A/B 或第三轮标定做「提升了多少」；
不引用 14/20 以上的任何上限。这个脚本只输出数，措辞规则见 §6、§7 与修订 2.4。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import statistics
import sys
from collections import Counter, defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
GOLD_FILE = REPO / "dsh-v4/eval-sets/eval-people-309-acceptance.gold.txt"
DUEL_TABLE = REPO / "dsh-v4/ab-experiment/stage3/duel-table.json"
BASELINE = REPO / "dsh-v4/ab-experiment/stage3/pick-299-baseline.json"
# 修订 2.10 的本组应有值。rubric 以第三轮标定 spec 的那份为准（1154 字）
RUBRIC_MD5 = "e018ae40ec7aecaae30df81c4e49d033"
GROUPS = {   # 组 → (阶段 3 开关, 要 rubric, 要锚点, 每次阶段 3 调用的图数)
    "A": (False, False, False, None),
    "B1": (True, False, False, 4),
    "B2": (True, True, False, 4),
    "B3": (True, True, True, 20),
}
STAGE2_JPEGS = 24            # 锚点 10 张 × 2 + 待判 2 张 × 2（修订 2.2）
ANCHOR_PHOTOS_S2 = 10        # 修订 4.3：核 anchor_photos_sent，不核 configured
ANCHOR_PHOTOS_S3 = 8


def plan_md5(pairs: list) -> str:
    """与 ranker/photofilter_rank/stage3.py 的 plan_md5 同一种序列化（修订 2.5，文件名带扩展名）。"""
    return hashlib.md5(json.dumps(pairs, separators=(",", ":")).encode()).hexdigest()


def load_gold(path: Path, duel_table: Path, baseline: Path) -> set:
    """读金标清单，并用冻结件自检：清单换了一张，主指标和决定性分类都会跟着变，而两边都不报错。

    比的是**整份清单**，不只是它在冻结名单上的命中：换掉一张没进交付的金标，命中数一点不变，
    决定性分类也可能一模一样 —— 实测就是这样（仓库清单与某处硬编码的那份差 2 张，命中都是 7）。
    冻结件 duel-table.json 里 gold_hits + undelivered_gold 正好是完整的 20 张。
    """
    gold = {ln.strip() for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip()}
    if len(gold) != 20:
        raise SystemExit(f"金标清单应当是 20 张，实际 {len(gold)} 张：{path}")
    frozen = json.loads(duel_table.read_text(encoding="utf-8"))
    base = json.loads(baseline.read_text(encoding="utf-8"))
    whole = set(frozen["gold_hits"]) | {x["name"] if isinstance(x, dict) else x for x in frozen["undelivered_gold"]}
    if gold != whole:
        raise SystemExit(
            f"这份金标清单与冻结件 duel-table.json 记的那 20 张不同："
            f"只在清单里 {sorted(gold - whole)}，只在冻结件里 {sorted(whole - gold)} —— "
            f"答案清单与预登记不是同一份，停手")
    hits = sorted(gold & set(base["selected"]))
    if hits != sorted(frozen["gold_hits"]):
        raise SystemExit(
            f"这份金标清单在冻结基线上的命中是 {hits}，而冻结件 duel-table.json 记的是 {sorted(frozen['gold_hits'])} —— "
            f"答案清单与预登记不是同一份，停手")
    duels = {x["seg"]: (x["incumbent"], x["challenger"]) for x in frozen["duels"] if x["challenger"]}
    up = sorted(s for s, (a, b) in duels.items() if b in gold and a not in gold)
    down = sorted(s for s, (a, b) in duels.items() if a in gold and b not in gold)
    if up != sorted(frozen["reach"]["up"]) or down != sorted(frozen["reach"]["down"]):
        raise SystemExit(f"用这份金标重算冻结对局表的上行/下行是 {up}/{down}，预登记是 "
                         f"{frozen['reach']['up']}/{frozen['reach']['down']} —— 停手")
    return gold


def read_run(d: Path) -> dict:
    run = json.loads((d / "run.json").read_text(encoding="utf-8"))
    calls = [json.loads(ln) for ln in (d / "calls.jsonl").read_text(encoding="utf-8").splitlines() if ln.strip()] \
        if (d / "calls.jsonl").exists() else []
    v3 = json.loads((d / "stage3-verdicts.json").read_text(encoding="utf-8")) \
        if (d / "stage3-verdicts.json").exists() else None
    return {"dir": d, "run": run, "calls": calls, "v3": v3}


def classify(run: dict) -> tuple[str, list]:
    """组别按 config 里配了什么判；stage3_inputs 记的是实际读到什么，两者对不上就作废（修订 2.10）。"""
    cfg = run.get("config") or {}
    want_rubric = bool(cfg.get("stage3RubricFile"))
    want_anchors = bool(cfg.get("stage3AnchorsFile"))
    group = next((g for g, (vlm, r, a, _) in GROUPS.items()
                  if vlm == bool(cfg.get("stage3Vlm")) and r == want_rubric and a == want_anchors), None)
    bad = []
    if group is None:
        return "?", [f"config 的阶段 3 三个键组合不对应任何一组：{ {k: cfg.get(k) for k in ('stage3Vlm', 'stage3RubricFile', 'stage3AnchorsFile')} }"]
    ins = run.get("stage3_inputs")
    if group == "A":
        if ins is not None:
            bad.append(f"A 组不该有 stage3_inputs，实际 {ins}")
    elif ins is None:
        bad.append(f"{group} 组没有 stage3_inputs —— 核不了这一次到底带没带 rubric / 锚点")
    else:
        if want_rubric and (ins.get("rubric_md5") != RUBRIC_MD5):
            bad.append(f"{group} 组的 rubric md5 应为 {RUBRIC_MD5}，实际 {ins.get('rubric_md5')}（{ins.get('rubric_chars')} 字）")
        if not want_rubric and (ins.get("rubric_chars") or ins.get("rubric_md5")):
            bad.append(f"{group} 组不该带 rubric，实际 {ins.get('rubric_chars')} 字 / {ins.get('rubric_md5')}")
        want_n = ANCHOR_PHOTOS_S3 if want_anchors else 0
        sent3 = ((run.get("stage3") or {}).get("anchor_photos_sent") or 0)
        if sent3 != want_n:   # 修订 4.3/4.6：核真发出去的张数
            bad.append(f"{group} 组的阶段 3 实发锚点应为 {want_n} 张，实际 {sent3}")
    s2 = run.get("stage2") or {}
    if s2.get("status") == "ran" and (s2.get("anchor_photos_sent") or 0) != ANCHOR_PHOTOS_S2:
        bad.append(f"阶段 2 实发锚点应为 {ANCHOR_PHOTOS_S2} 张，实际 {s2.get('anchor_photos_sent')}")
    return group, bad


def void_reasons(run: dict, group: str, inputs_bad: list) -> list:
    """修订 2.8 与 1.5：作废的五种。作废运行的调用照样记成本，但不进任何指标。"""
    out = list(inputs_bad)
    s2, s3 = run.get("stage2") or {}, run.get("stage3") or {}
    if s2.get("status") == "failed":
        out.append(f"阶段 2 未执行：{s2.get('error')}")
    elif s2.get("status") != "ran":
        out.append(f"阶段 2 状态是 {s2.get('status')!r} —— 本轮四组都开阶段 2，只有 ran 才算数")
    if group != "A":
        if s3.get("status") == "failed":
            out.append(f"阶段 3 未执行：{s3.get('error')}")
        elif s3.get("status") not in ("ran", "no_contests"):
            out.append(f"阶段 3 状态是 {s3.get('status')!r}")
        note = s3.get("note") or {}
        if note.get("missing"):
            out.append(f"阶段 3 有 {note['missing']} 局没判（note.missing > 0）")
        if note.get("unused"):
            out.append(f"裁决里有 {note['unused']} 条不属于这份计划（note.unused > 0）")
    elif s3.get("status") != "off":
        out.append(f"A 组的阶段 3 应当是 off，实际 {s3.get('status')!r}")
    return out


def call_stats(calls: list, group: str) -> dict:
    """调用与图数（修订 2.2、§5.3）。图数少 1~2 幅多半是待判照片检不到脸，只报不停。"""
    out = {}
    for stage in (2, 3):
        rows = [c for c in calls if c.get("stage") == stage]
        sent = [c for c in rows if c.get("sent")]
        cmp_sent = [c for c in sent if c.get("kind") != "preflight"]
        want = STAGE2_JPEGS if stage == 2 else GROUPS[group][3]
        jpegs = Counter(c.get("jpegs") for c in cmp_sent)
        out[f"stage{stage}"] = {
            "rows": len(rows), "sent": len(sent), "compare_sent": len(cmp_sent),
            "preflight_sent": len([c for c in sent if c.get("kind") == "preflight"]),
            "failed": len([c for c in sent if c.get("ok") is False]),
            "jpegs": dict(jpegs), "jpegs_expected": want,
            "jpegs_off": {k: v for k, v in jpegs.items() if want is not None and k != want},
        }
    return out


def record_consistency(run: dict, v3: dict | None, calls: list) -> list:
    """运行记录自身要对得上。这几条不花钱、也不依赖任何外部答案，但错了会让整次运行的数都不可信：
    计划 md5 与计划本身算出来的对不上，说明记录不是同一次算的；裁决文件里的计划与 run.json 不一致，
    说明应用的是另一份计划。"""
    out = []
    s3 = run.get("stage3") or {}
    plan = s3.get("plan") or []
    if plan and s3.get("plan_md5"):
        got = plan_md5([[x["a"], x["b"]] for x in plan])
        if got != s3["plan_md5"]:
            out.append(f"run.json 里的计划 md5 是 {s3['plan_md5']}，按记下来的计划重算是 {got}")
    for stage, rec in ((2, run.get("stage2") or {}), (3, s3)):
        if "comparisons" not in rec:
            continue
        want = (rec.get("comparisons") or 0) + (rec.get("preflights") or 0)
        got = sum(1 for c in calls if c.get("stage") == stage and c.get("sent"))
        if want != got:   # 修订 4.4：闭包计数器与调用记录必须对得上
            out.append(f"阶段 {stage} 的 comparisons+preflights = {want}，calls.jsonl 里 sent 的行数 = {got}")
        photos, jpegs = rec.get("anchor_photos_sent"), rec.get("anchor_jpegs_sent")
        if photos is not None and jpegs is not None and jpegs != photos * 2:   # 修订 4.6：每张两幅
            out.append(f"阶段 {stage} 的 anchor_jpegs_sent={jpegs} ≠ anchor_photos_sent×2={photos * 2} —— 锚点图取残了")
    if v3 is not None:
        if v3.get("plan_md5") != s3.get("plan_md5"):
            out.append(f"裁决文件的计划 md5 {v3.get('plan_md5')} ≠ run.json 的 {s3.get('plan_md5')}")
        if (v3.get("plan") or []) != plan:
            out.append("裁决文件里的计划与 run.json 里的不是同一份")
    return out


def frozen_pairs(duel_table: Path) -> dict:
    """冻结对局表：{段号: (擂主, 挑战者)}。只用来做对照，不参与任何判定。"""
    f = json.loads(duel_table.read_text(encoding="utf-8"))
    return {x["seg"]: (x["incumbent"], x["challenger"]) for x in f["duels"] if x["challenger"]}


def score_run(r: dict, gold: set, frozen: dict) -> dict:
    run, v3 = r["run"], r["v3"]
    group, inputs_bad = classify(run)
    void = void_reasons(run, group, inputs_bad) + record_consistency(run, v3, r["calls"])
    d2 = list(run.get("delivered_after_stage2") or [])
    d3 = list(run.get("delivered_final") or [])
    s3 = run.get("stage3") or {}
    plan = s3.get("plan") or []
    note = s3.get("note") or {}
    verdicts = {(v["a"], v["b"]): v for v in (v3 or {}).get("verdicts", [])}
    duels = []
    for row in plan:
        a, b = row["a"], row["b"]
        v = verdicts.get((a, b)) or verdicts.get((b, a))
        w = (v or {}).get("winner")
        if v and (a, b) not in verdicts:                       # 裁决是反着写的：翻回本局的甲乙
            w = {"a": "b", "b": "a"}.get(w, w)
        gold_side = "a" if a in gold and b not in gold else "b" if b in gold and a not in gold else None
        duels.append({
            "segment": row.get("segment"), "a": a, "b": b, "margin": row.get("margin"),
            "gold_side": gold_side, "winner": w,
            "consistent": (v or {}).get("consistent"), "code_read_ok": (v or {}).get("code_read_ok"),
            "contradiction": (v or {}).get("contradiction"),
            # 换人只认交付名单：note 里的 swapped 是计数，落在哪一局要从名单反查
            "swapped": a in d2 and a not in d3 and b in d3,
        })
    dec = [x for x in duels if x["gold_side"]]
    directional = [x for x in dec if x["winner"] in ("a", "b")]
    # 与冻结对局表逐段比：段号与那一对都相同才算同一局
    same_frozen = sorted(x["segment"] for x in duels if frozen.get(x["segment"]) == (x["a"], x["b"]))
    return {
        "dir": r["dir"].name, "group": group, "void": void,
        "run_id": run.get("run_id"), "fingerprint": run.get("fingerprint"),
        "started_at": run.get("started_at"), "finished_at": run.get("finished_at"),
        "plan_md5": s3.get("plan_md5"), "stage3_status": s3.get("status"),
        "overlap2": len(set(d2) & gold), "overlap3": len(set(d3) & gold),
        "net": len(set(d3) & gold) - len(set(d2) & gold),
        "delivered_final": d3, "delivered_after_stage2": d2,
        "contests": len(plan), "note": note,
        "swaps": [{"segment": x["segment"], "out": x["a"], "in": x["b"], "in_is_gold": x["b"] in gold}
                  for x in duels if x["swapped"]],
        # 修订 2.3：每次运行按自己的计划现算上行 / 下行与可达区间
        "up": sum(1 for x in dec if x["gold_side"] == "b"),
        "down": sum(1 for x in dec if x["gold_side"] == "a"),
        "up_segments": sorted(x["segment"] for x in dec if x["gold_side"] == "b"),
        "down_segments": sorted(x["segment"] for x in dec if x["gold_side"] == "a"),
        "frozen_same_segments": same_frozen,
        "decisive": len(dec),
        "dec_directional": len(directional),
        "dec_correct": sum(1 for x in directional if x["winner"] == x["gold_side"]),
        "dec_neither": sum(1 for x in dec if x["winner"] == "neither"),
        "dec_unstated": sum(1 for x in dec if x["winner"] in ("tie", "inconsistent")),
        "dec_unjudged": sum(1 for x in dec if x["winner"] is None),
        "consistent": sum(1 for x in duels if x["consistent"]),
        "code_read_ok": sum(1 for x in duels if x["code_read_ok"]),
        "contradiction": sum(1 for x in duels if x["contradiction"]),
        "duels": duels,
        "record": {"stage2": run.get("stage2"), "stage3": s3},
        "calls": call_stats(r["calls"], group if group in GROUPS else "B1"),
    }


def reach(s: dict) -> str:
    return f"{s['overlap2'] - s['down']}~{s['overlap2'] + s['up']}"


def main() -> int:
    ap = argparse.ArgumentParser(description="第四轮端到端 A/B 算分（0 次付费调用）")
    ap.add_argument("--runs", type=Path, nargs="+", required=True, help="run 目录（可给多个）")
    ap.add_argument("--gold", type=Path, default=GOLD_FILE)
    # 冻结件的位置默认按仓库布局推；给出来是为了让验证脚本能把副本放在别处跑
    ap.add_argument("--duel-table", type=Path, default=DUEL_TABLE)
    ap.add_argument("--baseline", type=Path, default=BASELINE)
    ap.add_argument("--json", type=Path, help="把逐次结果写成 JSON")
    a = ap.parse_args()

    gold = load_gold(a.gold, a.duel_table, a.baseline)
    print(f"金标 {len(gold)} 张（{a.gold.name}）· 冻结件自检通过：整份清单、冻结名单上的命中、上行/下行都与 duel-table.json 一致\n")

    frozen = frozen_pairs(a.duel_table)
    scored = [score_run(read_run(d), gold, frozen) for d in a.runs]
    scored.sort(key=lambda s: (s["group"], s["started_at"] or ""))
    valid = [s for s in scored if not s["void"]]
    void = [s for s in scored if s["void"]]

    print("逐次运行")
    print(f"  {'组':<3}{'run':<26}{'交付₂':>5}{'交付₃':>5}{'净变化':>6}{'换人':>5}{'决定性':>6}"
          f"{'判中/有方向':>11}{'都不够格':>8}{'未表态':>6}{'可达':>7}  计划 md5")
    for s in scored:
        mark = "作废" if s["void"] else ""
        hit = f"{s['dec_correct']}/{s['dec_directional']}"
        print(f"  {s['group']:<3}{s['dir'][:24]:<26}{s['overlap2']:>5}{s['overlap3']:>5}{s['net']:>+6}"
              f"{s['note'].get('swapped', 0):>5}{s['decisive']:>6}"
              f"{hit:>11}{s['dec_neither']:>8}{s['dec_unstated']:>6}"
              f"{reach(s):>7}  {str(s['plan_md5'])[:8]} {mark}")
        if s["contests"]:
            print(f"        计划：上行局 段 {s['up_segments'] or '（无 —— 这次 +1 结构上够不着）'} · "
                  f"下行局 段 {s['down_segments']} · 与冻结对局表相同的段 {len(s['frozen_same_segments'])}/{s['contests']} "
                  f"{s['frozen_same_segments']}")
        for w in s["swaps"]:
            print(f"        段 {w['segment']}：{w['out']} → {w['in']}{'（换上的是金标）' if w['in_is_gold'] else ''}")
        for v in s["void"]:
            print(f"        ⚠️ 作废：{v}")

    print("\n分组汇总（n=5，不做推断；差值混着阶段 2 的噪声，只并列摆出）")
    by_group = defaultdict(list)
    for s in valid:
        by_group[s["group"]].append(s)
    for g in [x for x in GROUPS if x in by_group]:
        rows = by_group[g]
        o3 = [s["overlap3"] for s in rows]
        nets = [s["net"] for s in rows]
        neg, pos = sum(1 for x in nets if x < 0), sum(1 for x in nets if x > 0)
        bucket = ("实测未发现阶段 3 把精选换下去" if neg == 0
                  else "实测有换下去的情况" if neg <= 2 else "不推荐开启")
        print(f"\n  {g}（有效 {len(rows)} 次）主指标 交付₃ {o3}"
              f" · 最小 {min(o3)} 中位 {statistics.median(o3):g} 最大 {max(o3)} 均值 {statistics.mean(o3):.1f}")
        if g != "A":
            print(f"      阶段 3 净变化 {nets}（<0 共 {neg} 次，>0 共 {pos} 次 —— 不称为「提升」）→ 文档写作「{bucket}」")
        n = Counter()
        for s in rows:
            n.update({k: v for k, v in s["note"].items() if isinstance(v, int)})
        if g != "A":
            print(f"      不换的原因合计：擂主赢 {n['kept_a']} · 平局 {n['kept_tie']} · 都不够格 {n['kept_neither']}"
                  f" · 翻覆 {n['kept_inconsistent']} · 没跑 {n['missing']} · 破同组上限 {n['refused_family_cap']}"
                  f" · 换人 {n['swapped']}")
            duels_all = sum(s["contests"] for s in rows)
            print(f"      双向一致 {sum(s['consistent'] for s in rows)}/{duels_all} · "
                  f"读码全对 {sum(s['code_read_ok'] for s in rows)}/{duels_all} · "
                  f"说甲给乙码 {sum(s['contradiction'] for s in rows)}/{duels_all}")
            cor = sum(s["dec_correct"] for s in rows)
            dire = sum(s["dec_directional"] for s in rows)
            dec = sum(s["decisive"] for s in rows)
            print(f"      决定性对局：判中金标 {cor}/{dire}（有方向）"
                  f" · 都不够格 {sum(s['dec_neither'] for s in rows)} · 未表态 {sum(s['dec_unstated'] for s in rows)}"
                  f" · 按全部 {dec} 局算（未表态记为没选中）{cor}/{dec}")
            print(f"      ⚠️ 合并数只作描述性汇总，不给置信区间：5 次里大量是同一对照片重复问，不是独立样本（修订 2.7）")
            pairs = defaultdict(list)
            for s in rows:
                for x in s["duels"]:
                    if x["gold_side"]:
                        pairs[(x["a"], x["b"])].append(x)
            print(f"      逐对（主报法）：")
            for (pa, pb), xs in sorted(pairs.items(), key=lambda kv: kv[1][0]["segment"]):
                ok = sum(1 for x in xs if x["winner"] == x["gold_side"])
                un = sum(1 for x in xs if x["winner"] in ("tie", "inconsistent", None))
                nei = sum(1 for x in xs if x["winner"] == "neither")
                gold_name = pa if xs[0]["gold_side"] == "a" else pb
                print(f"        段 {xs[0]['segment']} {pa} vs {pb}（金标是 {gold_name}）："
                      f"出现 {len(xs)} 次 · 判中 {ok} 次 · 都不够格 {nei} 次 · 未表态 {un} 次 · "
                      f"判决取值 {sorted({str(x['winner']) for x in xs})}")
        with_up = [s for s in rows if s["up_segments"]]
        print(f"      计划稳定性：{len(with_up)}/{len(rows)} 次的计划里有上行局"
              f"（有上行局的那几次：{[s['up_segments'] for s in with_up] or '无'}）· "
              f"与冻结对局表相同的段数 {[len(s['frozen_same_segments']) for s in rows]}")
        lists = {tuple(s["delivered_final"]) for s in rows}
        print(f"      跨次一致性：交付名单 {len(lists)} 种 / {len(rows)} 次 · 计划 md5 {len({s['plan_md5'] for s in rows})} 种")
        c2 = sum((s["record"]["stage2"] or {}).get("comparisons", 0) for s in rows)
        c3 = sum((s["record"]["stage3"] or {}).get("comparisons", 0) for s in rows)
        p = sum((s["record"][f"stage{k}"] or {}).get("preflights", 0) for s in rows for k in (2, 3))
        print(f"      实际调用（run.json，修订 4.2）：阶段 2 比较 {c2} · 阶段 3 比较 {c3} · 预检 {p} · 合计 {c2 + c3 + p}")
        off = [(s["dir"], k, v) for s in rows for k in ("stage2", "stage3") for v in [s["calls"][k]["jpegs_off"]] if v]
        if off:
            print(f"      ⚠️ 有调用的图数不等于本组应有值（待判照片检不到脸会少 1~2 幅，逐条核）：{off}")

    if void:
        cost = sum(s["calls"][k]["sent"] for s in void for k in ("stage2", "stage3"))
        print(f"\n作废运行 {len(void)} 次（不计入任何指标，调用单独记账 {cost} 次）：")
        for s in void:
            print(f"  {s['group']} {s['dir']}：{'；'.join(s['void'])}")
    total = sum(s["calls"][k]["sent"] for s in scored for k in ("stage2", "stage3"))
    print(f"\n成本合计（运行记录里数出来的 sent）：{total} 次，其中有效 "
          f"{sum(s['calls'][k]['sent'] for s in valid for k in ('stage2', 'stage3'))} 次")

    if a.json:
        a.json.write_text(json.dumps(scored, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
        print(f"\n逐次结果 → {a.json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
