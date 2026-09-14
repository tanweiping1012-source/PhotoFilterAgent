"""preview --with-face 的引擎契约：拿不到人脸框就非零退出；拿到了但没有脸，照常出图。

━━ 为什么要钉 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

2026-09-14 复现（临时冷缓存、直接取退出码）：

    不给 --engine，facts 缓存冷      exit 1   AttributeError（None.exists()）
    --engine 路径不存在，缓存冷      exit 0   previews=1 faces=0，没有任何警告
    不给 --engine，facts 缓存热      exit 0   faces=1

同一条命令的成败取决于看不见的缓存状态；第二种是真正的「退出码 0 却没做成」。

━━ 契约（owner 定为方案 A）━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    没给引擎 / 引擎不存在 / 引擎报错      → 拿不到人脸框 → 非零退出
    引擎跑成功，返回「这张没有脸」        → 拿到了（结果是空）→ exit 0，照常出整幅

判定落在**「拿到人脸框了没有」**，不是「人脸数是不是 0」——
后者会把风景数据集整批误杀，那是另一种假红。

全部直接调 main() 取返回值，不经过 shell、不接管道：
`… | tail; echo $?` 拿到的是 tail 的退出码，这个项目已经为此误判过一次。
"""
import json

import pytest
from PIL import Image

from photofilter_rank import cli
from photofilter_rank.eligibility import EligibilityUnavailable
from photofilter_rank.scan import thumb_key

NAME = "DSCF0001.JPG"
BOX = [0.25, 0.25, 0.5, 0.5]


class _Facts:
    """engine_facts 的替身，只带 preview 用得到的那一个字段。"""
    def __init__(self, face_box):
        self.face_box = face_box


@pytest.fixture
def env(tmp_path):
    folder = tmp_path / "photos"
    folder.mkdir()
    folder = folder.resolve()                   # 与 cli 里 cfg.folder 的解析一致，否则缩略图键对不上
    src = folder / NAME
    Image.new("RGB", (640, 480), (120, 90, 60)).save(src, "JPEG")
    cache = tmp_path / "cache"
    (cache / "thumbs").mkdir(parents=True)
    # 缩略图必须在：缺了它，照片会先落进 missing，人脸结果就被盖住了，测不出东西
    Image.new("RGB", (320, 240), (120, 90, 60)).save(cache / "thumbs" / thumb_key(src), "JPEG")
    engine = tmp_path / "photofilter"
    engine.write_text("")                       # 守卫只看「存在」；真正的分析由替身顶上
    return {"folder": folder, "cache": cache, "engine": engine, "out": tmp_path / "out.json"}


def _preview(env, *extra):
    return cli.main(["preview", str(env["folder"]), "--names", NAME, "--with-face",
                     "--cache", str(env["cache"]), "--json", str(env["out"]), *extra])


def test_要人脸却没给引擎_开头就非零退出(env, capsys):
    rc = _preview(env)
    assert rc != 0, "要了人脸却没给引擎，必须非零退出 —— 否则调用方会以为成功"
    err = capsys.readouterr().err
    assert "--engine" in err, f"报错要说清缺的是什么：{err!r}"
    assert not env["out"].exists(), "失败时不许写出一份看起来正常的输出"


def test_引擎路径不存在_即使缓存是热的也要失败(env, capsys, monkeypatch):
    """方案 A 的完成形态：只查「传没传」不够。

    引擎路径写错时，热缓存会从缓存里拿到人脸框、冷缓存才失败 —— 又回到「行为取决于缓存」。
    这里让替身扮演**热缓存**（不碰引擎就返回人脸框）：守卫若只查传没传，这条会碰巧成功。
    """
    asked = []

    def warm(*a, **k):
        asked.append(1)
        return _Facts({NAME: BOX})

    monkeypatch.setattr("photofilter_rank.eligibility.engine_facts", warm)
    rc = _preview(env, "--engine", str(env["engine"].with_name("不存在的引擎")))
    assert rc != 0, "引擎不存在就必须失败，不能因为缓存热着就碰巧成功"
    assert not asked, "引擎不存在时根本不该再去问缓存"
    assert "不存在" in capsys.readouterr().err


def test_引擎报错时非零退出_不再静默产出零张人脸(env, capsys, monkeypatch):
    """复现里的第二种：以前这里 boxes = {} —— 要了人脸、零张、exit 0、没有任何警告。"""
    def boom(*a, **k):
        raise EligibilityUnavailable("本地分析引擎崩了（测试注入）")

    monkeypatch.setattr("photofilter_rank.eligibility.engine_facts", boom)
    rc = _preview(env, "--engine", str(env["engine"]))
    assert rc != 0
    assert "人脸框" in capsys.readouterr().err
    assert not env["out"].exists()


def test_引擎跑成功但没有人脸_照常出整幅_exit0(env, monkeypatch):
    """风景照的正常结果。判定若写成「人脸数为 0 就失败」，风景数据集会被整批误杀 ——
    这条就是冲着那个变异来的。"""
    monkeypatch.setattr("photofilter_rank.eligibility.engine_facts", lambda *a, **k: _Facts({}))
    rc = _preview(env, "--engine", str(env["engine"]))
    assert rc == 0, "引擎跑成功、确实没有脸，不是失败"
    d = json.loads(env["out"].read_text())
    assert len(d["previews"]) == 1 and d["faces"] == {} and d["missing"] == []


def test_引擎跑成功且有人脸_正常出人脸(env, monkeypatch):
    """守卫加上之后，正常路径必须还是通的。"""
    monkeypatch.setattr("photofilter_rank.eligibility.engine_facts",
                        lambda *a, **k: _Facts({NAME: BOX}))
    rc = _preview(env, "--engine", str(env["engine"]))
    assert rc == 0
    assert NAME in json.loads(env["out"].read_text())["faces"]
