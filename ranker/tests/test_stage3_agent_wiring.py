"""agent 侧阶段 3 接线的调用点守卫（index.ts / ranker.ts / preset）。

行为由 agent-v4/src/stage3.test.ts 真跑钉住；这里守的是 rank_photos 闭包里**调用点本身** ——
那段逻辑长在闭包里测不到，2026-09-14 index.ts:688 的参数错位就是在调用点上漏过去的。
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
INDEX = (ROOT / "agent-v4" / "src" / "index.ts").read_text(encoding="utf-8")
RANKER = (ROOT / "agent-v4" / "src" / "ranker.ts").read_text(encoding="utf-8")
PRESET = (ROOT / "dsh-v4" / "preset-photo-filter-v4" / "agent.cordis.yml").read_text(encoding="utf-8")


def test_阶段3默认关闭():
    assert "stage3Vlm: z.boolean().default(false)," in INDEX


def test_preset不定义阶段3的键_否则profile里的开关是死的():
    for key in ("stage3Vlm", "stage3RubricFile", "stage3AnchorsFile"):
        assert not re.search(rf"^\s*{key}\s*:", PRESET, re.M), f"preset 定义了 {key}，profile 里设的值会被覆盖"


def test_阶段3重排时带上阶段2的裁决():
    assert re.search(r"rank:\s*\(s3File\)\s*=>\s*ranker\.rank\([\s\S]{0,200}?exec\.signal,\s*stage2Vf,\s*s3File,", INDEX), \
        "阶段 3 的计划建立在阶段 2 回放之后的排序上，重排时必须同时带上阶段 2 的裁决"
    assert "--stage3-verdicts" in RANKER and "if (stage3VerdictsFile) args.push('--stage3-verdicts', stage3VerdictsFile)" in RANKER


def test_阶段3只读自己的rubric与锚点_不回落到阶段2的键():
    call = re.search(r"stage3 = await runStage3\(\{[\s\S]*?\}, \{", INDEX)
    assert call, "找不到 runStage3 的调用点"
    body = call.group(0)
    assert "rubric: s3Rubric" in body and "anchors: s3Anchors" in body
    assert "loadRubric()" not in body and "loadAnchors()" not in body
    assert "const s3Anchors = config.stage3AnchorsFile ? readAnchors(config.stage3AnchorsFile) : null" in INDEX
    assert "if (config.stage3AnchorsFile && !s3Anchors) throw" in INDEX, "配了锚点却读不出来必须报错，不许静默跑成无锚点"
    assert "if (config.stage3RubricFile && !s3Rubric) throw" in INDEX, "配了判据却读不出来必须报错"


def test_两个阶段用锚点之前都查泄题():
    assert re.search(r"const leak2 = anchorsInPool\(loadAnchors\(\), res\.ranking\)\s*\n\s*if \(leak2\.length\)", INDEX)
    assert re.search(r"const leak3 = anchorsInPool\(s3Anchors, res\.ranking\)\s*\n\s*if \(leak3\.length\)", INDEX)
    # 阶段 2 的查重必须在取锚点图之前
    assert INDEX.index("const leak2 = anchorsInPool") < INDEX.index("const anchorBlock = await buildAnchorBlock(loadAnchors(), exec.signal)")


def test_运行记录目录不按数据集指纹命名():
    fn = re.search(r"function openRunDir\(\): string \{[\s\S]*?\n  \}", INDEX)
    assert fn, "找不到 openRunDir"
    assert "fingerprint" not in fn.group(0), "同一批照片指纹相同，按指纹命名会互相覆盖"
    assert "randomBytes" in fn.group(0) and "'runs'" in fn.group(0)


def test_阶段2的调用也逐次进运行记录():
    assert re.search(r"exec as unknown as HarnessVisionExecution, \{ onCall: logCall\(2\) \},", INDEX)
    assert "stage3.comparisons" in INDEX and "vlmCalls += stage3.comparisons" in INDEX
