#!/usr/bin/env python3
"""19 对标定考题 → 三份 run_pair_eval 考题 spec。0 次付费调用。

    python make_calib_specs.py            写到 archive（路径解析成本机真实目录），供实际运行
    python make_calib_specs.py --repo     写到仓库（照片目录保留 @@PHOTOS@@），供预登记落库
    python make_calib_specs.py --dry-run  写到 --out 指定的目录，不检查「实现」是否已合入

三份 spec **只在处理变量上不同**，其余逐字节相同（脚本末尾自检）：

    第一遍 calib-arm1-none            rubric ""（显式空）
    第二遍 calib-arm2-rubric          rubric = 通用 + 个人 两段拼接
    第三遍 calib-arm3-rubric-anchors  同上 + anchors 块

为什么第一遍要**显式**写 rubric: ""：run_pair_eval 是 `spec.rubric ?? loadRubric()`，
缺省会回落到 profile 的 rubricFile。空串不是 nullish，写了就不会回落 ——
这是「处理变量被配置静默吃掉」那一类坑（上一轮 preset 覆盖 profile 花掉 120 次）。

金标放 a 槽还是 b 槽：按金标文件名排序后**交替**（偶数位放 a、奇数位放 b）。
排序键是文件名（≈拍摄时间），与分数、难度无关。
"""
import argparse, hashlib, json, re, sys
from pathlib import Path

HOME = Path.home()
REPO = HOME / "deepseek-harness/PhotoFilterAgent"
STAGE3 = REPO / "dsh-v4/ab-experiment/stage3"
PAIRS = STAGE3 / "calib-guarded-other.json"                    # 决定甲：19 对
RUBRIC_GENERAL = REPO / "dsh-v4/rubric/rubric-crossscene-general.txt"
RUBRIC_PERSONAL = REPO / "dsh-v4/rubric/rubric-crossscene-personal-example.txt"
ANCHORS = REPO / "dsh-v4/anchors-crossscene.json"
PAIR_EVAL_TS = REPO / "agent-v4/src/pairEval.ts"
PHOTOS = HOME / "Desktop/照片测试"
ARCHIVE = HOME / ".dsh-v4/photo-filter-v4/archive/round3-calibration"
ALLOW_NEITHER = True     # 三遍一致；通用 rubric 里要求「两张都不够格时如实说」，工具得给这个选项

md5 = lambda b: hashlib.md5(b).hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", action="store_true", help="写到仓库，照片目录保留 @@PHOTOS@@")
    ap.add_argument("--dry-run", action="store_true", help="不检查 pairEval.ts 是否真的读了 burn_codes")
    ap.add_argument("--out", type=Path, default=None)
    a = ap.parse_args()

    # ── 守卫：spec 里的 burn_codes 字段必须真的有人读，而且读了真的去烧码 ─────────
    # 字段名写错或读的那行被删掉时，run_pair_eval 会**静默忽略**它 —— 三遍全不烧码，
    # 而 compare.ts 在不烧码时把 codeReadOk 一律记成 true，读码率显示 100%。
    #
    # ⚠️ 这道守卫原来 grep 的是 index.ts 里的字面词 burn_codes。978f78e 把 run_pair_eval
    # 抽进 pairEval.ts 之后，index.ts 里只剩汇总文字 `spec.burn_codes === true ? ' · 烧码' : ''`
    # 这一处 —— 守卫从「有人读它」静默变成了「有人把它印在摘要里」。真正的读法删掉，它照样绿。
    # 所以现在查的是 pairEval.ts 里**决定烧不烧码**的那两行，两行都得在。
    #
    # 两行都**按整行锚定**（re.M，行尾只许跟空白或 // 注释）。只匹配前缀的话，
    # `const burn = spec.burn_codes === true && false` 也会被认成「在读」—— owner 审 a2f5c10 时
    # 做的变异就活在这里。锚定之后，这两行一有改动守卫就拒绝生成，得有人回来重核：
    # 这正是「被测代码一改，旧验证作废」要的效果。
    # 行为另有纵深兜底：pairEval.test.ts（burn=true 时 codes 非空）、算分守卫②、冒烟核 code_a 非空。
    src = PAIR_EVAL_TS.read_text(encoding="utf-8") if PAIR_EVAL_TS.exists() else ""
    burn_line = re.search(r"^\s*const burn = spec\.burn_codes === true\s*(?://.*)?$", src, re.M)
    codes_line = re.search(r"^\s*const codes = burn \? assignCodes\([^)]*\) : undefined\s*(?://.*)?$", src, re.M)
    reads_it = bool(burn_line) and bool(codes_line)
    if not reads_it and not a.dry_run:
        raise SystemExit("❌ agent-v4/src/pairEval.ts 里找不到这两整行："
                         "「const burn = spec.burn_codes === true」与「const codes = burn ? assignCodes(…) : undefined」"
                         "（行尾只许跟空白或注释）—— 烧码开关可能没接上，或这两行被改过。"
                         "停手，回去核 pairEval.ts；只想看产物就加 --dry-run")

    placeholder = "@@PHOTOS@@"
    root = placeholder if a.repo else str(PHOTOS)
    out_dir = a.out or (STAGE3 / "calibration/specs" if a.repo else ARCHIVE)
    out_dir.mkdir(parents=True, exist_ok=True)

    pairs_src = json.loads(PAIRS.read_text(encoding="utf-8"))
    g, p = RUBRIC_GENERAL.read_bytes(), RUBRIC_PERSONAL.read_bytes()
    rubric = g.decode("utf-8").strip() + "\n\n" + p.decode("utf-8").strip()
    anc = json.loads(ANCHORS.read_text(encoding="utf-8"))

    pairs = []
    for i, q in enumerate(sorted(pairs_src, key=lambda q: q["gold"])):
        gold_in_a = (i % 2 == 0)
        pairs.append({
            "a": q["gold"] if gold_in_a else q["other"],
            "b": q["other"] if gold_in_a else q["gold"],
            "answer": "a" if gold_in_a else "b",
            "kind": "gold",
            "local_correct": q["score_gold"] > q["score_other"],
            "group": i,
        })

    common = {
        "folder": f"{root}/eval-people-309-acceptance",
        "pairs": pairs,
        "allow_neither": ALLOW_NEITHER,
        "burn_codes": True,
    }
    sources = {
        "pairs": f"calib-guarded-other.json md5 {md5(PAIRS.read_bytes())}",
        "rubric_general": f"rubric-crossscene-general.txt md5 {md5(g)}",
        "rubric_personal": f"rubric-crossscene-personal-example.txt md5 {md5(p)}",
        "anchors": f"anchors-crossscene.json md5 {md5(ANCHORS.read_bytes())}",
        "slot_rule": "按金标文件名排序，偶数位金标放 a、奇数位放 b",
    }
    anchors_block = {
        "folder": anc["folder"].replace(placeholder, root),
        "text": anc["text"], "photos": anc["photos"], "labels": anc["labels"],
    }
    arms = {
        "calib-arm1-none":           {**common, "rubric": ""},
        "calib-arm2-rubric":         {**common, "rubric": rubric},
        "calib-arm3-rubric-anchors": {**common, "rubric": rubric, "anchors": anchors_block},
    }

    written = {}
    for name, spec in arms.items():
        doc = {"_meta": {"arm": name, "sources": sources}, **spec}
        path = out_dir / f"{name}.json"
        path.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        written[name] = doc

    # ── 自检：三遍只在处理变量上不同 ─────────────────────────────────
    strip = lambda d, drop: {k: v for k, v in d.items() if k not in drop and k != "_meta"}
    a1, a2, a3 = (written[n] for n in arms)
    assert strip(a1, {"rubric"}) == strip(a2, {"rubric"}), "第一遍与第二遍除 rubric 外还有差异"
    assert strip(a2, {"anchors"}) == strip(a3, {"anchors"}), "第二遍与第三遍除 anchors 外还有差异"
    assert a1["rubric"] == "" and a2["rubric"] and a2["rubric"] == a3["rubric"]
    assert "anchors" not in a1 and "anchors" not in a2 and a3["anchors"]["photos"]
    names = {x for q in pairs for x in (q["a"], q["b"])}
    leak = names & set(anc["photos"])
    assert not leak, f"锚点与考题重名：{leak}"
    n_a = sum(1 for q in pairs if q["answer"] == "a")

    print(f"✅ 写到 {out_dir}")
    for n in arms:
        print(f"   {n}.json   md5 {md5((out_dir / f'{n}.json').read_bytes())}")
    print(f"   19 对 · 金标在 a 槽 {n_a} 对 / b 槽 {19 - n_a} 对 · allow_neither={ALLOW_NEITHER} · burn_codes=true")
    print(f"   自检：三遍只在处理变量上不同 ✓ · 锚点与考题零重名 ✓ · 第一遍 rubric 显式空 ✓")
    print(f"   rubric 拼接 md5 {md5(rubric.encode())}（{len(rubric)} 字）")
    if not reads_it:
        print("   ⚠️ --dry-run：pairEval.ts 里没找到烧码开关的读法，这批 spec 现在跑不会烧码")
    return 0


if __name__ == "__main__":
    sys.exit(main())
