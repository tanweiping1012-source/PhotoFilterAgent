"""让 `pytest` 从**仓库根**跑也能 import 到 `photofilter_rank`。

为什么需要它：包在 `ranker/` 下，`ranker/pyproject.toml` 写着 `testpaths = ["tests"]`，
所以只有 `cd ranker && pytest` 才跑得起来。从仓库根跑会在 collection 阶段就
`ModuleNotFoundError: No module named 'photofilter_rank'` —— 报错够响，
但**一个「只有从某个目录跑才生效」的守卫等于半个守卫**：
换个人、换个 CI 配置、换个 IDE 的默认工作目录，它就静默不跑了。

这个项目的教训是「没有触发器的守卫和没有守卫差别不大」，所以把路径问题在这里一次解决，
而不是指望每个人都记得先 cd。
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "ranker"))
