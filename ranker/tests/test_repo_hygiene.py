"""仓库卫生：两条都是真出过事之后补的，不是预防性的洁癖。

1. 版本库里不许有照片。2026-09-03 发现 ask-AB.jpg / ask-BA.jpg 两张带可辨认
   人脸的对比图被提交并推上了公开仓库 —— 它们本来只是给标注者在本机看的。
2. v4 的 profile 必须在仓库里、且不带本机绝对路径。在此之前五个 v4 profile
   只存在于 $DSH_HOME，仓库里一份都没有，等于整轮 AB 实验无法从仓库复现。
"""
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


def tracked_files():
    out = subprocess.run(
        ["git", "ls-files", "-z"], cwd=ROOT, capture_output=True, check=True,
    ).stdout.decode()
    return [p for p in out.split("\0") if p]


def test_版本库里没有照片():
    bad = [p for p in tracked_files() if Path(p).suffix.lower() in IMAGE_SUFFIXES]
    assert bad == [], (
        "这些图片被 git 跟踪了，而仓库是公开的：\n  "
        + "\n  ".join(bad)
        + "\n照片只留在本机；要给人看就贴进对话，不要提交。"
    )


@pytest.mark.parametrize("prof", V4_PROFILES)
def test_v4_profile_在仓库里(prof):
    d = ROOT / "profiles" / prof
    assert d.is_dir(), f"{prof} 不在仓库里 —— 跑 dsh-v4/sync-profiles.sh pull"
    missing = [f for f in PROFILE_FILES if not (d / f).is_file()]
    assert missing == [], f"{prof} 缺文件：{missing}"


@pytest.mark.parametrize("prof", V4_PROFILES)
def test_v4_profile_不带本机绝对路径(prof):
    # 占位符表见 dsh-v4/sync-profiles.sh。这里只认「有没有裸的绝对路径」，
    # 不关心具体换成了哪个占位符。
    pat = re.compile(r"(/Users/|/home/|/private/tmp/|/tmp/(?!\w*@@))")
    for f in PROFILE_FILES:
        p = ROOT / "profiles" / prof / f
        if not p.is_file():
            continue
        for i, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1):
            assert not pat.search(line), (
                f"{prof}/{f}:{i} 带着本机绝对路径进了仓库：\n  {line.strip()}\n"
                "改 $DSH_HOME 下的那份，然后跑 dsh-v4/sync-profiles.sh pull"
            )
