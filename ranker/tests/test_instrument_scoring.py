"""进度页和判分脚本必须对同一批数据给出同一个数。

为什么值得单独测：这两处各自实现了一遍同一条判据，结果进度页把
「幻觉码」的真值 0 显示成了 40% —— 它没有排除 NONE，而模型答
TIE/NEITHER 时工具 schema 就要求 winner_code 填 NONE，于是弃权
全被记成了幻觉。

这种错**不会报错**，只会让人读到一个错的数并据此下结论。
"""
import importlib.util
import json
import sys
from pathlib import Path

import pytest

AB = Path(__file__).resolve().parents[2] / "dsh-v4" / "ab-experiment"


def _load(name):
    spec = importlib.util.spec_from_file_location(name, AB / f"{name}.py")
    if spec is None or spec.loader is None:
        pytest.skip(f"{name}.py 不在预期位置")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def _row(**kw):
    base = dict(phase="matrix", condition="AB", pair="p", a="A.JPG", b="B.JPG",
                code_jia="AAAA", code_yi="BBBB", read_jia="AAAA", read_yi="BBBB",
                winner="JIA", winner_code="AAAA", winner_photo="A.JPG")
    base.update(kw)
    return base


ROWS = [
    _row(),
    # 弃权：schema 要求 winner_code 填 NONE。这**不是**幻觉码。
    _row(pair="q", winner="TIE", winner_code="NONE", winner_photo=None),
    _row(pair="r", winner="NEITHER", winner_code="NONE", winner_photo=None),
    # 真正的幻觉：报了一个图上不存在的码
    _row(pair="s", winner_code="ZZZZ", winner_photo=None),
]


def test_弃权不算幻觉码_两处实现一致(tmp_path):
    d = tmp_path / "run"
    d.mkdir()
    (d / "calls.jsonl").write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in ROWS) + "\n",
        encoding="utf-8")

    server = _load("instrument_server")
    check = _load("instrument_check")

    s = server.stats(server.load(str(d))[0])
    page_halluc = s["halluc"][0]

    rows = check.load(str(d))
    m = [r for r in rows if r.get("phase") == "matrix"]
    script_halluc = sum(
        1 for r in m
        if r.get("winner_code") and r["winner_code"] not in ("NONE", "")
        and r["winner_code"] not in (r.get("code_jia"), r.get("code_yi"))
    ) / len(m)

    assert page_halluc == pytest.approx(script_halluc), (
        f"进度页 {page_halluc:.1%} ≠ 判分脚本 {script_halluc:.1%} —— "
        "同一条判据两处实现分叉了")
    assert script_halluc == pytest.approx(0.25), "4 行里只有 ZZZZ 那行是幻觉"


def test_码读对率两处一致(tmp_path):
    d = tmp_path / "run"
    d.mkdir()
    rows = ROWS + [_row(pair="t", read_yi="XXXX")]      # 读错一个
    (d / "calls.jsonl").write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n",
        encoding="utf-8")
    server = _load("instrument_server")
    s = server.stats(server.load(str(d))[0])
    assert s["code_ok"][0] == pytest.approx(4 / 5)
