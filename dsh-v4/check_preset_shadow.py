#!/usr/bin/env python3
"""找出 web 会话里**不生效**的 profile 配置键。

同一类事故坑掉过两轮实验：2026-09-05 那次 120 次付费调用作废，
2026-09-18 第四轮端到端的第一次冒烟又是 121 次。

## 机制（2026-09-18 更正，两条都是实测）

原先这里写的是「逐键合并，preset 覆盖 profile」。**不准。**
preset 会自己挂一棵子树（harness `packages/preset/agent-presets/src/mount.ts`），
于是同一个插件被挂了两次，两份 config 各自独立：

  · **模型真正调到的同名工具，用的是 preset 那一份 config。**
    实测（09-18 作废的那次运行记录）：profile 写着 `anchorsFile` 与 `allowNeither: true`，
    而 run.json 记下的生效值是 `''` 和 `false` —— 也就是 preset 没写的键**落到了 schema 默认值**，
    没有回落到 profile
  · **profile 那棵子树并没有消失**：只有它才有的**额外工具**照常注册。
    实测（第三轮标定的 web 会话）：calib-web 的 `evalPairsFile` 让 `run_pair_eval` /
    `run_instrument_check` 出现在模型可见的 9 个工具里，而 preset 里没有这个键

所以这份报告是**风险清单，不是判决**：最终以运行记录（run.json 的 config）为准。

两次事故正好是这个模型的两半：

  · 09-05：两边都写了 `excludedRelativePaths`，preset 那份赢 —— 旧模型看得见
  · 09-18：只有 profile 写了 `anchorsFile` / `allowNeither`，于是阶段 2 一张锚点都没发，
    而张数、名单、指纹、调用数**全部正常**。旧模型看不见，这道守卫当时是绿的

分组实验尤其致命：处理变量若落在不生效的键上，各组其实完全一样，
却会得出「这个变量没有效果」的结论。

## 报什么

  ① 两边都写了、值不同        preset 的值会赢
  ② profile 写了、preset 没写   同名工具拿到的是 schema 默认值（不是 profile 的值）；
                              只有这个键才启用的**额外工具**不受影响

值相同的覆盖没有后果，不报 —— 报出来只会淹掉真信号。
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
        # preset 没写的键不会回落到 profile，而是回落到 schema 默认值。
        # 2026-09-18 漏掉 anchorsFile / allowNeither 的就是这一类：旧版只看 ① 那一类。
        dropped = sorted(k for k in prof if k not in preset)
        if shadowed:
            bad = True
            print(f"  ❌ {prof_dir.name}：这些键写了也不生效，preset 的值会赢")
            for k in sorted(shadowed):
                for line in _explain(k, prof[k], preset[k]):
                    print(f"       {line}")
        if dropped:
            bad = True
            print(f"  ❌ {prof_dir.name}：这些键 preset 没写 —— 模型调到的同名工具拿的是 schema 默认值，不是 profile 的值")
            print("       （只有这个键才启用的额外工具不受影响，见 docstring；最终以 run.json 的 config 为准）")
            for k in dropped:
                print(f"       {k}: profile={_brief(prof[k])}  ←同名工具实际用→  插件 schema 的默认值")
    if not bad:
        print("  ✅ 没有被 preset 盖掉的 profile 键")
    return 1 if bad else 0


def _explain(key: str, mine: object, wins: object) -> list[str]:
    """说清楚差在哪。

    第一版只是把两边各截 48 字。两个长列表如果**前缀相同**，截出来一模一样 ——
    arm-* 三组真实差别是 13 条 vs 3 条，差异全在被截掉的尾巴里，
    读的人（包括几小时后的自己）会判成误报然后忽略它。守卫就是这么失效的。
    所以列表一律报**条数 + 差集**，不报前缀。
    """
    if isinstance(mine, list) and isinstance(wins, list):
        only_mine = [x for x in mine if x not in wins]
        only_wins = [x for x in wins if x not in mine]
        out = [f"{key}: profile {len(mine)} 项  ←被覆盖为→  preset {len(wins)} 项"]
        if only_mine:
            out.append(f"    profile 独有（写了但丢掉的就是这些）：{_items(only_mine)}")
        if only_wins:
            out.append(f"    preset 独有（实际会生效的额外项）：{_items(only_wins)}")
        return out
    return [f"{key}: profile={_brief(mine)}  ←被覆盖为→  preset={_brief(wins)}"]


def _items(xs: list) -> str:
    head = ", ".join(str(x) for x in xs[:6])
    return head if len(xs) <= 6 else f"{head} …（共 {len(xs)} 项）"


def _brief(v: object) -> str:
    s = str(v)
    return s if len(s) <= 48 else s[:45] + "…"


if __name__ == "__main__":
    sys.exit(main())
