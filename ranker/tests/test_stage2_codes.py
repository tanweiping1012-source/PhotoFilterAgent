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
CODES = (ROOT / "agent-v4" / "src" / "codes.ts").read_text(encoding="utf-8")
#: run_pair_eval 的主体（2026-09-14 从 index.ts 抽出）
PAIREVAL = (ROOT / "agent-v4" / "src" / "pairEval.ts").read_text(encoding="utf-8")


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


def test_生产阶段2烧码而评测路径缺省不烧():
    """评测那条路**缺省**要与 R2/R3 可比，答案空间和输入都不能变。

    2026-09-14 起考题 spec 里可以写 burn_codes=true —— 标定的是阶段 3 的生产裁判，
    生产比较路径烧码（判据 §10.1）。但**缺省**必须仍然不烧：缺省一变，历史出口就静默不可比。
    行为层面由 agent-v4/src/pairEval.test.ts 真跑钉住；这里守文本上的每个调用点。
    """
    # 生产阶段 2
    assert "assignCodes(names, STAGE2_CODE_SEED)" in INDEX, "生产阶段 2 没有烧码"
    assert re.search(r"undefined,\s*codes,", INDEX), "预览没有把 codeMap 传下去"
    assert re.search(r"config\.allowNeither,\s*codes,\s*services", INDEX), \
        "生产的 comparePairs 没有收到 codes"
    # 评测路径（主体在 pairEval.ts）：只有显式 true 才烧；缺省是 undefined，不是 {}
    assert "const burn = spec.burn_codes === true" in PAIREVAL, "burn_codes 必须严格等于 true 才烧码"
    assert "const codes = burn ? assignCodes(names, STAGE2_CODE_SEED) : undefined" in PAIREVAL, \
        "评测路径缺省必须不烧码，而且是 undefined 不是 {}"
    assert re.search(r"undefined,\s*codes,", PAIREVAL), "评测路径烧码时没把 codeMap 交给 preview"
    assert re.search(r"input\.allowNeither,\s*codes,\s*services", PAIREVAL), \
        "评测路径的 comparePairs 没有收到 codes"
    # compare_within_groups 的预览没有烧码，所以它必须显式传 undefined。
    #
    # 原来这里是 `re.search(r"undefined,\s*services", INDEX)`，本意守评测路径。评测主体搬走之后，
    # 它仍然能在 compare_within_groups 那一处匹配上 —— **守卫还绿着，守的已经不是它说的那件事**。
    # 改成用那一处旁边的注释定位，钉住它本身。
    assert re.search(r"codes 必须是 undefined[\s\S]{0,300}?undefined,\s*services", INDEX), \
        "compare_within_groups 必须显式传 undefined —— 它的预览没有烧码"


def test_种子是固定值():
    """同一批照片每次跑要拿到同一批码 —— 断点续跑、复现问题时码不能变。

    2026-09-14 种子从 index.ts 搬到 codes.ts：run_pair_eval（pairEval.ts）标定阶段 3 的生产裁判时
    必须用**同一个**种子。所以不只找定义，还钉住「只有一份」—— 两处各写一个常量，
    哪天改了一处，标定就不再对应生产，而没有任何东西会报错。
    """
    m = re.search(r"export const STAGE2_CODE_SEED = (\d+)", CODES)
    assert m, "codes.ts 里找不到固定种子"
    for name, text in (("index.ts", INDEX), ("pairEval.ts", PAIREVAL)):
        assert not re.search(r"\bconst STAGE2_CODE_SEED\b", text), f"{name} 里又定义了一份种子"
        assert re.search(r"import \{[^}]*\bSTAGE2_CODE_SEED\b[^}]*\} from './codes\.ts'", text), \
            f"{name} 没有从 codes.ts 取种子"


def test_幻觉码不许被当成正常答案():
    assert "'bad-code'" in COMPARE
    assert "本对作废" in COMPARE, "码对不上任何一张时必须作废，不能猜"


def test_矛盾必须落盘():
    """说 JIA 却给乙的码 —— 这是一条真实信息，不是噪声。"""
    assert "contradiction" in COMPARE
    assert "codeReadOk" in COMPARE, "四个码位抄对没有，是「这次看清了没有」的直接证据"


def test_抄错的码必须留原文():
    """只存 codeReadOk 这个布尔值，抄错时就查不下去了。

    2026-09-04 生产实测 68/70 抄对，剩下 2 次因为没存模型实际抄了什么，
    无法判断是 OCR 糊了、串了行、还是抄成了锚点图上的码 —— 线索当场断掉。
    """
    assert "codesRead" in COMPARE, "模型实际抄回来的码没有落盘"
    # 幻觉码那条分支最需要原文，必须也存。
    # 用「本对作废」定位那个 push，而不是 'bad-code' —— 后者第一次出现是在
    # resolvePick 的返回类型里，离那个分支还很远。
    i = COMPARE.index("本对作废")
    seg = COMPARE[max(0, i - 800):i + 200]
    assert "codesRead" in seg, "幻觉码分支没有保留抄回来的原文，而那正是最需要查的一档"


# ── 锚点不受候选池排除清单影响 ────────────────────────────────────
#
# 2026-09-06：生产把 config.excludedRelativePaths 传给了取锚点图那一步。
# 排除清单里正好含着 10 张锚点自身（为防泄题，这本来就是要做的），
# 于是 preview 一张都取不回来 —— 提示词照旧写「范例图排在最前面」，
# 却一张范例图都没附。实验组 2 整轮失败就是这么来的，而且指标全绿。
#
# 这条守的是 CLI 那一侧的事实：--exclude 会把 --names 点名的照片一起吃掉。
# 所以调用方**必须**传空清单，不能图省事把候选池那份复用过去。
def test_preview的exclude会吃掉点名要的照片(tmp_path):
    from photofilter_rank.scan import list_photos

    for n in ("A.JPG", "B.JPG"):
        (tmp_path / n).write_bytes(b"\xff\xd8\xff\xe0stub")

    assert [p.name for p in list_photos(tmp_path, ())] == ["A.JPG", "B.JPG"]
    # 点名要 A，同时把 A 放进排除清单 —— A 就没了。
    assert [p.name for p in list_photos(tmp_path, ("A.JPG",))] == ["B.JPG"]
