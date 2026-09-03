#!/usr/bin/env python3
"""AB 实验的实时进度页。

为什么需要它：AB 跑在 photo-v4-ab（headless）上，
DSH 的 web（3080）跑的是另一个 profile，看不到这一轮。
这个页面直接读结果目录，2 秒刷新一次。

用法：python3 progress_server.py --run-dir /tmp/claude-501/ab-results/<RUN_ID> [--port 3090]
只读，不会碰实验本身。
"""
import argparse
import glob
import html
import json
import os
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

ARMS = ("无提示", "仅规则", "规则加范例")
TAGS = (("primary", "跨层 · 真值=某张赢"), ("equal", "同层 · 真值=平局"))


def snapshot(run_dir: str, pairs_dir: str):
    want = {}
    for f in glob.glob(os.path.join(pairs_dir, "*.json")):
        b = os.path.basename(f)[:-5].split("__")
        if len(b) != 3 or b[0] == "secondary":
            continue
        try:
            want[(b[0], b[2])] = want.get((b[0], b[2]), 0) + len(json.load(open(f))["pairs"])
        except Exception:
            pass
    got, stats, latest = {}, {}, 0.0
    for f in glob.glob(os.path.join(run_dir, "*.result.json")):
        b = os.path.basename(f).replace(".result.json", "").split("__")
        if len(b) != 3:
            continue
        try:
            rows = json.load(open(f))["rows"]
        except Exception:
            continue
        k = (b[0], b[2])
        got[k] = got.get(k, 0) + len(rows)
        s = stats.setdefault(k, {"ok": 0, "tie": 0, "con": 0})
        s["ok"] += sum(1 for r in rows if r.get("model_correct"))
        s["tie"] += sum(1 for r in rows if r.get("winner") == "tie")
        s["con"] += sum(1 for r in rows if r.get("consistent"))
        latest = max(latest, os.path.getmtime(f))
    return want, got, stats, latest


def render(run_dir, pairs_dir):
    want, got, stats, latest = snapshot(run_dir, pairs_dir)
    total_w = sum(want.values()) or 1
    total_g = sum(got.values())
    pct = total_g / total_w
    idle = time.time() - latest if latest else -1
    rows = []
    for tag, tlabel in TAGS:
        for arm in ARMS:
            k = (tag, arm)
            w, g = want.get(k, 0), got.get(k, 0)
            s = stats.get(k, {})
            done = g >= w and w > 0
            bar = int(28 * (g / w)) if w else 0
            acc = f"{s.get('ok',0)/g:.0%}" if g else "—"
            tie = f"{s.get('tie',0)/g:.0%}" if g else "—"
            con = f"{s.get('con',0)/g:.0%}" if g else "—"
            rows.append(
                f"<tr class='{'done' if done else ('run' if g else 'wait')}'>"
                f"<td>{html.escape(tlabel)}</td><td><b>{html.escape(arm)}</b></td>"
                f"<td class='n'>{g} / {w}</td>"
                f"<td class='bar'><span style='width:{100*g/w if w else 0:.0f}%'></span></td>"
                f"<td class='n'>{acc}</td><td class='n'>{tie}</td><td class='n'>{con}</td></tr>")
    status = ("跑完了" if total_g >= total_w
              else (f"停了 {idle/60:.0f} 分钟" if idle > 300 else "进行中"))
    return f"""<!doctype html><meta charset=utf-8><title>AB 实验进度</title>
<meta http-equiv=refresh content=3>
<style>
body{{font:14px/1.6 -apple-system,system-ui,sans-serif;margin:28px;color:#1a1a1a;background:#fafafa}}
h1{{font-size:19px;margin:0 0 4px}} .sub{{color:#888;font-size:12px;margin-bottom:18px}}
table{{border-collapse:collapse;width:100%;max-width:860px;background:#fff;
  box-shadow:0 1px 3px rgba(0,0,0,.08);border-radius:6px;overflow:hidden}}
th,td{{padding:9px 12px;text-align:left;border-bottom:1px solid #eee;font-size:13px}}
th{{background:#f4f6f8;font-weight:600;color:#555;font-size:12px}}
td.n{{text-align:right;font-variant-numeric:tabular-nums}}
td.bar{{width:190px}} td.bar span{{display:block;height:7px;background:#3b82f6;border-radius:4px}}
tr.done td.bar span{{background:#22c55e}} tr.wait td.bar span{{background:#ddd}}
tr.wait{{color:#aaa}}
.big{{font-size:30px;font-weight:600;margin:14px 0 2px}}
.note{{color:#888;font-size:12px;margin-top:16px;max-width:860px}}
</style>
<h1>AB 实验进度</h1>
<div class=sub>{html.escape(os.path.basename(run_dir))} · 每 3 秒自动刷新</div>
<div class=big>{pct:.0%} <span style='font-size:15px;color:#888;font-weight:400'>
  {total_g} / {total_w} 对 · 约 {total_g*2} / {total_w*2} 次调用 · {status}</span></div>
<table>
<tr><th>档</th><th>组</th><th>进度</th><th></th><th>答对</th><th>答平局</th><th>双向一致</th></tr>
{''.join(rows)}
</table>
<div class=note>
「答对 / 答平局 / 双向一致」是<b>跑到目前为止</b>的滚动值，不是最终结果 ——
最终判据以 <code>ab_verdict.py</code> 为准，那是跑之前定死的。<br>
双向一致率 50% 就是纯随机作答的期望值；判据里预设的通过线是 60%。
</div>"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run-dir", required=True)
    ap.add_argument("--pairs-dir", default="/tmp/claude-501/ab-pairs")
    ap.add_argument("--port", type=int, default=3090)
    a = ap.parse_args()

    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            body = render(a.run_dir, a.pairs_dir).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_):
            pass

    print(f"进度页 → http://127.0.0.1:{a.port}   （只读，不影响实验）")
    HTTPServer(("127.0.0.1", a.port), H).serve_forever()


if __name__ == "__main__":
    main()
