"""判官能力标定算分脚本的守卫测试。

算分脚本（dsh-v4/ab-experiment/stage3/calibration/score_calibration.py）里有三道守卫，
每一道都对着一个真实踩过、或者这一轮刚查出来的坑。**加了守卫就要能证明它会红** ——
这个项目一轮里出现过四次「测试全绿但什么都没守」，所以这里每道守卫都有一条让它红的用例。

纯标准库，CI 的最小依赖（numpy + Pillow + pytest）下就能跑。
"""
import importlib.util
import io
import json
from contextlib import redirect_stdout
from pathlib import Path

import pytest

SCRIPT = (Path(__file__).resolve().parents[2]
          / "dsh-v4/ab-experiment/stage3/calibration/score_calibration.py")


def _load():
    assert SCRIPT.exists(), f"算分脚本不在：{SCRIPT} —— 这条测试不许 skip"
    spec = importlib.util.spec_from_file_location("score_calibration", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


sc = _load()


def _spec(n=19):
    pairs = []
    for i in range(n):
        gold_in_a = i % 2 == 0
        pairs.append({"a": f"G{i:02d}.JPG" if gold_in_a else f"O{i:02d}.JPG",
                      "b": f"O{i:02d}.JPG" if gold_in_a else f"G{i:02d}.JPG",
                      "answer": "a" if gold_in_a else "b", "kind": "gold",
                      "local_correct": i < 7, "group": i})
    return {"_meta": {"arm": "测试"}, "pairs": pairs}


def _rows(spec, winners, codes=True, reasons=None):
    rows = []
    for i, (p, w) in enumerate(zip(spec["pairs"], winners)):
        r = {"a": p["a"], "b": p["b"], "winner": w,
             "consistent": w in ("a", "b", "neither"),
             "reason_ab": (reasons or {}).get(i, ""), "reason_ba": ""}
        if codes:
            r.update(code_a="ABCD", code_b="EFGH", code_read_ok=True, contradiction=False,
                     codes_read={"ab_jia": "ABCD", "ab_yi": "EFGH", "ba_jia": "EFGH", "ba_yi": "ABCD"})
        else:
            r.update(code_read_ok=True)        # compare.ts:367 在不烧码时恒为 true
        rows.append(r)
    return rows


def _gold(p):  return p["answer"]
def _other(p): return "b" if p["answer"] == "a" else "a"


def test_平局与翻覆不进答对率分母_都不够格单列():
    s = _spec()
    P = s["pairs"]
    winners = ([_gold(p) for p in P[:5]] + [_other(p) for p in P[5:8]]
               + ["tie"] * 4 + ["inconsistent"] * 5 + ["neither"] * 2)
    body, problems = sc.score(s, _rows(s, winners))
    text = "\n".join(body)
    assert not problems, problems
    assert "有方向率        8/19" in text
    assert "答对率          5/8" in text, "分母应当是有方向的 8 局，不是 19"
    assert "未表态 9 局" in text and "都不够格 2 局" in text


def test_未烧码时读码率无效_不许报出假的100():
    s = _spec()
    rows = _rows(s, [_gold(p) for p in s["pairs"]], codes=False)
    body, problems = sc.score(s, rows)
    assert any("没烧码" in x for x in problems)
    text = "\n".join(body)
    assert "读码率          无效" in text
    assert "19/19" not in text.split("读码率")[1].split("\n")[0], "不烧码时照抄 codeReadOk 会得到假的 19/19"


def test_camelCase码字段一律判无效_只认snake_case():
    """修订 2 §11：码字段只认 snake_case。

    「实现」要是写成 codeA/codeReadOk，这里必须红 —— 两种都接受的话，
    写错的那一边永远不会被发现。
    """
    s = _spec()
    rows = _rows(s, [_gold(p) for p in s["pairs"]], codes=False)
    for r in rows:
        r.pop("code_read_ok")
        # 五个码键的 camelCase 版**一个不少**。少给一个（比如没有 codesRead），
        # 这条测试会因为「缺 codes_read」而通过 —— 通过的理由对不上，
        # 「把 camelCase 当 snake_case 收」的变异就活下来了（这一版变异时实测过）。
        r.update(codeA="ABCD", codeB="EFGH", codeReadOk=True, contradiction=False,
                 codesRead={"abJia": "ABCD", "abYi": "EFGH", "baJia": "EFGH", "baYi": "ABCD"})
    body, problems = sc.score(s, rows)
    assert any("camelCase" in x for x in problems), problems
    text = "\n".join(body)
    assert "读码率          无效" in text
    assert "19/19" not in text.split("读码率")[1].split("\n")[0]


def test_理由字段名不对就红_不许让个人偏好一栏静默变零():
    s = _spec()
    rows = _rows(s, [_gold(p) for p in s["pairs"]], reasons={0: "按个人偏好判的"})
    for r in rows:
        r["reasonAb"] = r.pop("reason_ab")
    _, problems = sc.score(s, rows)
    assert any("reason_ab" in x for x in problems), problems


def test_18行带码1行不带_判无效_钉住all不是any():
    """owner 在 1817dc2 上做的变异：守卫② all→any，9 条测试全绿。

    19 行里 18 行带码、1 行不带时，旧脚本照样报出一个读码率 —— 不是假的 100%，
    但同样是个静默算出来、不许引用的数。这条钉住「每一行都要带」。
    """
    s = _spec()
    rows = _rows(s, [_gold(p) for p in s["pairs"]])
    for k in ("code_a", "code_b", "code_read_ok", "contradiction", "codes_read"):
        rows[7].pop(k)
    body, problems = sc.score(s, rows)
    assert any("第 7 行" in x for x in problems), problems
    assert "读码率          无效" in "\n".join(body)


def test_一行缺contradiction_判无效_不许静默少算():
    """contradiction 在必需码键里，但旧守卫只查 code_a/code_b/code_read_ok ——
    缺了它，`is True` 为 False，那一栏静默少算，不报问题。"""
    s = _spec()
    rows = _rows(s, [_gold(p) for p in s["pairs"]])
    rows[5].pop("contradiction")
    body, problems = sc.score(s, rows)
    assert any("第 5 行" in x and "contradiction" in x for x in problems), problems
    assert "读码率          无效" in "\n".join(body)


def test_结果文件里没有winner的行要报出来_不许静默丢掉(tmp_path):
    s = _spec()
    sp, rp = tmp_path / "s.json", tmp_path / "r.jsonl"
    sp.write_text(json.dumps(s, ensure_ascii=False), encoding="utf-8")
    rows = _rows(s, [_gold(p) for p in s["pairs"]])
    del rows[3]["winner"]
    rp.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows), encoding="utf-8")
    buf = io.StringIO()
    with redirect_stdout(buf):
        rc = sc.main(["--spec", str(sp), str(rp)])
    assert rc == 1
    assert "1 行不是结果行" in buf.getvalue()


def test_结果与spec对不上就拒绝():
    s = _spec()
    rows = _rows(s, [_gold(p) for p in s["pairs"]])
    rows[3]["a"], rows[3]["b"] = rows[3]["b"], rows[3]["a"]      # 槽位换了
    _, problems = sc.score(s, rows)
    assert any("不一致" in x for x in problems)


def test_对数不是19就报():
    s = _spec()
    rows = _rows(s, [_gold(p) for p in s["pairs"]])[:18]
    _, problems = sc.score(s, rows)
    assert any("18 对" in x for x in problems)


def test_理由里写了个人偏好的单独一栏():
    s = _spec()
    P = s["pairs"]
    rows = _rows(s, [_gold(p) for p in P], reasons={0: "按个人偏好判的：他不喜欢张嘴笑", 1: "个人偏好"})
    rows[1]["winner"] = _other(P[1])
    text = "\n".join(sc.score(s, rows)[0])
    assert "按个人偏好判的  2 局（其中有方向 2，选中金标 1）" in text


def test_wilson_已知值():
    lo, hi = sc.wilson(7, 19)
    assert abs(lo - 0.1915) < 0.002 and abs(hi - 0.5896) < 0.002


def test_输出里出现推断措辞会被拦下(tmp_path, monkeypatch):
    s = _spec()
    sp, rp = tmp_path / "s.json", tmp_path / "r.json"
    sp.write_text(json.dumps(s, ensure_ascii=False), encoding="utf-8")
    rp.write_text(json.dumps({"rows": _rows(s, [_gold(p) for p in s["pairs"]])}, ensure_ascii=False),
                  encoding="utf-8")
    with redirect_stdout(io.StringIO()):
        assert sc.main(["--spec", str(sp), str(rp)]) == 0
    # 变异：让报告里混进一句「显著」，守卫必须红
    orig = sc.score
    monkeypatch.setattr(sc, "score", lambda spec, rows: ((orig(spec, rows)[0] + ["模型显著优于本地分"]), []))
    with pytest.raises(AssertionError, match="不许用的措辞"):
        with redirect_stdout(io.StringIO()):
            sc.main(["--spec", str(sp), str(rp)])
