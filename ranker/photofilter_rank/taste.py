"""个人口味探针 —— 从用户自己标过的照片里学。

在 CLIP embedding 上训一个带类别平衡和 L2 正则的逻辑回归，正样本是用户标过的照片，
其余全部当负样本（positive-unlabeled 设定）。

━━ 这里有三个必须说清楚的陷阱，我们全都踩过 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**陷阱一：评测协议要复刻产品条件。**
做学习曲线时若把「留出的正样本」完全排除在训练之外，测的是特征可分性的
**乐观上界**；产品里用户只标 m 张，其余好照片就躺在未标注里当负样本。
本项目 m=10 实测：研究协议 0.723 / 产品协议 0.673。

**陷阱二：迭代步数不是越多越好。**
只有 10 个正样本对 768 个维度，跑太多步就把那 10 张背下来了。实测（产品协议）：

    iters      m=3     m=5    m=10    m=15
     200     0.576   0.574   0.606   0.657
     400     0.570   0.598   0.645   0.695
     800     0.555   0.610   0.673   0.713    ← 默认
    1500     0.562   0.604   0.670   0.701

**陷阱三（最要命）：标注**怎么选**比标几张更重要。**
CLIP embedding 强烈编码「场景内容」。如果用户只标了旅程前半段的照片，
模型学到的是「像那个地方的照片」，不是「好照片」——
换到后半段的新地点就完全失效。详见 config.py 里的 `min_labels` 注释。

**结论：标注必须分散在整批照片里。** 产品应该引导用户翻完整批再标，
而不是在开头连着点十下。
"""
from __future__ import annotations

import numpy as np


def fit_probe(
    X: np.ndarray, y: np.ndarray, l2: float = 3.0, iters: int = 800, lr: float = 0.5
) -> tuple[np.ndarray, float]:
    """类别平衡的逻辑回归。

    为什么手写而不是用 sklearn：只为了少一个依赖。20 正 / 289 负、768 维，
    梯度下降 3000 步在 numpy 里不到一秒。

    类别权重是必须的 —— 正负比 1:14，不加权的话模型直接全预测负例。
    """
    w = np.zeros(X.shape[1])
    b = 0.0
    pos = y.sum()
    neg = len(y) - pos
    cw = np.where(y == 1, neg / max(pos, 1.0), 1.0)
    for _ in range(iters):
        pred = 1.0 / (1.0 + np.exp(-np.clip(X @ w + b, -30, 30)))
        g = cw * (y - pred)
        w += lr * (X.T @ g / len(y) - l2 * w / len(y))
        b += lr * g.mean()
    return w, b


def label_concentration(X: np.ndarray, positives: np.ndarray) -> float:
    """标注有多集中：标注之间的中位余弦 ÷ 全池的中位余弦。

    ≈1.0  标注分散在整批照片里 —— 探针学到的是「什么样的照片好」
    >1.05 标注挤在同一段/同一地点 —— 探针学到的是「像那个地方的照片」

    实测（本项目 309 张）：

        标注选法          集中度      留出 AUC
        随机分散          0.98–1.00   0.60–0.73
        连续一段          1.02–1.14   0.39–0.55   ← 比不标还差，比随机还差

    集中度与 AUC 的相关系数 −0.495。以 1.05 为界：
    判为分散的 104 例平均 AUC 0.647，判为集中的 42 例平均 0.476。

    这个数**只用标注本身就能算**，不需要任何答案 —— 所以可以在产品里当护栏用。

    前提假设：全池的中位余弦是个有意义的正数。CLIP embedding 满足这一点
    （本项目实测 0.798，随便两张自然照片都有很高的基线相似度）。
    如果换了别的编码器、中位余弦接近 0，比值就没有意义 ——
    这时返回 1.0（不触发护栏），而不是给出一个假的判断。
    """
    if len(positives) < 2:
        return 1.0
    sim = X @ X.T
    iu = np.triu_indices(len(X), 1)
    pool = float(np.median(sim[iu]))
    if pool < 0.2:                       # 编码器的基线相似度太低，这个指标不适用
        return 1.0
    sub = sim[np.ix_(positives, positives)]
    k = np.triu_indices(len(positives), 1)
    return float(np.median(sub[k]) / pool)


class TasteProbe:
    """标准化 + 探针，打包成一个可复用的口味模型。"""

    def __init__(self, mean: np.ndarray, std: np.ndarray, w: np.ndarray, b: float, n_labels: int):
        self.mean, self.std, self.w, self.b, self.n_labels = mean, std, w, b, n_labels

    @classmethod
    def train(cls, X: np.ndarray, positives: np.ndarray, **kw) -> "TasteProbe":
        y = np.zeros(len(X))
        y[positives] = 1.0
        mean, std = X.mean(0), X.std(0)
        std = np.where(std < 1e-9, 1.0, std)
        w, b = fit_probe((X - mean) / std, y, **kw)
        return cls(mean, std, w, b, int(y.sum()))

    def score(self, X: np.ndarray) -> np.ndarray:
        return ((X - self.mean) / self.std) @ self.w + self.b
