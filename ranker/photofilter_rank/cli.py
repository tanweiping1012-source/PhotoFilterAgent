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
    p.add_argument("--cold", default="auto", choices=["auto", "face", "laion_aes", "blend"],
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
    )


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="photofilter-rank", description="本地优先的照片排序")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_scan = sub.add_parser("scan", help="只做本地扫描：数量、指纹、人脸检出率（最快，不算向量）")
    _common(p_scan)
    p_scan.add_argument("--json", type=Path, default=None)

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

    if a.cmd == "pick":
        res = rank_folder(cfg, verbose)
        print(f"\n模式 {res.mode}（{res.n_labels} 张标注）· {res.n_candidates} 张候选 "
              f"· {res.notes['n_families']} 个场景组 · {res.elapsed_sec}s")
        for w in res.notes.get("warnings", []):
            print(f"\n⚠ {w}")
        print(f"\n选出 {len(res.selected)} 张：")
        for i, n in enumerate(res.selected, 1):
            print(f"  {i:>2}. {n}   {res.scores[n]:+.2f}")
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
        base = zscore(cold_start_score(q, nm, cfg.cold_strategy)[0])
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
