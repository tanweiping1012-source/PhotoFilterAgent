"""资格门：把本机免费算出来的硬伤挡在名单之外。

━━ 为什么需要这一层 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

v4 把排序主干挪回本地时，**把 v1 那层免费的资格门一起丢掉了**。代价实测：

    v4 选出的 20 张里闭眼        6 张（30%）
    全池闭眼基准率                8.2%
    用户自己挑的 20 张里闭眼      0 张

也就是说 v4 选闭眼照的比例是基准率的 3.7 倍，而用户一张都不要 ——
20 个名额里有 6 个浪费在了绝不会被接受的照片上。

CLIP embedding 看的是「画面语义」，它分不出眼睛睁没睁 ——
这恰恰是本地几何检测最擅长、而且**免费**的事。

━━ 为什么是「默认开、可关」而不是硬淘汰 ━━━━━━━━━━━━━━━━━━━━━━━━━━

v3 的 rubric 里明确写着「闭眼不是自动淘汰条件」，理由是闭眼可能是有意的风格
（闭目沉思、大笑眯眼）。这个顾虑是对的。

但实测这个用户的 20 张精选里闭眼 0 张 —— 对他而言这就是硬伤。
所以做成**默认开启、可以关掉、并且如实报告拦下了几张**，
而不是替用户做死决定。
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path


class EligibilityUnavailable(RuntimeError):
    """本地引擎不可用。不要静默跳过 —— 用户以为有资格门保护时必须知道它没生效。"""


class EngineFacts:
    """本地引擎一次扫描给出的全部免费事实。

    ━━ 人脸质量：本项目里最被低估的一个信号 ━━━━━━━━━━━━━━━━━━━━━━━

    Apple Vision 的 face capture quality，v1 就有，一分钱不花。
    v1 的结论是「本地技术指标和人的口味基本无关」，于是它被降级成
    「只用来描述底子，不用来定名次」。**那个结论对清晰度/曝光成立，
    对人脸质量不成立** —— 实测：

        指标                      AUC     交付前 20 命中
        Apple Vision 人脸质量    0.711        5/20  (p=0.0056)
        CLIP + topiq_nr-face     0.606        4/20  (p=0.0316)
        laion_aes                0.583          —
        全局清晰度                0.517          —
        v3 的 997 次付费打分      0.497        3/20  (p=0.1299)

    稳健性：20 张金标全部检出人脸；金标中位数 51 vs 非金标 38；
    无脸照片按「填中位 / 排最后 / 只在有脸的里比」三种处理，AUC 都在
    0.711–0.742；而「有没有检出脸」这个二值特征单独只有 0.554 ——
    信号确实来自质量分本身，不是「有没有脸」。

    另外全局清晰度与人脸质量的相关系数只有 −0.318，
    说明「整张图锐不锐」和「脸清不清楚」是两件事。
    """

    def __init__(self, closed_eyes: set[str], face_quality: dict[str, int],
                 big_face: set[str] | None = None):
        self.closed_eyes = closed_eyes
        self.face_quality = face_quality
        # 脸大到能做睁闭眼判定（引擎里的门槛是占画面 ≥0.8%）。
        # 用它当「特写 vs 环境人像」的代理 —— 见 config.py 的 stratify_by_face_size。
        self.big_face = big_face or set()


def engine_facts(
    folder: Path, engine: Path, workdir: Path, timeout: int = 900,
    cache_key: str | None = None,
) -> EngineFacts:
    """调 Swift 引擎扫一遍，取回闭眼判定和人脸质量分。

    引擎输出的是匿名 ID，真实路径只在它自己的 workdir 索引里 ——
    这一步在本机完成，文件名不进模型上下文。

    ━━ 为什么必须按数据集指纹缓存 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    **Apple Vision 的人脸质量不是确定性的。** 实测同一批 309 张照片扫两遍：
    106/280 张分数不同（差 1–5 分），检出人脸数 276 vs 282。
    （闭眼判定倒是完全稳定：27 vs 27，0 张不一致。）

    信号本身是好的 —— 照片之间标准差 13.94，重复扫描标准差 0.66，
    信噪比 21.2（对照 v3 的六维打分：6.72 / 7.28，信噪比 0.92）。
    三次扫描的 AUC 是 0.689 / 0.694 / 0.689，很稳。

    但**前 20 名这条切线对 ±1 分极度敏感** —— 边界附近挤着一堆照片，
    一分的抖动就换掉一张。实测同样输入连跑三次，交付命中 3 / 4 / 3。

    v4 的核心主张是「排序是确定性函数」。所以这里必须缓存：
    同一个数据集指纹只扫一次，之后永远复用。
    """
    if cache_key:
        cached = workdir / f'facts-{cache_key}.json'
        if cached.exists():
            d = json.loads(cached.read_text())
            return EngineFacts(set(d['closed_eyes']),
                               {k: int(v) for k, v in d['face_quality'].items()},
                               set(d.get('big_face') or ()))
    if not engine.exists():
        raise EligibilityUnavailable(f"本地分析引擎不存在：{engine}")
    workdir.mkdir(parents=True, exist_ok=True)
    try:
        out = subprocess.run(
            [str(engine), 'analyze', str(folder), '--workdir', str(workdir)],
            capture_output=True, text=True, timeout=timeout,
        )
    except subprocess.TimeoutExpired as e:
        raise EligibilityUnavailable(f'本地分析引擎超时（{timeout}s）') from e
    if out.returncode != 0:
        raise EligibilityUnavailable(f'本地分析引擎退出码 {out.returncode}：{out.stderr[-500:]}')

    report = json.loads(out.stdout)
    index = json.loads((workdir / 'index.json').read_text())
    by_anon = {k: Path(v).name for k, v in index['byAnonymous'].items()}
    closed: set[str] = set()
    quality: dict[str, int] = {}
    big: set[str] = set()
    for c in report.get('candidates', []):
        name = by_anon.get(c['id'])
        if name is None:
            continue
        if c.get('eyes_closed'):
            closed.add(name)
        if c.get('face_quality') is not None:
            quality[name] = int(c['face_quality'])
        # 引擎只在脸占画面 ≥0.8% 时才做睁闭眼判定，所以摘要串里出现「眼睛」
        # 就等价于「脸够大」。这是从现有输出里读出来的代理，没改引擎。
        if '眼睛' in (c.get('face') or ''):
            big.add(name)
    if cache_key:
        (workdir / f'facts-{cache_key}.json').write_text(
            json.dumps({'closed_eyes': sorted(closed), 'face_quality': quality,
                        'big_face': sorted(big)})
        )
    return EngineFacts(closed, quality, big)
