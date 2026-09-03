"""仓库卫生。每一条都是真出过事之后补的，不是预防性的洁癖。

目标是一句话：**别人克隆下来，跑到的应该是同一个 agent。**
唯一允许的差别是照片本身（评测集与标注不进公开仓库）。

出过的事：
1. 版本库里进过照片。ask-AB.jpg / ask-BA.jpg 两张带可辨认人脸的对比图被提交
   并推上了公开仓库 —— 它们本来只是给标注者在本机看的。
2. 五个 v4 profile 里只有三个进过仓库，而且是手工 cp 的副本，其中
   photo-v4-ab 那份带着本机绝对路径。另外两个（eval / eval-web）仓库里根本没有，
   等于整轮 AB 实验无法从克隆复现。
3. 占位符词汇一度有三套（README 一套、install.sh 一套、我又加了第三套）。
   漏替一个占位符，doctor.sh 就会假报「不一致」。
"""
import json
import re
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]

IMAGE_SUFFIXES = {
    ".jpg", ".jpeg", ".png", ".gif", ".bmp",
    ".heic", ".heif", ".tif", ".tiff", ".dng", ".raf", ".cr2", ".nef",
}

V4_PROFILES = (
    "photo-v4", "photo-v4-ab", "photo-v4-eval",
    "photo-v4-eval-web", "photo-v4-headless",
)
PROFILE_FILES = ("package.json", "cordis.yml", "cordis.patch.yml", "pnpm-workspace.yaml")

# sync-config.sh 认识的全部占位符。**这是唯一的一套。**
CANON = {"@@REPO@@", "@@DSH_HOME@@", "@@CACHE@@", "@@PHOTOS@@", "@@EXPORT@@", "@@SCRATCH@@"}
# v3 遗留的另一套，只出现在 profiles/photo 与 profiles/photo-web，由 install.sh 替换。
LEGACY_V3 = {"@@PHOTO_FILTER_HOME@@", "@@DSH_HOME@@"}


def tracked_files():
    out = subprocess.run(
        ["git", "ls-files", "-z"], cwd=ROOT, capture_output=True, check=True,
    ).stdout.decode()
    return [p for p in out.split("\0") if p]


def test_版本库里没有照片():
    bad = [p for p in tracked_files() if Path(p).suffix.lower() in IMAGE_SUFFIXES]
    assert bad == [], (
        "这些图片被 git 跟踪了，而仓库是公开的：\n  " + "\n  ".join(bad)
        + "\n照片只留在本机；要给人看就贴进对话，不要提交。"
    )


def test_跟踪文件里没有本机绝对路径():
    """一条都不许有。私人目录名本身就是信息，而且换台机器就跑不通。"""
    pat = re.compile(r"/Users/(?!you\b)[A-Za-z0-9_.-]+/")
    bad = []
    for rel in tracked_files():
        p = ROOT / rel
        if not p.is_file() or p.suffix.lower() in IMAGE_SUFFIXES:
            continue
        try:
            text = p.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for i, line in enumerate(text.splitlines(), 1):
            if pat.search(line):
                bad.append(f"{rel}:{i}: {line.strip()[:100]}")
    assert bad == [], (
        "本机绝对路径进了仓库：\n  " + "\n  ".join(bad)
        + "\n改 $DSH_HOME 下那份再跑 dsh-v4/sync-config.sh pull，或直接用占位符。"
    )


@pytest.mark.parametrize("prof", V4_PROFILES)
def test_v4_profile_在仓库里(prof):
    d = ROOT / "profiles" / prof
    assert d.is_dir(), f"{prof} 不在仓库里 —— 跑 dsh-v4/sync-config.sh pull"
    missing = [f for f in PROFILE_FILES if not (d / f).is_file()]
    assert missing == [], f"{prof} 缺文件：{missing}"


def test_web_persona_在仓库里():
    """preset 决定 web 版的人设。以前只有 README 里一句 cp -R，没有脚本装它。"""
    d = ROOT / "dsh-v4" / "preset-photo-filter-v4"
    for f in ("preset.yml", "agent.cordis.yml"):
        assert (d / f).is_file(), f"缺 {f} —— web 版会没有人设"


def test_锚点在仓库里且不含本机路径():
    p = ROOT / "dsh-v4" / "anchors-default.json"
    d = json.loads(p.read_text(encoding="utf-8"))
    assert d.get("text"), "锚点提示词原话丢了"
    assert d.get("photos"), "锚点照片名单丢了"
    assert d["folder"].startswith("@@"), \
        f"folder 必须是占位符，现在是 {d['folder']}"


def test_占位符只有一套():
    """三套词汇并存过一次，代价是 doctor.sh 假报不一致。"""
    used = {}
    for rel in tracked_files():
        p = ROOT / rel
        if not p.is_file() or p.suffix.lower() in IMAGE_SUFFIXES:
            continue
        try:
            text = p.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for ph in re.findall(r"@@[A-Z_]+@@", text):
            used.setdefault(ph, set()).add(rel)

    unknown = {}
    for ph, files in used.items():
        if ph in CANON:
            continue
        # v3 的两个 profile 与 install.sh 用遗留词汇，它们自成一套。
        if ph in LEGACY_V3 and all(
            f.startswith(("profiles/photo/", "profiles/photo-web/")) or f == "install.sh"
            or f.startswith("ranker/tests/")
            for f in files
        ):
            continue
        unknown[ph] = sorted(files)
    assert unknown == {}, (
        "出现了 sync-config.sh 不认识的占位符（漏替 → doctor.sh 会假报不一致）：\n"
        + "\n".join(f"  {k}: {v}" for k, v in unknown.items())
    )
