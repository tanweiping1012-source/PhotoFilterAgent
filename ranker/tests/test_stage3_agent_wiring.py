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
# 「代码里没有」要在**代码**上断言：注释里引用旧写法（比如讲清楚以前错在哪）不算复发。
INDEX_CODE = "\n".join(
    ln for ln in INDEX.splitlines() if not ln.lstrip().startswith(("//", "*", "/*")))


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
    # 阶段 3 的调用记录由 runStage3 自己写，计数抄送到闭包这一层。
    assert "onCall: countCall(3)," in INDEX


def test_调用账从回调数_跨异常还在():
    """失败的运行也花了钱，摘要和 run.json 必须报得出来。

    2026-09-18 执行方查出的形态：阶段 2 记的是 `plan.length * 2` 且只在成功后赋值，
    中途 429 的那次报「0 次调用、全程在本机算完」，而 calls.jsonl 里已经有 sent=true 的行；
    阶段 3 的计数活在 runStage3 的局部变量里，一抛就没了。
    """
    assert "const plan = res.notes.tournament_plan" in INDEX
    assert "vlmCalls" not in INDEX_CODE, "旧计数器还在，说明摘要可能仍按对数算而不是数真发出的调用"
    assert "plan.length * 2" not in INDEX_CODE, "调用数不许按对数算"
    # 计数器建在 try 之外（阶段 2 的 try 从 `if (config.stage2Vlm && plan.length) {` 开始）
    assert INDEX.index("const sent = { 2: {") < INDEX.index("if (config.stage2Vlm && plan.length) {")
    assert re.search(r"if \(r\.kind === 'preflight'\) sent\[stage\]\.preflights\+\+", INDEX)
    # run.json 与摘要用同一份数
    assert "comparisons: sent[2].compares, preflights: sent[2].preflights," in INDEX
    assert "comparisons: sent[3].compares, preflights: sent[3].preflights," in INDEX
    assert "`**付费模型调用 ${paid(2) + paid(3)} 次**`" in INDEX or "paid(2) + paid(3) > 0" in INDEX


def test_失败的阶段也把已花的调用报出来():
    assert re.search(r"失败前已经发出 \$\{paid\(2\)\} 次调用", INDEX)
    assert re.search(r"失败前已经发出 \$\{paid\(3\)\} 次调用", INDEX)


def test_run_json_记真发出的锚点张数():
    """「配了几张」在锚点根本没发出去的运行上也成立，拿它核「四组都带了锚点」会开绿灯。"""
    assert "anchor_photos_configured:" in INDEX and "anchor_photos_sent: stage2AnchorsSent," in INDEX
    assert re.search(r"stage2AnchorsSent = anchorBlock\?\.jpegs\.length \?\? 0", INDEX)
    assert "anchor_photos_sent: stage3.anchorPhotos," in INDEX


def test_关着阶段3也记计划与计划md5():
    """A 组 0 次调用白拿这份计划，A 与 B 才能在同一份计划口径上比决定性对局。"""
    assert re.search(
        r"\? \{ status: 'off', plan: res\.notes\.stage3_plan \?\? \[\], "
        r"plan_md5: res\.notes\.stage3_plan_md5 \?\? null \}", INDEX)


def test_交付路径上不留跨运行共享的裁决文件():
    """按数据集指纹命名的那份每轮被覆盖 4 次，重排不许再读它。"""
    assert "verdicts-${res.fingerprint}.json" not in INDEX
    assert re.search(r"const runVf = join\(runDir, 'stage2-verdicts\.json'\)", INDEX)
    assert re.search(r"exec\.signal, runVf,\n", INDEX), "阶段 2 重排必须用运行记录里那份"
