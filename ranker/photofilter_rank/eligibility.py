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


def closed_eye_names(
    folder: Path, engine: Path, workdir: Path, timeout: int = 900
) -> set[str]:
    """调 Swift 引擎扫一遍，返回判定为闭眼的文件名集合。

    引擎输出的是匿名 ID，真实路径只在它自己的 workdir 索引里 ——
    这一步在本机完成，文件名不进模型上下文。
    """
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
    return {
        by_anon[c['id']]
        for c in report.get('candidates', [])
        if c.get('eyes_closed') and c['id'] in by_anon
    }
