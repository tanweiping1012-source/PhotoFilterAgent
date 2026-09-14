#!/usr/bin/env python3
"""载荷自检：第三遍**实际**发出去几幅图。0 次付费调用。

为什么要跑而不是估：`buildAnchorBlock` 是
`photos.flatMap(x => [previews[x], faces[x]].filter(Boolean))`，
而它的硬失败只在**一张都没取到**时触发（`index.ts:201` 的 `if (!jpegs.length)`）。
少取到**一部分**是静默的 —— 文字说有 4 组范例、实际只附了 3 组，指标全绿。
所以这里断言**准确幅数**，不是「非空」。

用法: check_payload.py <anchors-crossscene.json> [照片根目录]
"""
import json, subprocess, sys, tempfile
from pathlib import Path

RANKER = Path.home() / "deepseek-harness/PhotoFilterAgent/ranker"
PY_BIN = Path.home() / ".dsh-v4/ranker-venv/bin/python"
ENGINE = Path.home() / "deepseek-harness/PhotoFilterAgent/engine/.build/release/photofilter"
MAX_JPEGS_PER_CALL = 40          # harness-vision.ts:256
MAX_IMAGES_PER_MSG = 40          # photo-v4 profile 的 maxImagesPerMessage

doc = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
root = Path(sys.argv[2]).expanduser() if len(sys.argv) > 2 else Path.home() / "Desktop/照片测试"
folder = doc["folder"].replace("@@PHOTOS@@", str(root))
photos = doc["photos"]

with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as tf:
    out = Path(tf.name)
subprocess.run(
    [str(PY_BIN), "-m", "photofilter_rank.cli", "preview", folder,
     "--names", *photos, "--size", "512", "--with-face", "--face-size", "448",
     "--engine", str(ENGINE), "--json", str(out)],
    cwd=RANKER, check=True, capture_output=True)
r = json.loads(out.read_text())
pv, fc, missing = r.get("previews", {}), r.get("faces", {}), r.get("missing", [])

n_full = sum(1 for n in photos if pv.get(n))
n_face = sum(1 for n in photos if fc.get(n))
anchor_imgs = n_full + n_face                    # buildAnchorBlock 的实际幅数
total = anchor_imgs + 4                          # 待判两张 × （整幅 + 人脸）

print(f"锚点 {len(photos)} 张 · 整幅 {n_full} · 人脸 {n_face} · missing {missing or '无'}")
print(f"锚点实发 {anchor_imgs} 幅 + 待判 4 幅 = **{total} 幅**")
print(f"上限 插件 {MAX_JPEGS_PER_CALL} / harness {MAX_IMAGES_PER_MSG}")

bad = []
if missing:                       bad.append(f"有照片取不到：{missing}")
if n_full != len(photos):         bad.append(f"整幅少了 {len(photos)-n_full} 张 —— 静默残废，buildAnchorBlock 不会报")
if n_face != len(photos):         bad.append(f"人脸少了 {len(photos)-n_face} 张 —— 同上")
if total > min(MAX_JPEGS_PER_CALL, MAX_IMAGES_PER_MSG): bad.append(f"{total} 幅超上限")
if bad:
    print("\n❌ " + "\n❌ ".join(bad)); raise SystemExit(1)
print("\n✅ 载荷与判据一致，可跑")
