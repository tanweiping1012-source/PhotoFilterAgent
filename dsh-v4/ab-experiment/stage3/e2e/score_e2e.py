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
  · 换人、不换的原因、双向一致率、读码率、contradiction、实际调用数、每次调用的图数、跨次一致性：照 §5.3 全报。
    **读码率逐次报，两个阶段分开**：合并成一个组内总数会把「某一次判官读错了一局」摊平成看不见
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
from itertools import combinations
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
    v2 = json.loads((d / "stage2-verdicts.json").read_text(encoding="utf-8")) \
        if (d / "stage2-verdicts.json").exists() else None
    v3 = json.loads((d / "stage3-verdicts.json").read_text(encoding="utf-8")) \
        if (d / "stage3-verdicts.json").exists() else None
    return {"dir": d, "run": run, "calls": calls, "v2": v2, "v3": v3}


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
    ran3 = (run.get("stage3") or {}).get("status") in ("ran", "no_contests")
    if group == "A":
        if ins is not None:
            bad.append(f"A 组不该有 stage3_inputs，实际 {ins}")
    elif not ran3:
        # 阶段 3 压根没跑到（多半是阶段 2 先失败了），rubric / 锚点自然没读过。
        # 这时再报「rubric md5 不符」是**假警报**：那一次本来就因为阶段 2 作废了，
        # 多报一条不成立的原因只会让人以后不看这些原因
        pass
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
        # 比较调用的耗时分布。外部故障的形态差一个量级（实测：正常最大 23 秒，
        # 一次 terminated 挂了 249 秒才断），有基线才看得出「挂住了」
        good = [c.get("elapsed_ms") or 0 for c in cmp_sent if c.get("ok") is not False]
        out[f"stage{stage}"] = {
            "rows": len(rows), "sent": len(sent), "compare_sent": len(cmp_sent),
            "preflight_sent": len([c for c in sent if c.get("kind") == "preflight"]),
            "failed": len([c for c in sent if c.get("ok") is False]),
            "jpegs": dict(jpegs), "jpegs_expected": want,
            "jpegs_off": {k: v for k, v in jpegs.items() if want is not None and k != want},
            "elapsed_median_ms": int(statistics.median(good)) if good else None,
            # p90 与「超过 30 秒几次」一起看：实测最大值 24.8 → 43.2 → 51.7 秒一路被刷新，
            # 只报极值会以为慢调用很常见，实际 p90 只有 7 秒出头 —— 是稀疏的离群点
            "elapsed_p90_ms": sorted(good)[min(int(len(good) * 0.9), len(good) - 1)] if good else None,
            "slow_over_30s": sum(1 for x in good if x > 30_000),
            "elapsed_max_ms": max(good) if good else None,
            "failed_elapsed_ms": [c.get("elapsed_ms") for c in sent if c.get("ok") is False],
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


# 两个阶段的裁决文件写法不同：阶段 2 是 codeReadOk，阶段 3 是 code_read_ok。
# 只认一种的话，另一种会全场读成 None → 报成「读码 0/60」，是个吓人的假数
CODE_READ_KEYS = ("code_read_ok", "codeReadOk")


def burned_in(x: dict) -> bool:
    """这一局的图上到底烧了码没有。

    compare.ts:398 是 `codeReadOk = !withCodes || 四个码位都抄对`——**不烧码时它恒为真**。
    照抄就会报出「读码 10/10」这种假的满分（ranker/tests/test_calibration_scoring.py 为此立过守卫）。
    烧了码才有 codes_read/codesRead 与 code_a/codeA，没烧码这些键根本不写。
    """
    return bool(x.get("codes_read") or x.get("codesRead") or x.get("code_a") or x.get("codeA"))


def code_read_rate(v: dict | None) -> dict | None:
    """一份裁决文件里判官把图上的码读对了几局。

    分母只数**既带这个字段、又真烧了码**的记录，另外两种各自单独报，都不当成读码失败：
    字段整个不在 = 裁决文件换了写法；没烧码 = 这个数对它恒为真，报出来就是假的满分。
    （假警报会把人训练成忽略告警，假的满分会把人训练成相信一个没测过的数。）
    """
    if not v:
        return None
    rows = v.get("verdicts") or []
    missing = [x for x in rows if not any(k in x for k in CODE_READ_KEYS)]
    unburned = [x for x in rows if x not in missing and not burned_in(x)]
    judged = [x for x in rows if x not in missing and x not in unburned]
    return {"judged": len(judged), "missing_field": len(missing), "not_burned": len(unburned),
            "ok": sum(1 for x in judged if next(x[k] for k in CODE_READ_KEYS if k in x))}


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
        # 逐次读码率按**裁决文件**数（阶段 2 也有，阶段 3 的 code_read_ok 是按本次计划的局数）
        "code_read": {"stage2": code_read_rate(r["v2"]), "stage3": code_read_rate(v3)},
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
    # 跑到一半的运行：目录在开跑时就建好，run.json 是收尾才写的。跳过并说一声，
    # 不要崩 —— 指着 runs/* 算分时，正在跑的那一次必然在列表里
    pending = [d for d in a.runs if not (d / "run.json").exists()]
    if pending:
        print(f"跳过 {len(pending)} 个还没收尾的运行（没有 run.json，多半正在跑）：{[d.name for d in pending]}\n")
    scored = [score_run(read_run(d), gold, frozen) for d in a.runs if (d / "run.json").exists()]
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
        lat = " · ".join(
            f"阶段 {k[-1]} 中位 {s['calls'][k]['elapsed_median_ms'] / 1000:.1f}s / p90 {s['calls'][k]['elapsed_p90_ms'] / 1000:.1f}s"
            f" / 最大 {s['calls'][k]['elapsed_max_ms'] / 1000:.1f}s"
            + (f"（超 30s 的 {s['calls'][k]['slow_over_30s']} 次）" if s["calls"][k]["slow_over_30s"] else "")
            for k in ("stage2", "stage3") if s["calls"][k]["elapsed_median_ms"] is not None)
        fail = [ms for k in ("stage2", "stage3") for ms in s["calls"][k]["failed_elapsed_ms"]]
        if lat:
            print(f"        比较调用耗时：{lat}" + (f" · **失败那次 {max(fail) / 1000:.0f}s**" if fail else ""))
        cr = []
        for k in ("stage2", "stage3"):
            c = s["code_read"][k]
            if c:
                cr.append(f"阶段 {k[-1]} {c['ok']}/{c['judged']}"
                          + (f"（另有 {c['missing_field']} 条没有读码字段，没算进分母）" if c["missing_field"] else "")
                          + (f"（另有 {c['not_burned']} 条没烧码，这个数对它们恒为真，没算进分母）"
                             if c["not_burned"] else ""))
        if cr:
            print(f"        判官读码正确（按裁决文件逐次数）：{' · '.join(cr)}")
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
        # 一致率 × 换人 × 净变化：翻覆的局**结构上不可能换人**（要挑战者正反都赢），
        # 所以「一致率低却换得多」的意思是「少数表了态的局里挑战者赢的比例高」。攒够五轮再看，现在只列不解读
        trio = [(f"{s['consistent']}/{s['contests']}", s["note"].get("swapped", 0), s["net"]) for s in rows]
        print(f"      一致率 × 换人 × 净变化（逐次，不解读）：{trio}")
        with_up = [s for s in rows if s["up_segments"]]
        print(f"      计划稳定性：{len(with_up)}/{len(rows)} 次的计划里有上行局"
              f"（有上行局的那几次：{[s['up_segments'] for s in with_up] or '无'}）· "
              f"与冻结对局表相同的段数 {[len(s['frozen_same_segments']) for s in rows]}")
        # 同组内部两两重合：同一配置、同一批照片、同一条指令，交付名单还能差多少。
        # A 组（阶段 3 关）量的就是**阶段 2 的噪声带宽**；B 组的交付₂ 同理，交付₃ 再叠上阶段 3。
        # 组间差要拿这把尺子去读 —— 比组间差本身更该先看（修订 1.4）
        if len(rows) >= 2:
            def pairwise(key):
                return sorted(len(set(x[key]) & set(y[key])) for x, y in combinations(rows, 2))
            p2, p3 = pairwise("delivered_after_stage2"), pairwise("delivered_final")
            print(f"      同组两两重合（{len(p3)} 对）：交付₂ {p2}（{min(p2)}~{max(p2)}）· "
                  f"交付₃ {p3}（{min(p3)}~{max(p3)}）—— 同配置下的噪声带宽，读组间差要先看它")
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
        # 作废分两种形态：没花钱的（配置/流程在发调用之前就被拦下）与有沉没调用的。
        # 修订 2.11 只说「单独记账」，但这两种对「还要补跑多少钱」的含义完全不同
        sunk = [s for s in void if sum(s["calls"][k]["sent"] for k in ("stage2", "stage3")) > 0]
        free = [s for s in void if s not in sunk]
        print(f"\n作废运行 {len(void)} 次（修订 2.11：不计入任何指标，调用单独记账）："
              f"**跑到一半 {len(sunk)} 次、沉没 {cost} 次调用**；没花钱就被拦下 {len(free)} 次")
        for s in void:
            n = sum(s["calls"][k]["sent"] for k in ("stage2", "stage3"))
            f = [ms for k in ("stage2", "stage3") for ms in s["calls"][k]["failed_elapsed_ms"]]
            tag = f"**沉没 {n} 次**" if n else "没花钱（发调用之前就拦下了）"
            print(f"  {s['group']} {s['dir']}：{tag}"
                  + (f"（失败那次 {max(f) / 1000:.0f} 秒）" if f else "") + f" —— {'；'.join(s['void'])}")
    total = sum(s["calls"][k]["sent"] for s in scored for k in ("stage2", "stage3"))
    print(f"\n成本合计（运行记录里数出来的 sent）：{total} 次，其中有效 "
          f"{sum(s['calls'][k]['sent'] for s in valid for k in ('stage2', 'stage3'))} 次")

    if a.json:
        a.json.write_text(json.dumps(scored, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
        print(f"\n逐次结果 → {a.json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
