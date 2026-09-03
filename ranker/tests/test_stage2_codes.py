"""生产阶段 2 的内容寻址答案通道（烧码 + 要求抄回）。

━━ 为什么要烧码 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

原来的答案只有 winner ∈ {JIA, YI, TIE}，而 **JIA/YI 本身就是槽位标签** ——
一个不看图、只按位置作答的模型也能把它填满，我们从答案里分辨不出来。

2026-09-03 的仪器标定用「图上烧 4 位随机码、要求抄回」解决了这件事：
答案指向具体那张照片，位置换了码不换。那一轮实测 310/312 抄对、0 次幻觉码。
这一批测试守的是把同一机制搬进生产阶段 2 之后的关键不变量。
"""
import re
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
COMPARE = (ROOT / "agent-v4" / "src" / "compare.ts").read_text(encoding="utf-8")
INDEX = (ROOT / "agent-v4" / "src" / "index.ts").read_text(encoding="utf-8")
INSTRUMENT = (ROOT / "agent-v4" / "src" / "instrument.ts").read_text(encoding="utf-8")


def test_ts侧行为测试必须通过():
    """真跑 resolvePick 与 assignCodes，不是文本断言。

    resolvePick 是「答案到底指哪张照片」的唯一裁决点 ——
    它错了整个阶段 2 的结论就都错了，而这种错在文本里看不出来。
    """
    r = subprocess.run(
        ["node", "--experimental-strip-types", "agent-v4/src/codes.test.ts"],
        cwd=ROOT, capture_output=True, text=True,
    )
    assert r.returncode == 0, f"TS 行为测试没过：\n{r.stdout}\n{r.stderr}"


def test_码只有一份实现():
    """标定与生产必须用同一套码。

    两处各写一份的话，哪天字母表改了而另一边没跟上，
    标定得到的 99.4% 读码率就不再适用于生产 —— 而没有任何东西会报错。
    """
    assert "from './codes.ts'" in INSTRUMENT, "instrument.ts 应当复用 codes.ts"
    assert "const ALPHABET" not in INSTRUMENT, "instrument.ts 里又出现了一份字母表"
    assert (ROOT / "agent-v4" / "src" / "codes.ts").is_file()


def test_没烧码时提示词不许提码():
    """没烧码却叫模型「把黑边里的码抄回来」，它只能编一个。

    那不是内容寻址，是给自己造幻觉。
    """
    assert "const makeSystem" in COMPARE, "提示词必须按开关拼装，不能是常量"
    assert "<<CODES>>" in COMPARE
    assert "withCodes ? CODES_BLOCK : ''" in COMPARE


def test_烧码时工具必须要求抄回三个码():
    m = re.search(r"required:\s*withCodes\s*\?\s*(\[[^\]]*\])", COMPARE)
    assert m, "工具的 required 必须随 withCodes 变化"
    need = m.group(1)
    for f in ("code_jia", "code_yi", "winner_code"):
        assert f in need, f"烧码时 {f} 必须是必填 —— 选填等于形同虚设"


def test_生产阶段2烧码而评测路径不烧():
    """评测那条路要与 R2/R3 可比，答案空间和输入都不能变。

    烧码换了被测对象：要测烧码条件下的表现，走 run_instrument_check。
    """
    assert "assignCodes(names, STAGE2_CODE_SEED)" in INDEX, "生产阶段 2 没有烧码"
    assert re.search(r"undefined,\s*codes,", INDEX), "预览没有把 codeMap 传下去"
    assert re.search(r"config\.allowNeither,\s*codes,\s*services", INDEX), \
        "生产的 comparePairs 没有收到 codes"
    assert re.search(r"undefined,\s*services", INDEX), \
        "评测路径必须显式传 undefined（不烧码）"


def test_种子是固定值():
    """同一批照片每次跑要拿到同一批码 —— 断点续跑、复现问题时码不能变。"""
    m = re.search(r"const STAGE2_CODE_SEED = (\d+)", INDEX)
    assert m, "找不到固定种子"


def test_幻觉码不许被当成正常答案():
    assert "'bad-code'" in COMPARE
    assert "本对作废" in COMPARE, "码对不上任何一张时必须作废，不能猜"


def test_矛盾必须落盘():
    """说 JIA 却给乙的码 —— 这是一条真实信息，不是噪声。"""
    assert "contradiction" in COMPARE
    assert "codeReadOk" in COMPARE, "四个码位抄对没有，是「这次看清了没有」的直接证据"
