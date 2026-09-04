#!/usr/bin/env python3
"""生成 rubric/锚点三组实验的 --patch 覆盖层。

判据见 CRITERIA-RUBRIC-ANCHORS.md（跑之前写死的）。

━━ 为什么要脚本生成而不是手写三个 yaml ━━━━━━━━━━━━━━━━━━━━━━━━

`--patch` 里的 `config` 是**整段替换，不是合并**。手写只放要改的两项，
会把 allowedRoots / engineBinary / stage2Vlm 等 12 项一起抹掉 ——
跑起来报「没有配置照片授权目录」。

更阴的是它**骗过验证**：三组被同样地削掉，两两 diff 反而干净地「只差两行」。
所以这里从**部署中的 profile** 读出完整 config，只改那两项，
三组之间除此之外逐字节相同 —— 这是设计上的保证，不靠人记得。

用法：
    python3 make_arms.py [输出目录]
"""
import copy
import io
import os
import sys

import yaml

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DSH_HOME = os.environ.get("DSH_HOME", os.path.expanduser("~/.dsh-v4"))
PROFILE = os.path.join(DSH_HOME, "profiles", "photo-v4-headless", "cordis.patch.yml")
RUBRIC = os.path.join(REPO, "dsh-v4", "rubric", "rubric-v2-prompt.txt")
ANCHORS = os.path.join(DSH_HOME, "anchors.json")

#: 三组只在这两项上不同。顺序即「阶梯」：每一步只加一个东西。
ARMS = (
    ("control", "", "", "对照组：完整 agent 流程，**无 rubrics、无范例锚点**。"),
    ("rubric", RUBRIC, "", "实验组 1：完整 agent 流程 + rubrics，**无范例锚点**。"),
    ("treat", RUBRIC, ANCHORS, "实验组 2：完整 agent 流程 + rubrics + 范例锚点。"),
)

HEADER = """# {note}
#
# 由 make_arms.py 从部署中的 profile 生成。**不要手写这个文件** ——
# --patch 的 config 是整段替换不是合并，漏一项就会静默抹掉生产配置，
# 而三组被同样地抹掉时两两 diff 看起来是干净的。
"""


def plugin_config(path: str) -> dict:
    doc = yaml.safe_load(io.open(path, encoding="utf-8"))
    for item in doc:
        if isinstance(item, dict) and "insert" in item:
            for ins in item["insert"]:
                if ins.get("id") == "photo-filter-v4":
                    return copy.deepcopy(ins["config"])
    raise SystemExit(f"{path} 里找不到 photo-filter-v4 的 config")


def main() -> None:
    out_dir = sys.argv[1] if len(sys.argv) > 1 else "."
    os.makedirs(out_dir, exist_ok=True)
    base = plugin_config(PROFILE)
    if not os.path.exists(RUBRIC):
        raise SystemExit(f"判据文件不存在：{RUBRIC}")

    for name, rub, anc, note in ARMS:
        cfg = copy.deepcopy(base)
        cfg["rubricFile"] = rub
        cfg["anchorsFile"] = anc
        # 自检：生产配置必须原样保留，只有这两项能变。
        missing = [k for k in base if k not in cfg]
        assert not missing, f"{name} 丢了字段：{missing}"
        body = yaml.safe_dump(
            [{"id": "photo-filter-v4", "config": cfg}],
            allow_unicode=True, sort_keys=False, width=200,
        )
        p = os.path.join(out_dir, f"{name}.patch.yml")
        io.open(p, "w", encoding="utf-8").write(HEADER.format(note=note) + body)
        print(f"  {name:<8} rubric={'有' if rub else '无'}  锚点={'有' if anc else '无'}  → {p}")

    print(
        "\n跑之前请逐组 --dump-config 确认**每一组自身**含 allowedRoots / engineBinary /"
        "\nstage2Vlm / allowNeither / defaultTarget，再做两两 diff。"
        "\n只做 diff 不做自检，会漏掉「三组一起坏」这种情况。"
    )


if __name__ == "__main__":
    main()
