#!/usr/bin/env python3
"""生成标定专用 profile `photo-v4-calib`。0 次付费调用。跑完标定就删掉它。

原则跟 make_web_arms.py 一样：**整份复制已部署的 photo-v4-eval，只改几行**，
用文本替换而不是 YAML 重新序列化 —— 那份 patch 里的注释记着踩过的坑
（附件上限 20 会静默回落、headless 的 persona 覆盖方式），重新 dump 会全丢。

只改三处，每一处都有它防的事：
  evalPairsFile  → archive 目录下的第一遍考题。原值指向 /tmp/claude-501/pairs-people.json，
                   **那个文件已经被系统清理掉了**（/tmp 第三次吃数据）
  evalPairsDir   → 同一个 archive 目录（新增）。没有它，run_pair_eval 换不了考题
  stage2Vlm      → false（新增）。photo-v4-eval 没写这一项 → schema 默认 **true**，
                   而它的 persona「固定执行顺序」写着先 rank_photos ——
                   headless agent 只要照人设走一步，阶段 2 就会打 60 局 / 120 次，
                   超出批准的 114 次。**不能只靠提示词说「别调」**

⚠️ doctor.sh 第 3b 层**看不见**这个 profile（它只枚举固定的五个名字），
所以它存在期间 3b 不会变红 —— 那是盲区，不是绿。核这个 profile 靠 --dump-config。
"""
import re, shutil, sys
from pathlib import Path

HOME = Path.home()
SRC = HOME / ".dsh-v4/profiles/photo-v4-eval"
DST = HOME / ".dsh-v4/profiles/photo-v4-calib"
ARCHIVE = HOME / ".dsh-v4/photo-filter-v4/archive/round3-calibration"
FIRST_SPEC = ARCHIVE / "calib-arm1-none.json"


def replace_line(text: str, key: str, value: str) -> str:
    pat = re.compile(rf"^(\s*){re.escape(key)}:.*$", re.M)
    if len(pat.findall(text)) != 1:
        raise SystemExit(f"{key}: 应当恰好出现一次，实际 {len(pat.findall(text))} 次 —— 源 profile 结构变了，停手")
    return pat.sub(lambda m: f"{m.group(1)}{key}: {value}", text)


def insert_after(text: str, anchor_key: str, lines: list[str]) -> str:
    pat = re.compile(rf"^(\s*){re.escape(anchor_key)}:.*$", re.M)
    m = pat.search(text)
    if not m:
        raise SystemExit(f"找不到 {anchor_key}:，停手")
    indent = m.group(1)
    block = "".join(f"\n{indent}{ln}" for ln in lines)
    return text[:m.end()] + block + text[m.end():]


def main() -> int:
    if not SRC.is_dir():
        raise SystemExit(f"源 profile 不存在：{SRC}")
    base = (SRC / "cordis.patch.yml").read_text(encoding="utf-8")
    for k in ("evalPairsDir", "stage2Vlm"):
        if re.search(rf"^\s*{k}:", base, re.M):
            raise SystemExit(f"源 profile 已经有 {k}: —— 不是预期的结构，停手，别盖掉它")

    out = replace_line(base, "evalPairsFile", str(FIRST_SPEC))
    out = insert_after(out, "evalPairsFile", [
        f"evalPairsDir: {ARCHIVE}",
        "# 标定期间阶段 2 **显式关掉**。不写这一行 schema 默认是 true，",
        "# 而 persona 会让 agent 先 rank_photos —— 那是 120 次计划外的付费调用。",
        "stage2Vlm: false",
    ])

    if DST.exists():
        shutil.rmtree(DST)
    DST.mkdir(parents=True)
    for f in ("cordis.yml", "pnpm-workspace.yaml"):
        shutil.copy2(SRC / f, DST / f)
    pkg = (SRC / "package.json").read_text(encoding="utf-8")
    if '"dsh-profile-photo-v4-eval"' not in pkg:
        raise SystemExit("package.json 里的包名不是预期的，停手")
    (DST / "package.json").write_text(
        pkg.replace('"dsh-profile-photo-v4-eval"', '"dsh-profile-photo-v4-calib"'), encoding="utf-8")
    (DST / "cordis.patch.yml").write_text(out, encoding="utf-8")
    ARCHIVE.mkdir(parents=True, exist_ok=True)

    # 自检：比较之前先确认**这一份自身**是完整的（上一轮 --patch 整段替换骗过 diff 的教训）
    t = (DST / "cordis.patch.yml").read_text(encoding="utf-8")
    need = {
        "allowedRoots": r"allowedRoots:\s*\[.*照片测试.*\]",
        "engineBinary": r"engineBinary:\s*\S+photofilter",
        "excludedRelativePaths 含 me-pick": r'-\s*"me-pick"',
        "evalPairsFile 不在 /tmp": rf"evalPairsFile:\s*{re.escape(str(FIRST_SPEC))}",
        "evalPairsDir 不在 /tmp": rf"evalPairsDir:\s*{re.escape(str(ARCHIVE))}",
        "stage2Vlm: false": r"^\s*stage2Vlm:\s*false\s*$",
        "maxImagesPerMessage: 40": r"maxImagesPerMessage:\s*40",
    }
    miss = [k for k, rx in need.items() if not re.search(rx, t, re.M)]
    if "/tmp/" in t:
        miss.append("文件里仍有 /tmp/ 路径")
    if miss:
        raise SystemExit("❌ 生成的 profile 不完整：" + "；".join(miss))
    print(f"✅ {DST.name}")
    for k in need:
        print(f"   ✓ {k}")
    print(f"   与源 profile 的差异：只有 evalPairsFile 一行改值 + 新增 evalPairsDir / stage2Vlm")
    print(f"\n下一步（0 次调用）：cd ~/deepseek-harness && DSH_HOME=~/.dsh-v4 pnpm dsh --profile {DST.name} --dump-config")
    return 0


if __name__ == "__main__":
    sys.exit(main())
