"""PhotoFilter v4 — 本地优先的照片排序核心。

设计前提（有实测支撑，见 docs/versions/V4-local-first.md）：
  · 让视觉大模型给 0-100 打分，重评噪声 σ=7.28，而照片之间的差异只有 σ=6.72 → 分数是噪声。
  · 通用美学模型的天花板约 AUC 0.61，因为「大众审美」不是「你的口味」。
  · 用用户自己的 10-15 张标注训一个线性探针，AUC 0.69-0.71，成本为零。

所以 v4 把排序主干放在本地，视觉大模型只做它擅长的否决判断。
"""

__version__ = "0.9.0"

from .config import RankConfig
from .rank import rank_folder

__all__ = ["RankConfig", "rank_folder", "__version__"]
