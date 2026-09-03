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
    ROOT / "dsh-v4" / "preset-photo-filter-v4" / "agent.cordis.yml",
]


def texts():
    return [(p, p.read_text(encoding="utf-8")) for p in USER_FACING if p.is_file()]


def test_被推翻的位置偏好说法不许再出现():
    """标定实测 72% / 72%，位置偏好不成立。措辞必须跟着证据走。"""
    banned = "位置偏好是真实存在的"
    for p, t in texts():
        assert banned not in t, (
            f"{p.name} 里还在对用户说「{banned}」，而这个结论已被仪器标定推翻"
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
        pytest.skip("这个文件里没有 45%")
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
