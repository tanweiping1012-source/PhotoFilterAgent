#!/usr/bin/env python3
"""锚点照片在本机齐不齐。

    python3 check_anchors.py <已替换占位符的锚点 JSON>

    退出 0   齐全
    退出 3   不齐（打印缺的项）；文件读不了、不是预期的结构，也归这一类
    其他     核对自己失败（崩溃、找不到解释器……）—— **不能当成不齐**：
             调用方据「不齐」会停用已装的锚点，把「核对坏了」当「不齐」就会误停作者本机的锚点
             （执行方 2026-09-28 用坏掉的 python3 桩子复现）

锚点（anchors-default.json）是作者本人的范例：`folder` 指向作者自己的照片目录。
别的机器上没有这些照片，装上去阶段 2 会在付费调用之前失败，而阶段 2 默认开着：

  · 候选文件夹里恰好有同名照片 → 先撞泄题拦截（按文件名比对；富士相机的 DSCFnnnn.JPG
    很容易与别人的照片重名）。报错说「锚点照片也在候选池里」，把人引向自己的照片，诊断是错的
  · 否则 → 排序器出锚点图时报「目录不存在」

两种都让阶段 2 失败、回落本地名单（2026-09-28 收尾预演查出，执行方独立核）。
所以 sync-config.sh push 齐了才装、不齐就把已装的停用；doctor.sh 用它查已装的那份。

判据与运行时同一口径：**缺一张也算不齐**（运行时「锚点图取不全就整轮失败」）。
没有锚点是这类用户的正确配置：readAnchors 返回 null，泄题拦截随之不触发。
"""
import json
import os
import sys


NOT_COMPLETE = 3


def missing(path: str) -> list[str]:
    """本机缺的锚点项：目录不在就只报目录，否则逐张报缺的照片。读不了、结构不对也算不齐。"""
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
    except (OSError, ValueError) as e:      # 文件坏了：运行时 readAnchors 也会返回 null，这里按不齐处理
        return [f"读不了锚点文件（{e.__class__.__name__}）"]
    if not isinstance(d, dict) or not isinstance(d.get("photos"), list):
        return ["锚点文件不是预期的结构（顶层要是对象，photos 要是列表）"]
    folder = str(d.get("folder") or "")
    if not os.path.isdir(folder):
        return [f"目录 {folder}"]
    return [p for p in d["photos"] if not os.path.isfile(os.path.join(folder, str(p)))]


if __name__ == "__main__":
    miss = missing(sys.argv[1])
    if miss:
        print("、".join(miss[:5]) + (f" 等 {len(miss)} 项" if len(miss) > 5 else ""))
        sys.exit(NOT_COMPLETE)
