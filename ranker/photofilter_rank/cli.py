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
    p_prev.add_argument("--with-face", action="store_true",
                        help="额外出一张高清人脸。发给视觉模型的 512px 小图上，"
                             "环境人像的脸只剩约 30 像素，91%% 的照片不足 48 像素 —— "
                             "模型看不见表情，只能猜")
    p_prev.add_argument("--face-size", type=int, default=448, help="人脸裁切的边长（默认 448）")
    p_prev.add_argument("--label-map", type=Path, default=None,
                        help="给图烧标签用的 JSON：{文件名: \"例1甲\"}。"
                             "整幅图会烧「例1甲 · 整幅」，人脸图烧「例1甲 · 人脸」。"
                             "「这是第几张」这个问题用提示词绕了三次都没绕干净 —— "
                             "烧进图里模型就不用数数了")
    p_prev.add_argument("--subject-size", type=int, default=768,
                        help="人物区域裁切的长边（默认 768，此时人脸约 100~134 像素）")
    p_prev.add_argument("--verify", action="store_true",
                        help="把即将发出去的每张图打开量一遍：方向对不对、元数据剥干净没有、"
                             "人脸够不够大。这个项目最贵的两个 bug 日志和指标全是正常的，"
                             "只有真的打开图才看得见")
    p_prev.add_argument("--min-face-px", type=int, default=96,
                        help="整幅小图上人脸至少要有多少像素才算模型看得见（默认 96）")
    p_prev.add_argument("--code-map", type=Path, default=None,
                        help="仪器标定用：{文件名: 编码}。**加边**写在图上方，不覆盖画面 —— "
                             "编码是要被准确读出来的判别信道，压住画面就分不清"
                             "「位置驱动」和「被挡住了」")
    p_prev.add_argument("--degrade", type=float, default=0.0,
                        help="仪器标定用：高斯模糊半径。造一个**明显更差**的副本做正对照 —— "
                             "同一张照片、只注入一个真实缺陷，真值无争议")
    p_prev.add_argument("--quality-delta", type=int, default=0,
                        help="仪器标定用：JPEG 质量下调 N 档，生成肉眼无差、字节不同的副本（δ 条件）")
    p_prev.add_argument("--json", type=Path, required=True)

    p_pairs = sub.add_parser("pairs", help="阶段2：导出组内比较的考题（含正确答案），供成对评测用")
    _common(p_pairs)
    p_pairs.add_argument("--gold", type=Path, required=True, help="人工精选清单")
    p_pairs.add_argument("--json", type=Path, required=True)

    p_pick = sub.add_parser("pick", help="挑出最好的 N 张")
    _common(p_pick)
    p_pick.add_argument("--labels", type=Path, default=None, help="你喜欢的照片文件名清单，每行一个")
    p_pick.add_argument("--json", type=Path, default=None, help="把完整结果写到这个文件")
    p_pick.add_argument("--verdicts", type=Path, default=None,
                        help="VLM 复核的裁决（TS 侧跑完回传）。用它替换组内名次后重出名单")

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

        from PIL import Image, ImageOps

        from .scan import list_photos, thumb_key
        photos = {p.name: p for p in list_photos(cfg.folder, cfg.exclude)}
        out: dict[str, str] = {}
        faces: dict[str, str] = {}
        missing: list[str] = []
        boxes: dict[str, list[float]] = {}
        labels: dict[str, str] = {}
        if getattr(a, "label_map", None) and a.label_map.exists():
            labels = {k: str(v) for k, v in json.loads(a.label_map.read_text()).items()}
        codes: dict[str, str] = {}
        if getattr(a, "code_map", None) and a.code_map.exists():
            codes = {k: str(v) for k, v in json.loads(a.code_map.read_text()).items()}
        qd = max(0, int(getattr(a, "quality_delta", 0) or 0))
        dg = max(0.0, float(getattr(a, "degrade", 0.0) or 0.0))
        if getattr(a, "with_face", False):
            from .eligibility import EligibilityUnavailable, engine_facts
            from .scan import fingerprint
            try:
                fp = fingerprint(list_photos(cfg.folder, cfg.exclude), cfg.folder)
                boxes = engine_facts(cfg.folder, cfg.engine_binary,
                                     cfg.cache_dir / 'engine', cache_key=fp).face_box
            except (EligibilityUnavailable, TypeError):
                boxes = {}
        for name in a.names:
            src = photos.get(name)
            if src is None:
                missing.append(name)
                continue
            thumb = cfg.cache_dir / "thumbs" / thumb_key(src)
            if not thumb.exists():
                missing.append(name)
                continue
            im = Image.open(thumb).convert("RGB")
            im.thumbnail((a.size, a.size), Image.LANCZOS)
            if labels.get(name):
                from .label_image import burn_label
                im = burn_label(im, f"{labels[name]} · 整幅")
            if dg > 0:
                from PIL import ImageFilter
                im = im.filter(ImageFilter.GaussianBlur(dg))
            if codes.get(name):
                from .label_image import burn_code
                im = burn_code(im, codes[name])
            buf = BytesIO()
            im.save(buf, "JPEG", quality=82 - qd)  # 与 v3 的 low 档一致；qd 只在 δ 条件下非 0
            out[name] = base64.b64encode(buf.getvalue()).decode()
            if getattr(a, "with_face", False) and name in boxes:
                # 人脸从**原图**裁，不从缩略图 —— 缩略图上的脸本来就已经糊了。
                # Vision 的包围盒原点在左下，PIL 在左上，Y 要翻。
                x, y, bw, bh = boxes[name]
                # 必须先应用 EXIF 方向再裁。
                #
                # 踩过：引擎解码时带 kCGImageSourceCreateThumbnailWithTransform，
                # 坐标是在**旋转后**的画面里；而 PIL 的 Image.open 不应用方向标记。
                # 这批照片的 orientation = 8（旋转 90°），两个坐标系差一次旋转 ——
                # 裁出来的是天空和树，而且不会报错，会静默把废图发给模型。
                full = ImageOps.exif_transpose(Image.open(src)).convert("RGB")
                W, H = full.size
                cx, cy = (x + bw / 2) * W, (1 - (y + bh / 2)) * H
                half = max(bw * W, bh * H) * 0.95      # 外扩，要看得见眉毛和脸颊
                crop = full.crop((int(max(0, cx - half)), int(max(0, cy - half)),
                                  int(min(W, cx + half)), int(min(H, cy + half))))
                crop = crop.resize((a.face_size, a.face_size), Image.LANCZOS)
                if labels.get(name):
                    from .label_image import burn_label
                    crop = burn_label(crop, f"{labels[name]} · 人脸")
                if dg > 0:
                    from PIL import ImageFilter
                    # 人脸按尺寸等比放大模糊半径 —— 448px 的脸和 512px 的整幅
                    # 用同一个绝对半径的话，脸上的糊程度会明显不如整幅。
                    crop = crop.filter(ImageFilter.GaussianBlur(dg * a.face_size / a.size))
                if codes.get(name):
                    from .label_image import burn_code
                    crop = burn_code(crop, codes[name])
                fb = BytesIO()
                crop.save(fb, "JPEG", quality=86 - qd)
                faces[name] = base64.b64encode(fb.getvalue()).decode()

        report: dict[str, list[str]] = {}
        if getattr(a, "verify", False):
            # 不看过程，看东西本身。这是唯一能自动发现「规格错了」的办法 ——
            # 每一步都按规格执行了，但规格本身把图转了 90°、或者让人脸只剩 30 像素。
            from .sent_image_check import check_sent_pair
            for name, b64 in out.items():
                fb = faces.get(name)
                imgs = {"人物区域": base64.b64decode(b64)}
                if fb:
                    imgs["人脸特写"] = base64.b64decode(fb)
                res = check_sent_pair(imgs, photos[name], a.min_face_px)
                if res.issues:
                    report[name] = [f"[{i.severity}] {i.name}: {i.detail}" for i in res.issues]

        a.json.write_text(json.dumps(
            {"previews": out, "faces": faces, "missing": missing, "verify": report},
            ensure_ascii=False))
        if getattr(a, "verify", False):
            errs = sum(1 for v in report.values() if any("[error]" in x for x in v))
            print(f"  自检：{len(out) + len(faces)} 张图，{len(report)} 张有问题（其中 {errs} 张是硬错误）")
            for k, v in list(report.items())[:8]:
                print(f"    {k}  {v[0]}")
        print(f"生成 {len(out)} 张 {a.size}px 预览"
              + (f" + {len(faces)} 张 {a.face_size}px 高清人脸" if faces else "")
              + (f"，{len(missing)} 张缺失" if missing else ""))
        return 0

    if a.cmd == "pairs":
        # 阶段 2 的考题。组级验收（13 组）功效不足 —— 连 12/13 都只有 p=0.057，
        # 所以改成对级：同组内「金标 vs 非金标」每一对算一道题，样本量 13 → 99。
        #
        # ⚠️ 这里**不能**再写 import numpy as np。函数里任何一处局部 import
        # 会让 np 在整个 main() 里都变成局部名，模块顶层那个 import 就被遮住 ——
        # 走 eval / curve 分支（不经过这里）时，第 340 行的 np 直接 UnboundLocalError。
        # 实测：photofilter-rank eval 整个命令是崩的，而 agent 的
        # evaluate_against_answer 正是调它。
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
        # 有 VLM 裁决就用回放裁判：Python 这边拿不到模型，

        # 所以先出计划、TS 侧跑完、再把裁决喂回来重放。

        judge = None

        if getattr(a, "verdicts", None) and a.verdicts.exists():

            import json as _json

            from .pipeline import LocalJudge, ReplayJudge, load_verdicts

            raw = _json.loads(a.verdicts.read_text())

            # 校验与归一化在 pipeline.load_verdicts 里，那里有测试覆盖。
            vd = load_verdicts(raw)

            judge = ReplayJudge(vd, LocalJudge({}))

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
