#!/usr/bin/env python3
"""把三组实验做成三个 **web** profile，好让 webui 里出现三个真实会话。

原则跟 make_arms.py 一样：**整份复制已部署的 photo-v4，只改两行**。
不重新拼一份 config —— 手写会漏项，而漏项的失败形态是「跑起来才报错」
或者更糟的「静默回落」。

只改：
    rubricFile   对照='' 实验1/2=仓库里的 rubric-v2-prompt.txt
    anchorsFile  对照='' 实验1=''  实验2=~/.dsh-v4/anchors.json

用文本替换而不是 YAML 重新序列化 —— 那份 patch 里的注释记着
「附件上限 20 会静默回落」「整组淘汰的门槛改过两次」这些踩过的坑，
重新 dump 会把它们全丢掉。
"""
import shutil
import sys
from pathlib import Path

HOME = Path.home()
SRC = HOME / ".dsh-v4" / "profiles" / "photo-v4"
RUBRIC = HOME / "deepseek-harness/PhotoFilterAgent/dsh-v4/rubric/rubric-v2-prompt.txt"
ANCHORS = HOME / ".dsh-v4" / "anchors.json"

ARMS = {
    "control": ("", ""),
    "rubric": (str(RUBRIC), ""),
    "treat": (str(RUBRIC), str(ANCHORS)),
}


def set_key(text: str, key: str, value: str) -> str:
    """改掉 `key:` 那一行的值；没有这一行就插在 anchorsFile 后面。

    值写成带引号的空串而不是留空 —— YAML 里 `k:` 是 null，
    而插件的 schema 要的是 str，null 会在启动时炸。
    """
    v = f"'{value}'" if value == "" else value
    lines = text.splitlines()
    for i, line in enumerate(lines):
        stripped = line.lstrip()
        if stripped.startswith(f"{key}:"):
            indent = line[: len(line) - len(stripped)]
            lines[i] = f"{indent}{key}: {v}"
            return "\n".join(lines) + "\n"
    # 没有这一行：插在 anchorsFile 之后，缩进跟它一样
    for i, line in enumerate(lines):
        stripped = line.lstrip()
        if stripped.startswith("anchorsFile:"):
            indent = line[: len(line) - len(stripped)]
            lines.insert(i + 1, f"{indent}{key}: {v}")
            return "\n".join(lines) + "\n"
    raise SystemExit(f"既没有 {key}: 也没有 anchorsFile: —— 源 profile 结构变了，停手")



def add_excludes(text: str, names: list[str]) -> str:
    """把锚点组追加进 excludedRelativePaths。

    为什么排除：`split_annotation` 产出的「锚点组 / 考题组」互斥切分
    从来没有落进生产配置 —— `leaks()` 全仓库只有测试在调，
    `rank.py`/`pipeline.py` 里 grep anchor 为空。于是锚点照片仍在候选池内。

    实测当下泄题为 0（10 张锚点一局都没进 tournament_plan），
    但那是巧合不是保证：DSCF8902 是锚点、又在交付的 20 张里，
    说明它所在的组是**交付相关组**。一旦把计划改成「打影响交付的组」，
    这一组必然被打，而它同时印在每一次提示词里当范例 —— 那就是真泄题。
    所以排除是「改计划」的前置条件，不是可选项。

    按**组**不按张：同组照片高度相似，排一张等于剧透整组（anchors.py 开头写了）。
    已核对：这 10 张所在的 3 个本地家族（21/50/80）正好只含这 10 张，
    没有额外牵连，也没有金标被误伤。所以列这 10 个文件名即等价于按组排除。

    scan.py:31 的判据是 `rel == e or rel.startswith(e + "/")`，
    所以精确文件名可以直接作为条目。
    """
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if line.lstrip().startswith("excludedRelativePaths:"):
            j = i + 1
            item_indent = None
            while j < len(lines):
                st = lines[j].lstrip()
                if st.startswith("- "):
                    if item_indent is None:
                        item_indent = lines[j][: len(lines[j]) - len(st)]
                    j += 1
                else:
                    # **不要**跳过注释行。跳过它就会越过下一个键的注释块，
                    # 把插入点落到那些注释后面，注释就跟它解释的键拆散了。
                    # 第一版正是这么错的：engineBinary 的两行说明被留在锚点列表上方。
                    break
            if item_indent is None:
                raise SystemExit("excludedRelativePaths 下没有列表项，结构变了，停手")
            new = [f'{item_indent}# 锚点组 —— 见 add_excludes 的说明']
            new += [f'{item_indent}- "{n}"' for n in names]
            lines[j:j] = new
            return "\n".join(lines) + "\n"
    raise SystemExit("找不到 excludedRelativePaths，源 profile 结构变了，停手")

def main() -> int:
    if not SRC.is_dir():
        raise SystemExit(f"源 profile 不存在：{SRC}")
    if not RUBRIC.is_file():
        raise SystemExit(f"rubric 文件不存在：{RUBRIC}")
    if not ANCHORS.is_file():
        raise SystemExit(f"锚点文件不存在：{ANCHORS}")

    import json
    anchor_names = sorted(json.loads(ANCHORS.read_text(encoding="utf-8"))["photos"])
    print(f"锚点组 {len(anchor_names)} 张，三组一律排除")
    base = (SRC / "cordis.patch.yml").read_text(encoding="utf-8")
    for arm, (rub, anc) in ARMS.items():
        dst = SRC.parent / f"photo-v4-arm-{arm}"
        if dst.exists():
            shutil.rmtree(dst)
        dst.mkdir(parents=True)
        for f in ("cordis.yml", "pnpm-workspace.yaml"):
            shutil.copy2(SRC / f, dst / f)
        pkg = (SRC / "package.json").read_text(encoding="utf-8")
        (dst / "package.json").write_text(
            pkg.replace('"dsh-profile-photo-v4"', f'"dsh-profile-photo-v4-arm-{arm}"'),
            encoding="utf-8",
        )
        out = set_key(set_key(base, "rubricFile", rub), "anchorsFile", anc)
        # 三组**同样地**排除锚点组 —— 它不是处理变量，必须对三组一致，
        # 否则候选池不同，重合度根本不可比。
        out = add_excludes(out, anchor_names)
        (dst / "cordis.patch.yml").write_text(out, encoding="utf-8")
        print(f"✅ {dst.name}  rubricFile={rub or '(空)'}  anchorsFile={anc or '(空)'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
