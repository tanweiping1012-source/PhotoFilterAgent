#!/usr/bin/env python3
"""找出被 preset 盖掉、因而不生效的 profile 配置键。

2026-09-05 这件事坑掉了一整轮实验（120 次付费调用作废）。

web 路径下 preset 与 profile 的 `config` 是**逐键合并，preset 覆盖 profile**。
三个实验 profile 从 01:09 起就写着 10 条锚点排除，02:06 跑出来仍是 309 张、
含全部 10 张锚点 —— 因为 preset 也定义了 `excludedRelativePaths`，profile 那份是死的。
指标一切正常：张数、名单、重合度都不报警。

分组实验尤其致命：处理变量若落在被覆盖的键上，三组其实完全一样，
却会得出「这个变量没有效果」的结论。

**只报值不同的键。** 值相同的覆盖没有后果，报出来只会淹掉真信号。
headless profile 不读 preset，跳过。
"""
import sys
from pathlib import Path

import yaml

PLUGIN = "photo-filter-v4"


def plugin_config(path: Path) -> dict:
    """取出 photo-filter-v4 这个插件的 config 段；找不到就返回空。"""
    try:
        doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    except Exception as e:                      # 语法坏了是另一层的事，这里只说查不了
        print(f"  ⚠️  {path.name} 解析失败，跳过：{e}")
        return {}
    for entry in _walk(doc):
        if isinstance(entry, dict) and entry.get("id") == PLUGIN:
            cfg = entry.get("config")
            return cfg if isinstance(cfg, dict) else {}
    return {}


def _walk(node):
    """patch 是 [{insert: [...]}, ...]，preset 是别的形状 —— 一律深走。"""
    if isinstance(node, dict):
        yield node
        for v in node.values():
            yield from _walk(v)
    elif isinstance(node, list):
        for v in node:
            yield from _walk(v)


def main() -> int:
    dsh_home = Path(sys.argv[1]).expanduser()
    live = dsh_home / ".agent-presets" / PLUGIN / "agent.cordis.yml"
    if not live.is_file():
        print(f"  ⚠️  preset 不在 {live}，跳过这层")
        return 0

    preset = plugin_config(live)
    if not preset:
        print("  ⚠️  preset 里没有 photo-filter-v4 的 config 段，跳过这层")
        return 0

    bad = False
    for prof_dir in sorted((dsh_home / "profiles").glob("photo-v4*")):
        # headless 不走 preset（它直接覆盖 system-prompt 的 persona），不适用这条
        if "headless" in prof_dir.name:
            continue
        patch = prof_dir / "cordis.patch.yml"
        if not patch.is_file():
            continue
        prof = plugin_config(patch)
        shadowed = [
            k for k, v in prof.items()
            if k in preset and preset[k] != v          # 值相同的覆盖无后果，不报
        ]
        if shadowed:
            bad = True
            print(f"  ❌ {prof_dir.name}：这些键写了也不生效，preset 的值会赢")
            for k in sorted(shadowed):
                print(f"       {k}: profile={_brief(prof[k])}  ←被覆盖为→  preset={_brief(preset[k])}")
    if not bad:
        print("  ✅ 没有被 preset 盖掉的 profile 键")
    return 1 if bad else 0


def _brief(v: object) -> str:
    s = str(v)
    return s if len(s) <= 48 else s[:45] + "…"


if __name__ == "__main__":
    sys.exit(main())
