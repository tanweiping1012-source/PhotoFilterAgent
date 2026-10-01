"""给用户看的文字里，不许出现「已被自己的实验推翻」或「出处是另一条路径」的断言。

━━ 为什么单独立一批测试 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

2026-09-04 一次性发现三处，全部是 agent 会**主动说给用户听**的话：

1. 「实测 AB/BA 一致率 45%」—— 这个数来自 47 对的 run_pair_eval 评测路径
   （每次 18 幅图）。而生产路径每次 24 幅、超出附件上限，修掉之前一次都没
   真正调用过。数字是真的，但它描述的不是这条路径。

2. 「位置偏好是真实存在的，单向结果不可信」—— 仪器标定**推翻了它**：
   同一批照片排在前 72%、排在后 72%，位置没有可测量的影响。
   真正原因是模型对同一问题答不稳（重复调用 62.8% 改口）。

3. compare_within_groups 把 neither / inconsistent 都折进「平局」和「维持原判」——
   一对被模型判为「都不够格」的照片，报给用户的是「维持原判」。

共同点：**代码跑得都对，错的是说给用户的话。** 没有测试会红，
只有人去读输出字符串才发现得了。
"""
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]

# agent 会直接说给用户听的地方
USER_FACING = [
    ROOT / "agent-v4" / "src" / "index.ts",
    # run_pair_eval 的主体 2026-09-14 从 index.ts 抽到这里。它抛给用户的报错（落盘文件已存在、
    # 锚点泄题、缺预览……）原来在 index.ts 里、受这批检查覆盖 —— 跟着搬过来，别让它们漏出去。
    ROOT / "agent-v4" / "src" / "pairEval.ts",
    # 人设：web 版在 photo-v4 的 preset 里，命令行版在 photo-v4-headless 的 system-prompt 里。
    ROOT / "profiles" / "photo-v4" / "cordis.patch.yml",
    ROOT / "profiles" / "photo-v4-headless" / "cordis.patch.yml",
    # 用户读的第一份文档。2026-09-30 查出它还在说「模型确实存在偏爱第一张的倾向」，而它自己的文末写着「排除」。
    ROOT / "README.md",
    ROOT / "docs" / "DEVELOPER.md",
]


def texts():
    return [(p, p.read_text(encoding="utf-8")) for p in USER_FACING if p.is_file()]


def _yaml_spoken(text: str) -> str:
    """profile 里会说给用户的文字：人设块（prefix / personaPrefix 的块标量，含其中的 ## 小标题）与 description 的值。
    YAML 注释不会进模型，自然被排除。不用 PyYAML：CI 只装 numpy / Pillow / pytest。"""
    lines, out, i, blocks = text.splitlines(), [], 0, 0
    while i < len(lines):
        ln = lines[i]
        m = re.match(r"\s*description:\s*(.+)$", ln)
        if m:
            out.append(m.group(1))
        # 块标量的所有合法写法（| |- |+ > >- >+）都要认：只认 |- 时，改成 | 再往人设里写错话，守卫照样是绿的。
        if re.fullmatch(r"\s*(prefix|personaPrefix):\s*[|>][-+]?\s*", ln):
            blocks += 1
            indent, i = None, i + 1
            while i < len(lines):
                body = lines[i]
                if body.strip():
                    cur = len(body) - len(body.lstrip())
                    indent = cur if indent is None else indent
                    if cur < indent:
                        break
                out.append(body.strip())
                i += 1
            continue
        i += 1
    # 一个人设块都没认出来，就等于什么都没查 —— 宁可红，不许空着绿。
    assert blocks, "profile 里没认出人设块（prefix / personaPrefix 的块标量）：键名或写法变了，要跟着改这里"
    return "\n".join(out)


def spoken(p: Path, t: str) -> str:
    """只留会说给用户的文字。按文件类型取：Markdown 没有行注释 —— 以 ** / * / # 开头的是加粗段落、列表、标题，
    照样是说给用户的（2026-10-01 查出：原来一律按 `*` `#` 开头当注释跳过，README 有 79 行没被检查）。"""
    if p.suffix == ".md":
        return t
    if p.suffix == ".ts":
        return "\n".join(ln for ln in t.splitlines() if not ln.lstrip().startswith(("//", "/*", "*")))
    if p.suffix == ".yml":
        return _yaml_spoken(t)
    raise AssertionError(f"{p} 的类型没有定义「哪些行会说给用户」")


def test_被推翻的位置偏好说法不许再出现():
    """标定实测 72% / 72%，位置偏好不成立。措辞必须跟着证据走。"""
    # 不只查一种说法：人设里「（位置偏好真实存在）」少一个「是」，逐字匹配放过了它，一直留到 2026-09-29。
    # 注释不算：代码注释里记着「以前这里错说过什么」，那是写给维护者的，不会说给用户（见 spoken）。
    banned = re.compile(r"位置偏好(是)?真实存在|确实存在.{0,3}偏爱第一张")
    for p, t in texts():
        said = spoken(p, t)
        m = banned.search(said)
        assert m is None, (
            f"{p.name} 里还在对用户说「{m.group(0) if m else ''}」，而这个结论已被仪器标定推翻"
            "（同一批照片排在前后被选中比例都是 72%）。"
        )


@pytest.mark.parametrize("path", [p for p in USER_FACING])
def test_45percent必须带出处(path):
    """45% 可以留 —— 那一轮是真做过的。但必须写明它来自哪条路径。

    不写出处的话，用户会以为这是他刚跑的这条链路的成绩。
    """
    if not path.is_file():
        pytest.skip(f"{path} 不存在")
    t = path.read_text(encoding="utf-8")
    if "45%" not in t:
        # 没有 45% 就没有要带出处的东西 —— 这是通过，不是跳过。
        # 以前写成 skip：当时名单里的文件都含 45%，从没触发过。而 CI 要求 skip 数为 0
        # （静默 skip 的守卫等于没有守卫），名单里加进一个不含 45% 的文件就会把 CI 打红。
        # 文件不存在那条仍然是 skip —— 那是真的缺了东西，该被看见。
        return
    # 出处的关键要素：47 对 / 评测路径 / 18 幅 —— 至少要能指认另一条路径
    for line_no, line in enumerate(t.splitlines(), 1):
        if "45%" not in line:
            continue
        window = "\n".join(t.splitlines()[max(0, line_no - 6):line_no + 6])
        assert re.search(r"47\s*对|评测路径|18\s*幅", window), (
            f"{path.name}:{line_no} 出现 45% 但附近没有出处说明。\n"
            f"  {line.strip()[:80]}\n"
            "它来自 47 对的评测路径（每次 18 幅图），不是生产路径。"
        )


def test_组内比较不许把都不够格算成维持原判():
    """五个 winner 取值必须各显各的，不能三分支一刀切。"""
    t = (ROOT / "agent-v4" / "src" / "index.ts").read_text(encoding="utf-8")
    assert "两张都不够格" in t, "neither 没有自己的显示文案，会被折进平局"
    assert "const keeps = verdicts.filter((v) => v.winner === 'a').length" in t, (
        "「维持原判」必须只数 winner === 'a'。"
        "原来是 length - flips - ties，把 neither 和 inconsistent 也算了进去。"
    )
    assert "v.winner === 'inconsistent'" in t, (
        "判定翻覆要直接看取值，不要匹配 reason 里的「不一致」三个字"
    )


def test_不许说阶段2只比咬得紧的少数几组():
    """阶段 2 的复核计划是 pipeline.py 的 tournament_plan：所有至少两张的组按组从大到小逐组打满，到 refine_max_matches 为止。

    「只比冠军会进名单、本地分咬得很紧的少数几组」是已删掉的 refine_plan。2026-09-30 查出 README、DEVELOPER、
    preset 描述、两份人设、rank_photos 的工具说明都还这么说 —— 说给用户的「哪些照片会发出去、花多少钱」因此是错的。
    """
    banned = re.compile(r"咬得很紧|咬得紧|少数几(组|对)")
    for p, t in texts():
        said = spoken(p, t)
        m = banned.search(said)
        assert m is None, f"{p.name} 里还在说「{m.group(0) if m else ''}」—— 阶段 2 按组从大到小逐组打，不挑「咬得紧」的组"
