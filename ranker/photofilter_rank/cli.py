"""命令行入口。

    photofilter-rank pick   <文件夹> --target 20 [--labels 我喜欢的.txt]
    photofilter-rank eval   <文件夹> --gold 答案.txt --target 20
    photofilter-rank curve  <文件夹> --gold 答案.txt
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np


def _common(p: argparse.ArgumentParser) -> None:
    p.add_argument("folder", type=Path)
    p.add_argument("--target", type=int, default=20)
    p.add_argument("--exclude", nargs="*", default=[], help="要排除的相对路径（人工答案子目录）")
    p.add_argument("--cache", type=Path, default=None)
    p.add_argument("--device", default="auto")
    p.add_argument("--engine", type=Path, default=None,
                   help="Swift 本地分析引擎路径，用于闭眼资格门（不给则资格门不生效并报告）")
    p.add_argument("--no-eligibility", action="store_true",
                   help="关掉闭眼资格门。实测关掉后 20 张里有 6 张闭眼，而用户自己一张不选")
    p.add_argument("--stratify", action="store_true",
                   help="按人脸大小分层排序。修 Apple Vision 对小脸的系统性低估；"
                        "K=20 时略差（3.2 vs 3.6），K=50 时接近两倍好（9.4 vs 4.8）")
    p.add_argument("--style", default="quality", choices=["quality", "mood"],
                   help="quality=挑拍得清楚好看的（默认）；mood=挑有氛围的（把美学分翻转）")
    p.add_argument("--cold", default="auto", choices=["auto", "vision_face", "face", "laion_aes", "blend"],
                   help="冷启动用哪个指标；blend 只为复现「融合更差」的结论，不推荐")
    p.add_argument("--quiet", action="store_true")


def _cfg(a) -> "RankConfig":
    from .config import DEFAULT_CACHE, RankConfig

    return RankConfig(
        folder=a.folder.expanduser().resolve(),
        target=a.target,
        labels=getattr(a, "labels", None),
        exclude=tuple(a.exclude),
        cache_dir=(a.cache or DEFAULT_CACHE).expanduser(),
        device=a.device,
        cold_strategy=getattr(a, "cold", "auto"),
        style=getattr(a, "style", "quality"),
        stratify_by_face_size=getattr(a, "stratify", False),
        block_closed_eyes=not getattr(a, "no_eligibility", False),
        engine_binary=getattr(a, "engine", None),
    )


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="photofilter-rank", description="本地优先的照片排序")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_scan = sub.add_parser("scan", help="只做本地扫描：数量、指纹、人脸检出率（最快，不算向量）")
    _common(p_scan)
    p_scan.add_argument("--json", type=Path, default=None)

    p_prev = sub.add_parser("preview", help="给指定照片生成无元数据的小图（base64），供成对比较用")
    _common(p_prev)
    p_prev.add_argument("--names", nargs="+", required=True, help="要出图的文件名")
    p_prev.add_argument("--size", type=int, default=512, help="最长边像素（默认 512）")
    p_prev.add_argument("--json", type=Path, required=True)

    p_pairs = sub.add_parser("pairs", help="阶段2：导出组内比较的考题（含正确答案），供成对评测用")
    _common(p_pairs)
    p_pairs.add_argument("--gold", type=Path, required=True, help="人工精选清单")
    p_pairs.add_argument("--json", type=Path, required=True)

    p_pick = sub.add_parser("pick", help="挑出最好的 N 张")
    _common(p_pick)
    p_pick.add_argument("--labels", type=Path, default=None, help="你喜欢的照片文件名清单，每行一个")
    p_pick.add_argument("--json", type=Path, default=None, help="把完整结果写到这个文件")

    p_eval = sub.add_parser("eval", help="有人工答案时，测排序器到底行不行")
    _common(p_eval)
    p_eval.add_argument("--labels", type=Path, default=None)
    p_eval.add_argument("--gold", type=Path, required=True, help="人工精选清单（答案）")
    p_eval.add_argument("--json", type=Path, default=None)

    p_curve = sub.add_parser("curve", help="学习曲线：需要几张标注才够")
    _common(p_curve)
    p_curve.add_argument("--gold", type=Path, required=True)
    p_curve.add_argument("--sizes", type=int, nargs="*", default=[3, 5, 10, 15])
    p_curve.add_argument("--splits", type=int, default=200)
    p_curve.add_argument("--protocol", default="production", choices=["production", "research"],
                         help="production=复刻产品真实条件（默认）；research=留出正样本不参与训练，乐观上界")

    a = ap.parse_args(argv)
    verbose = not a.quiet
    cfg = _cfg(a)

    from .evaluate import holdout_curve, report
    from .rank import rank_folder, result_to_json

    if a.cmd == "scan":
        from .scan import build_cache, fingerprint, list_photos
        photos = list_photos(cfg.folder, cfg.exclude)
        if not photos:
            print(f"{cfg.folder} 里没有找到照片")
            return 1
        fp = fingerprint(photos, cfg.folder)
        out = {
            "n_photos": len(photos),
            "fingerprint": fp,
            "folder": str(cfg.folder),
            "names": [p.name for p in photos],
        }
        print(f"候选 {len(photos)} 张 · 指纹 {fp}")
        if a.json:
            a.json.write_text(json.dumps(out, ensure_ascii=False))
            print(f"→ {a.json}")
        return 0

    if a.cmd == "preview":
        # 只从**已建好的降采样缓存**再缩一次，绝不碰原图 ——
        # 缓存本身已经剥掉了全部元数据（实测 EXIF 字段 0 个、无 GPS 标记）。
        import base64
        import hashlib
        from io import BytesIO

        from PIL import Image

        from .scan import list_photos
        photos = {p.name: p for p in list_photos(cfg.folder, cfg.exclude)}
        out: dict[str, str] = {}
        missing: list[str] = []
        for name in a.names:
            src = photos.get(name)
            if src is None:
                missing.append(name)
                continue
            key = hashlib.sha256(str(src).encode()).hexdigest()[:24] + ".jpg"
            thumb = cfg.cache_dir / "thumbs" / key
            if not thumb.exists():
                missing.append(name)
                continue
            im = Image.open(thumb).convert("RGB")
            im.thumbnail((a.size, a.size), Image.LANCZOS)
            buf = BytesIO()
            im.save(buf, "JPEG", quality=82)      # 与 v3 的 low 档一致
            out[name] = base64.b64encode(buf.getvalue()).decode()
        a.json.write_text(json.dumps({"previews": out, "missing": missing}, ensure_ascii=False))
        print(f"生成 {len(out)} 张 {a.size}px 预览" + (f"，{len(missing)} 张缺失" if missing else ""))
        return 0

    if a.cmd == "pairs":
        # 阶段 2 的考题。组级验收（13 组）功效不足 —— 连 12/13 都只有 p=0.057，
        # 所以改成对级：同组内「金标 vs 非金标」每一对算一道题，样本量 13 → 99。
        import numpy as np

        from .dedupe import group_by_similarity, suggest_threshold
        from .eligibility import EligibilityUnavailable, engine_facts
        from .embed import embed_photos
        from .quality import local_quality
        from .scan import build_cache, fingerprint, list_photos
        from .stage2 import eval_pairs, multi_groups

        photos = list_photos(cfg.folder, cfg.exclude)
        fp = fingerprint(photos, cfg.folder)
        cm = build_cache(photos, cfg.cache_dir / "thumbs", cfg.max_side, cfg.jpeg_quality, not a.quiet)
        X, names = embed_photos(cm, cfg.cache_dir, fp, cfg.resolve_device(), not a.quiet)
        q = local_quality(cm, names, cfg.cache_dir, fp, cfg.resolve_device(), not a.quiet)

        blocked: set[str] = set()
        if cfg.engine_binary is not None:
            try:
                facts = engine_facts(cfg.folder, cfg.engine_binary,
                                     cfg.cache_dir / "engine", cache_key=fp)
                blocked = facts.closed_eyes & set(names)
            except EligibilityUnavailable:
                pass

        rank = lambda v: (np.argsort(np.argsort(v)) / (len(v) - 1.0))
        face = q.get("face", {})
        have = [i for i, n in enumerate(names) if n in face]
        score = np.full(len(names), 0.5)
        if have:
            score[have] = rank(np.array([face[names[i]] for i in have]))
        else:
            score = rank(np.array([q["laion_aes"][n] for n in names]))

        fams = group_by_similarity(X, suggest_threshold(X, cfg.family_percentile, cfg.cosine_floor))
        gold = {ln.strip() for ln in a.gold.read_text().splitlines() if ln.strip()} & set(names)
        pairs = eval_pairs(names, list(fams), score.tolist(), gold, blocked)
        groups = multi_groups(list(fams))

        payload = {
            "fingerprint": fp,
            "n_photos": len(names),
            "n_groups": len(set(fams)),
            "n_multi_groups": len(groups),
            "n_gold": len(gold),
            "local_baseline": round(sum(p.local_correct for p in pairs) / max(len(pairs), 1), 4),
            "pairs": [
                {"a": p.a, "b": p.b, "answer": p.answer, "kind": p.kind,
                 "local_correct": p.local_correct, "group": p.group}
                for p in pairs
            ],
        }
        a.json.write_text(json.dumps(payload, ensure_ascii=False, indent=2))
        ng = sum(1 for p in pairs if p.kind == "gold")
        ne = sum(1 for p in pairs if p.kind == "eyes")
        wrong = sum(1 for p in pairs if not p.local_correct)
        print(f"考题 {len(pairs)} 道：金标类 {ng} · 闭眼类 {ne}")
        print(f"本地分基线 {payload['local_baseline']:.1%}，其中判错 {wrong} 道 —— 那是模型的增量空间")
        return 0

    if a.cmd == "pick":
        res = rank_folder(cfg, verbose)
        print(f"\n模式 {res.mode}（{res.n_labels} 张标注）· {res.n_candidates} 张候选 "
              f"· {res.notes['n_families']} 个场景组 · {res.elapsed_sec}s")
        for w in res.notes.get("warnings", []):
            print(f"\n⚠ {w}")
        print(f"\n选出 {len(res.selected)} 张：")
        for i, n in enumerate(res.selected, 1):
            print(f"  {i:>2}. {n}   {res.scores[n]:+.2f}")
        if res.notes.get("n_blocked"):
            print(f"\n资格门拦下 {res.notes['n_blocked']} 张闭眼照（仍留在候选池里，只是不进名单）")
        if res.notes.get("relaxed"):
            print(f"\n⚠ 同组上限从 {cfg.family_cap} 放宽到 {res.notes['family_cap_used']} 才凑满 {a.target} 张")
        if a.json:
            a.json.write_text(result_to_json(res))
            print(f"\n完整结果 → {a.json}")
        return 0

    gold = {ln.strip() for ln in a.gold.read_text().splitlines() if ln.strip()}
    res = rank_folder(cfg, verbose)

    # 用户给了标注就必须把这些照片排除出评测 —— 它们是训练数据。
    # 不排除的话，「标注置顶」这一步会让它们全部命中，AUC 直接虚高到 0.76、
    # 前 20 命中 10/20，而那 10 张正是喂进去的答案。这是自欺欺人。
    trained = set(res.notes.get("labels_used", []))
    ordered = [n for n in sorted(res.scores) if n not in trained]
    s = np.array([res.scores[n] for n in ordered])
    y = np.array([1.0 if n in gold else 0.0 for n in ordered])

    if a.cmd == "eval":
        # 产品交付的是 res.selected（过了同组限流），不是按分数的前 K。
        # 只报后者会高估 —— 实测过一次 4/20 vs 真实交付 3/20。
        delivered = np.array([1.0 if n in gold else 0.0
                              for n in res.selected if n not in trained])
        r = report(s, y, a.target, delivered=delivered)
        if a.json:
            a.json.write_text(json.dumps(
                {**r, "mode": res.mode, "notes": res.notes, "selected": res.selected,
                 "elapsed_sec": res.elapsed_sec, "excluded_trained": sorted(trained)},
                ensure_ascii=False))
        for w in res.notes.get("warnings", []):
            print(f"\n⚠ {w}")
        if trained:
            print(f"\n（已从评测中剔除 {len(trained)} 张训练标注，"
                  f"其中金标 {len(trained & gold)} 张；剩余金标 {int(y.sum())} 张）")
        print(f"\n=== 评测 · {res.mode} 模式"
              + (f" · 冷启动指标 {res.notes['cold_strategy']}" if res.mode == "cold" else "") + " ===")
        dp = r.get("delivered_p_value", 1.0)
        print(f"  ── 实际交付的名单（产品给用户的就是这个）──")
        print(f"  交付命中        {r.get('delivered_hits','?')}/{r['n_gold']}"
              f"   共交付 {r.get('delivered_n','?')} 张   随机期望 {r['random_expected']}")
        print(f"  超几何 p 值     {dp:.4f}   {'✅ 显著' if dp < 0.05 else '⚠ 与运气区分不开'}")
        print(f"  ── 排序本身（不含同组限流）──")
        print(f"  AUC            {r['auc']:.3f}   (0.5 = 掷硬币)")
        print(f"  按分数前 {r['k']}    {r['hits']}/{r['n_gold']}"
              f"   {'（限流后会变，以交付为准）' if r['hits'] != r.get('delivered_hits') else ''}")
        print(f"  超几何 p 值     {r['p_value']:.4f}")
        print(f"  头部提升        {r['lift_mean']:.2f}x   (K=10/20/30/40/50 平均，相对随机)")
        print(f"  候选 {r['n_total']} 张 · 耗时 {res.elapsed_sec}s · 付费调用 0 次")
        return 0

    if a.cmd == "curve":
        from .embed import embed_photos
        from .quality import cold_start_score, local_quality, zscore
        from .scan import build_cache, fingerprint, list_photos

        photos = list_photos(cfg.folder, cfg.exclude)
        fp = fingerprint(photos, cfg.folder)
        cm = build_cache(photos, cfg.cache_dir / "thumbs", cfg.max_side, cfg.jpeg_quality, False)
        X, nm = embed_photos(cm, cfg.cache_dir, fp, cfg.resolve_device(), False)
        q = local_quality(cm, nm, cfg.cache_dir, fp, cfg.resolve_device(), False)
        # 冷启动基线必须和 pick/eval 走同一条路，否则曲线比的是另一个东西。
        if cfg.engine_binary is not None:
            from .eligibility import EligibilityUnavailable, engine_facts
            try:
                facts = engine_facts(cfg.folder, cfg.engine_binary,
                                     cfg.engine_workdir or (cfg.cache_dir / 'engine'),
                                     cache_key=fp)
                q['vision_face'] = {k: v for k, v in facts.face_quality.items() if k in set(nm)}
            except EligibilityUnavailable as e:
                print(f'⚠ 引擎不可用，冷启动基线降级：{e}')
        base_raw, base_strategy = cold_start_score(q, nm, cfg.cold_strategy)
        base = zscore(base_raw)
        print(f'冷启动基线用的是 {base_strategy}')
        yy = np.array([1.0 if n in gold else 0.0 for n in nm])
        curve = holdout_curve(X, yy, tuple(a.sizes), a.splits, baseline=base,
                              probe_iters=cfg.probe_iters, protocol=a.protocol)
        print(f"\n协议 {a.protocol}"
              + ("（复刻产品真实条件）" if a.protocol == "production" else "（乐观上界，留出正样本不参与训练）"))
        print(f"\n{'标注数':<8}{'探针 AUC':>17}{'冷启动':>10}{'胜过冷启动':>12}")
        print("-" * 50)
        for m, v in curve.items():
            better = v["probe_auc"] > v.get("baseline_auc", 0)
            print(f"{m:<8}{v['probe_auc']:>11.3f}±{v['probe_std']:.3f}"
                  f"{v.get('baseline_auc', float('nan')):>10.3f}"
                  f"{v.get('beats_cold_pct', float('nan')):>10.0f}%  {'✅' if better else ''}")
        print("-" * 50)
        print("低于冷启动的行说明：标这么少还不如不标，工具会自动用冷启动。")
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
