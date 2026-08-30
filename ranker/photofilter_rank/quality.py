"""冷启动质量分：用户还没给标注时靠什么排序。

eval-people-309 实测（AUC / 前20命中 / 超几何 p 值）：

    liqe             0.449   0/20   1.000
    clipiqa+         0.473   1/20   0.749
    nima             0.481   0/20   1.000
    MiniMax 六维     0.497   3/20   0.130   ← 997 次付费调用
    随机             0.500   1.3/20   —
    topiq_iaa        0.512   0/20   1.000
    musiq-ava        0.548   0/20   1.000
    laion_aes        0.583   4/20   0.032  ✅
    topiq_nr-face    0.608   4/20   0.032  ✅

只有 laion_aes 和 topiq_nr-face 过了显著线，所以冷启动只考虑这两个。

━━ 为什么默认**不融合**这两个 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

直觉上把两个都过线的指标加权平均应该更好。实测下来 AUC 确实更高，
但**前 K 张反而更差，而且跨 K=10/20/30/40/50 一致**：

                        AUC     头部平均提升（相对随机）
    laion_aes 单独     0.583        2.47x
    topiq_nr-face 单独 0.606        2.51x
    秩融合 0.5         0.624        2.01x   ← AUC 更高，头部更差

原因：两个模型是**互补**的，不是一致的。它们各自在前 20 里命中 4 张金标，
但只重叠 2 张（并集 6 张）。平均两个互补排序器，会让各自笃定的头部
被对方的「无所谓」拉下来 —— 全局排序变好，头部被稀释。

产品交付的是「前 K 张」，所以选指标必须跟交付物对齐，不能只看 AUC。
交替取片也试过，同样是 2/20 —— 因为每个模型的金标散布在自己前 20 里，
不集中在前 10。

结论：冷启动**只用一个指标**，按人脸检出率自动路由。

━━ 后来的修正：最好的那个指标不在这张表里 ━━━━━━━━━━━━━━━━━━━━━━━━━━

上面整张表比的都是「下载来的模型」。真正最强的是 v1 就有的
**Apple Vision 人脸质量**：AUC 0.711、交付 5/20（p=0.0056），
比这里任何一个都好，而且同样免费。

它没进这张表，是因为 v1 的结论「本地技术指标和人的口味基本无关」
把它一起否掉了 —— 那个结论对清晰度/曝光成立，对人脸质量不成立。
详见 eligibility.py 的 EngineFacts。

所以人像池的默认策略是 vision_face，只有拿不到引擎时才退回 face（topiq）。
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np

# 人脸模型检不到脸就会报错。关键判断：「测不到」不等于「差」——
# 309 张里 38 张没检出脸，其中 2 张是人工精选。把它们一律罚到最低是错的。
# 所以无脸照片取该指标的**中位秩**，即「这个指标对它无信息」，由另一个指标决定。
NO_FACE_RANK = 0.5


def _run_metric(metric_name: str, cache_map: dict[str, Path], names: list[str], device: str,
                verbose: bool) -> tuple[dict[str, float], list[str]]:
    import pyiqa

    m = pyiqa.create_metric(metric_name, device=device)
    scores: dict[str, float] = {}
    failed: list[str] = []
    t0 = time.time()
    for i, name in enumerate(names, 1):
        try:
            scores[name] = float(m(str(cache_map[name])).item())
        except Exception:
            failed.append(name)
        if verbose and i % 100 == 0:
            print(f"  {metric_name} {i}/{len(names)}  {time.time() - t0:.0f}s", flush=True)
    if verbose:
        print(f"  {metric_name} 完成，{len(failed)} 张无结果，{time.time() - t0:.0f}s", flush=True)
    return scores, failed


def local_quality(
    cache_map: dict[str, Path], names: list[str], cache_dir: Path, fp: str,
    device: str, verbose: bool = True
) -> dict[str, dict[str, float]]:
    """返回 {'laion_aes': {name: score}, 'face': {...}, 'face_missing': {...}}。"""
    path = cache_dir / f"quality-v2-{fp}.json"
    if path.exists():
        data = json.loads(path.read_text())
        if set(data.get("laion_aes", {})) == set(names):
            if verbose:
                print("  质量分缓存命中", flush=True)
            return data

    laion, _ = _run_metric("laion_aes", cache_map, names, device, verbose)
    face, no_face = _run_metric("topiq_nr-face", cache_map, names, device, verbose)

    data = {
        "laion_aes": laion,
        "face": face,                                   # 只含检出脸的，不填哨兵
        "face_missing": {n: 1.0 for n in no_face},
        "face_detect_rate": len(face) / max(len(names), 1),
    }
    path.write_text(json.dumps(data))
    return data


def _rank(values: np.ndarray) -> np.ndarray:
    """转成 0..1 的百分位秩。用秩而不是 z-score —— 秩对离群值免疫，
    而且让两个量纲完全不同的指标（laion_aes 在 4~7，topiq_nr-face 在 0.18~0.61）可比。"""
    n = len(values)
    return np.argsort(np.argsort(values)) / max(n - 1, 1)


def zscore(values: np.ndarray) -> np.ndarray:
    sd = values.std()
    return (values - values.mean()) / (sd if sd > 1e-9 else 1.0)


def face_rank(quality: dict, names: list[str]) -> np.ndarray:
    """人脸质量的百分位秩；没检出脸的取中位（= 该指标对它无信息）。"""
    face = quality["face"]
    have = [i for i, n in enumerate(names) if n in face]
    out = np.full(len(names), NO_FACE_RANK)
    if have:
        out[have] = _rank(np.array([face[names[i]] for i in have]))
    return out


def choose_cold_strategy(quality: dict, names: list[str], configured: str) -> str:
    """人像池用人脸质量，否则用 laion_aes。

    路由依据是人脸检出率，不是用户声明 —— 用户说「这是人像文件夹」可能是错的，
    检出率是可观测的事实。309 张人像池实测检出率 0.877。

    人像池优先用 Apple Vision 的人脸质量（AUC 0.711）；拿不到引擎时
    才退回 topiq_nr-face（0.606）。
    """
    if configured != "auto":
        return configured
    rate = quality.get("face_detect_rate")
    if rate is None:
        rate = sum(1 for n in names if n in quality["face"]) / max(len(names), 1)
    if rate < 0.6:
        return "laion_aes"
    # 人像池默认 vision_face。两个数据集给出相反的偏好、均值几乎打平，
    # 选它的唯一理由是证据强度：数据集① 有 20 张金标，数据集② 只有 4 张。
    # 拿不到引擎时降级到 topiq_nr-face。
    return "vision_face" if quality.get("vision_face") else "face"


def mood_score(quality: dict, names: list[str]) -> tuple[np.ndarray, str]:
    """氛围优先：把通用美学分**翻转**过来。

    这不是笔误。实测在「按氛围挑」的那批照片上，6 个满覆盖的通用美学模型
    全部反向 —— 用户选的 4 张里有 2 张在 laion_aes 上排 132/133 和 133/133，
    是全池倒数第一和第二。

        指标            AUC（按氛围挑的那批）
        laion_aes       0.291  → 翻转后 0.709
        topiq_iaa       0.114  → 翻转后 0.886

    合理的解释：氛围往往伴随弱光、动态、颗粒、柔焦、逆光 ——
    而这些恰恰是技术画质模型要扣分的东西。

    ⚠️ 只有 4 张金标支撑，翻转后交付 2/4、p=0.11，不显著。
    """
    lai = _rank(np.array([quality["laion_aes"][n] for n in names]))
    return 1.0 - lai, "mood"


def cold_start_score(
    quality: dict[str, dict[str, float]], names: list[str], strategy: str = "auto",
    style: str = "quality",
) -> tuple[np.ndarray, str]:
    """返回 (分数, 实际用的策略)。

    'blend' 保留下来是为了让人能复现「融合更差」这个结论，不是推荐用法。
    """
    if style == "mood":
        return mood_score(quality, names)
    resolved = choose_cold_strategy(quality, names, strategy)
    if resolved == "vision_face":
        vf = quality.get("vision_face") or {}
        if vf:
            have = [i for i, n in enumerate(names) if n in vf]
            out = np.full(len(names), NO_FACE_RANK)
            out[have] = _rank(np.array([vf[names[i]] for i in have]))
            return out, resolved
        resolved = "face"          # 引擎没给上，如实降级
    lai = _rank(np.array([quality["laion_aes"][n] for n in names]))
    fac = face_rank(quality, names)
    if resolved == "laion_aes":
        return lai, resolved
    if resolved == "face":
        return fac, resolved
    return 0.5 * lai + 0.5 * fac, "blend"
