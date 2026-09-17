"""假排序器：只模拟 agent ↔ 排序器的进程协议，用来测 rank_photos 闭包的接线（0 次付费调用）。

模拟的行为（与真排序器的契约一致的部分）：
  · scan / preview / pick 三个子命令，--json 写结果
  · pick 带 --verdicts → 阶段 2 回放；文件不存在 → 退出码 2（与真 cli.py 相同）
  · stage3_plan 由「当前名单」算出：段 1 擂主 = selected[1]，段 2 擂主 = selected[3]
  · 带 --stage3-verdicts：plan_md5 对不上 → stderr 一行、退出码 2；对上 → 按文件名应用，note 计数同 stage3.py
每次调用把 argv 追加到 $FAKE_LOG。场景参数从 $FAKE_SCEN（JSON）读。
"""
import argparse
import base64
import hashlib
import json
import os
import sys
from pathlib import Path

SCEN = json.loads(os.environ.get("FAKE_SCEN") or "{}")
POOL = SCEN.get("pool") or [f"P{i:02d}.JPG" for i in range(1, 13)]
LOG = os.environ.get("FAKE_LOG")


def plan_md5(pairs):
    return hashlib.md5(json.dumps(pairs, separators=(",", ":")).encode()).hexdigest()


def tag(kind, key, name):
    return base64.b64encode(f"{kind}:{key}:{name}".encode()).decode()


def main():
    argv = sys.argv[1:]
    if LOG:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(argv, ensure_ascii=False) + "\n")
    cmd, rest = argv[0], argv[1:]
    ap = argparse.ArgumentParser()
    ap.add_argument("folder")
    ap.add_argument("--json", required=True)
    ap.add_argument("--quiet", action="store_true")
    ap.add_argument("--exclude", nargs="*", default=[])
    ap.add_argument("--engine")
    if cmd == "scan":
        a = ap.parse_args(rest)
        out = {"n_photos": len(POOL), "fingerprint": "fakefp0000000001", "folder": a.folder, "names": POOL}
    elif cmd == "preview":
        ap.add_argument("--names", nargs="+", required=True)
        ap.add_argument("--size")
        ap.add_argument("--with-face", action="store_true")
        ap.add_argument("--label-map")
        ap.add_argument("--code-map")
        a = ap.parse_args(rest)
        labels = json.loads(Path(a.label_map).read_text(encoding="utf-8")) if a.label_map else {}
        codes = json.loads(Path(a.code_map).read_text(encoding="utf-8")) if a.code_map else {}
        known = set(POOL) | set(SCEN.get("anchor_names", []))
        found = [n for n in a.names if n in known]
        key = lambda n: codes.get(n) or labels.get(n) or ""
        out = {"previews": {n: tag("full", key(n), n) for n in found},
               "faces": {n: tag("face", key(n), n) for n in found} if a.with_face else {},
               "missing": [n for n in a.names if n not in known]}
    elif cmd == "pick":
        ap.add_argument("--target")
        ap.add_argument("--style")
        ap.add_argument("--labels")
        ap.add_argument("--verdicts")
        ap.add_argument("--stage3-verdicts")
        a = ap.parse_args(rest)
        selected = list(SCEN.get("selected0") or ["P01.JPG", "P03.JPG", "P05.JPG", "P07.JPG"])
        t2 = SCEN.get("t2", [["P01.JPG", "P02.JPG"], ["P07.JPG", "P08.JPG"]])
        judge2 = "local"
        # 与真 cli 一致：给了 --verdicts 但文件不存在 → 退出码 2（2026-09-18 之前是静默当没给）
        if a.verdicts and not Path(a.verdicts).exists():
            print(f"给了 --verdicts 但文件不存在：{a.verdicts}", file=sys.stderr)
            return 2
        if a.verdicts:
            for v in json.loads(Path(a.verdicts).read_text(encoding="utf-8"))["verdicts"]:
                if v["winner"] == "b" and v["a"] in selected:
                    selected[selected.index(v["a"])] = v["b"]
            judge2 = "replay"
        plan = [] if SCEN.get("no_stage3_plan") else [
            {"segment": 1, "a": selected[1], "b": "P09.JPG", "margin": 0.01},
            {"segment": 2, "a": selected[3], "b": "P10.JPG", "margin": 0.02},
        ]
        md5 = plan_md5([[p["a"], p["b"]] for p in plan])
        note, judge3 = None, "off"
        if a.stage3_verdicts:
            raw = json.loads(Path(a.stage3_verdicts).read_text(encoding="utf-8"))
            if raw.get("plan_md5") != md5 or SCEN.get("force_mismatch"):
                print(f"阶段 3 裁决对应的计划 md5 是 {raw.get('plan_md5')}，这一次重算出来的是 {md5}。", file=sys.stderr)
                return 2
            vmap = {(v["a"], v["b"]): v["winner"] for v in raw["verdicts"]}
            note = {k: 0 for k in ("swapped", "missing", "refused_family_cap",
                                   "kept_a", "kept_tie", "kept_neither", "kept_inconsistent")}
            note["contests"] = len(plan)
            for p in plan:
                w = vmap.get((p["a"], p["b"]))
                if w is None:
                    note["missing"] += 1
                elif w == "b":
                    selected[selected.index(p["a"])] = p["b"]
                    note["swapped"] += 1
                else:
                    note["kept_" + w] += 1
            note["kept"] = note["kept_a"] + note["kept_tie"] + note["kept_neither"] + note["kept_inconsistent"]
            keys = {(p["a"], p["b"]) for p in plan}
            note["unused"] = sum(1 for k in vmap if k not in keys)
            judge3 = "replay"
        out = {"selected": selected, "ranking": POOL, "scores": {n: 0.5 for n in POOL},
               "families": {n: i for i, n in enumerate(POOL)}, "mode": "cold", "n_labels": 0,
               "fingerprint": "fakefp0000000001", "n_candidates": len(POOL), "elapsed_sec": 0.1,
               "notes": {"tournament_plan": t2, "warnings": [], "n_blocked": 0, "n_families": len(POOL),
                         "largest_family": 1, "cold_strategy": "vision_face", "stage2_judge": judge2,
                         "stage3_plan": plan, "stage3_plan_md5": md5, "stage3": note, "stage3_judge": judge3}}
    else:
        print(f"假排序器不认识子命令 {cmd}", file=sys.stderr)
        return 3
    Path(a.json).write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
