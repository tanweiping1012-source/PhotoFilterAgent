#!/usr/bin/env python3
"""把「用文件夹表达的答案」导成文本清单。**只读，不动任何照片。**

为什么要换记法 —— 文件夹当答案有一个没法自动分辨的歧义：

    复制式：精选被**复制**进子目录  → 池子里每张金标出现两次，必须排除子目录
    移动式：精选被**移动**进子目录  → 子目录是金标的唯一副本，排除等于删光答案

同一条 excludedRelativePaths 规则同时面对这两种形态，必然错一半。
实测生产 profile 那条规则在 4 个数据集里的 2 个上把金标清成 0，
而且不报错，验收结果显示成「0/0、AUC nan」。

文本清单没有这个歧义：照片在哪不重要，答案就是这份名单。
清单只有文件名，没有照片、没有路径、没有 EXIF，可以进仓库。
"""
import argparse, hashlib, json, pathlib, sys


def classify(pick_dir: pathlib.Path, parent: pathlib.Path) -> str:
    """复制式还是移动式 —— 看金标在上级目录有没有同名副本。"""
    names = [p.name for p in pick_dir.glob("*.JPG")]
    if not names:
        return "空"
    dup = sum(1 for n in names if (parent / n).exists())
    if dup == len(names):
        return "复制式"
    if dup == 0:
        return "移动式"
    return f"混合（{dup}/{len(names)} 有副本）"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--write", action="store_true", help="真的写文件（默认只报告）")
    a = ap.parse_args()

    root = pathlib.Path(a.root)
    out = pathlib.Path(a.out)
    picks = sorted(p for p in root.rglob("*")
                   if p.is_dir() and ("pick" in p.name or "精选" in p.name))

    index = {}
    print(f"{'数据集':<34}{'金标':>5}  形态")
    for pick in picks:
        parent = pick.parent
        names = sorted(p.name for p in pick.glob("*.JPG"))
        if not names:
            continue
        kind = classify(pick, parent)
        # 数据集名 = 相对 root 的上级目录路径，斜杠换成下划线
        slug = parent.relative_to(root).as_posix().replace("/", "__") or "root"
        print(f"{slug:<34}{len(names):>5}  {kind}")
        index[slug] = {
            "photos_dir": parent.relative_to(root).as_posix(),
            "pick_dir": pick.relative_to(root).as_posix(),
            "kind": kind,
            "n": len(names),
            # 指纹让「清单和文件夹是否还一致」可以随时复查
            "sha256": hashlib.sha256("\n".join(names).encode()).hexdigest()[:16],
        }
        if a.write:
            out.mkdir(parents=True, exist_ok=True)
            (out / f"{slug}.gold.txt").write_text("\n".join(names) + "\n")

    if a.write:
        (out / "index.json").write_text(
            json.dumps(index, ensure_ascii=False, indent=2) + "\n")
        print(f"\n已写入 {out}（{len(index)} 份清单 + index.json）")
    else:
        print("\n（只是报告。加 --write 才真的写文件。一张照片都不会动。）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
