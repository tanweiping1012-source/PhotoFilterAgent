#!/usr/bin/env python3
"""仪器标定（instrument check）的实时进度页。

和 progress_server.py 的区别：那个页面是给**三臂 rubric 实验**做的
（臂 × 档 × 答对率），这一轮测的不是 rubric 好不好，是**仪器准不准**，
观测量完全不同 —— 条件矩阵、噪声地板 ε、扰动敏感度 δ、码读对率、编造率。
两个页面各自读各自的目录，互不影响。

数据源：<run-dir>/calls.jsonl，一次调用追加一行。
用 jsonl 而不是 result.json 是为了**逐次调用**可见 ——
上一轮那个页面按文件批量刷新，一个文件跑十几分钟才动一次。

用法：python3 instrument_server.py --run-dir <dir> [--port 3091]
只读，不碰实验本身。
"""
import argparse
import html
import json
import os
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

# 预登记判据。**写在代码里，跑之前就定死**，页面只负责显示达没达线。
# 改这里等于改判据 —— 跑起来之后不许改，理由见 ab_verdict.py 的同类注释。
GATES = {
    "eps":        (0.05, "le", "管线噪声 ε",     "＞5% → 历史所有 MDE 要重算"),
    "delta":      (0.30, "le", "扰动敏感 δ",     "≥30% → 决策边界任意，成对比较不可用"),
    "code_ok":    (0.90, "ge", "码读对率",       "＜90% → 图像通道有问题，位置之争无意义"),
    "halluc":     (0.02, "le", "幻觉码",         "＞2% → 答案不是内容寻址的"),
    "aa_nontie":  (0.20, "le", "AA 编造率",      "≥20% → 编造确认，理由字段永不外显"),
    "sanity":     (0.90, "ge", "正对照准确率",   "＜90% → 仪器失效，本轮作废"),
}

PHASES = (
    ("probe",  "① grounding 探针"),
    ("matrix", "② 条件矩阵 AB/AB′/AB″/BA"),
    ("aa",     "③ AA 对照（同一张照片）"),
    ("sanity", "④ 正对照（答案无争议）"),
)


def load(run_dir):
    rows = []
    p = os.path.join(run_dir, "calls.jsonl")
    if os.path.exists(p):
        with open(p, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except Exception:
                    pass          # 半行 = 正在写，下次刷新就好了
    plan = {}
    q = os.path.join(run_dir, "plan.json")
    if os.path.exists(q):
        try:
            plan = json.load(open(q, encoding="utf-8"))
        except Exception:
            pass
    mt = os.path.getmtime(p) if os.path.exists(p) else 0
    return rows, plan, mt


def disagree(rows, c1, c2):
    """两个条件之间「选中的物理照片不同」的比例。只算两个条件都跑到的对。"""
    by = {}
    for r in rows:
        if r.get("phase") != "matrix":
            continue
        by.setdefault(r.get("pair"), {})[r.get("condition")] = r.get("winner_photo")
    both = [(v[c1], v[c2]) for v in by.values() if c1 in v and c2 in v]
    # 平局/都不要不参与：它们不指向某一张照片，「选中的照片不同」无从谈起。
    both = [(x, y) for x, y in both if x and y]
    if not both:
        return None, 0
    return sum(1 for x, y in both if x != y) / len(both), len(both)


def stats(rows):
    s = {}
    eps, n_eps = disagree(rows, "AB", "AB2")
    d_raw, n_d = disagree(rows, "AB", "AB3")
    ba, n_ba = disagree(rows, "AB", "BA")
    s["eps"] = (eps, n_eps)
    s["delta"] = ((d_raw - eps) if (d_raw is not None and eps is not None) else None, n_d)
    if ba is not None and eps is not None and s["delta"][0] is not None:
        s["position"] = (ba - s["delta"][0] - eps, n_ba)
    else:
        s["position"] = (None, n_ba)
    s["ba_raw"] = (ba, n_ba)

    graded = [r for r in rows if r.get("phase") in ("matrix", "aa", "sanity")]
    if graded:
        ok = sum(1 for r in graded
                 if r.get("read_jia") == r.get("code_jia") and r.get("read_yi") == r.get("code_yi"))
        s["code_ok"] = (ok / len(graded), len(graded))
        hal = sum(1 for r in graded
                  if r.get("winner_code")
                  and r["winner_code"] not in (r.get("code_jia"), r.get("code_yi")))
        s["halluc"] = (hal / len(graded), len(graded))
    else:
        s["code_ok"] = (None, 0)
        s["halluc"] = (None, 0)

    aa = [r for r in rows if r.get("phase") == "aa"]
    s["aa_nontie"] = ((sum(1 for r in aa if r.get("winner_photo")) / len(aa), len(aa))
                      if aa else (None, 0))
    sn = [r for r in rows if r.get("phase") == "sanity"]
    s["sanity"] = ((sum(1 for r in sn if r.get("correct")) / len(sn), len(sn))
                   if sn else (None, 0))
    return s


def gate_row(key, s):
    val, n = s.get(key, (None, 0))
    thr, op, label, note = GATES[key]
    if val is None:
        return (f"<tr class=wait><td>{html.escape(label)}</td><td class=n>—</td>"
                f"<td class=n>{'≤' if op=='le' else '≥'} {thr:.0%}</td>"
                f"<td class=n>n=0</td><td class=note2>{html.escape(note)}</td></tr>")
    passed = (val <= thr) if op == "le" else (val >= thr)
    cls = "pass" if passed else "fail"
    return (f"<tr class={cls}><td>{html.escape(label)}</td>"
            f"<td class='n big2'>{val:.0%}</td>"
            f"<td class=n>{'≤' if op=='le' else '≥'} {thr:.0%}</td>"
            f"<td class=n>n={n}</td><td class=note2>{html.escape(note)}</td></tr>")


def render(run_dir):
    rows, plan, mt = load(run_dir)
    s = stats(rows)
    total = plan.get("total_calls") or 0
    done = len(rows)
    idle = time.time() - mt if mt else -1
    status = ("跑完了" if total and done >= total
              else (f"停了 {idle/60:.0f} 分钟" if idle > 300 else ("进行中" if done else "还没开始")))

    ph = []
    for key, label in PHASES:
        want = (plan.get("per_phase") or {}).get(key, 0)
        got = sum(1 for r in rows if r.get("phase") == key)
        cls = "done" if want and got >= want else ("run" if got else "wait")
        pctw = 100 * got / want if want else 0
        ph.append(f"<tr class={cls}><td>{html.escape(label)}</td><td class=n>{got} / {want or '?'}</td>"
                  f"<td class=bar><span style='width:{pctw:.0f}%'></span></td></tr>")

    probe = [r for r in rows if r.get("phase") == "probe"]
    probe_html = "<div class=sub>探针还没跑</div>"
    if probe:
        p = probe[-1]
        ok = p.get("bbox_on_face")
        n_ok = sum(1 for r in probe if r.get("bbox_on_face"))
        ious = [r.get("reason", "") for r in probe]
        probe_html = (f"<div class='verdict {'pass' if ok else 'fail'}'>"
                      f"grounding：{'能框（框落在顶部黑边上）' if ok else '框不准'}"
                      f" · {n_ok}/{len(probe)} 次达线</div>"
                      f"<div class=sub>最近一次返回框 {html.escape(str(p.get('bbox')))} · "
                      f"黑边真值 {html.escape(str(p.get('face_box_truth')))} · "
                      f"各次 {html.escape(' / '.join(ious))}<br>"
                      f"注：框的是<b>高对比度黑边</b>（真值精确已知），不是人脸。"
                      f"这只说明 grounding 机制可用，不代表能精确定位判断依据 —— "
                      f"实测系统性低估边高约一半，所以 face_box 只做探索性记录，<b>不作判据</b>。</div>")

    last = rows[-5:][::-1]
    log = "".join(
        f"<tr><td>{html.escape(str(r.get('phase')))}</td><td>{html.escape(str(r.get('condition') or ''))}</td>"
        f"<td>{html.escape(str(r.get('pair') or ''))}</td>"
        f"<td>{html.escape(str(r.get('winner_code') or '—'))}</td>"
        f"<td class=r>{html.escape(str(r.get('reason') or '')[:38])}</td></tr>"
        for r in last) or "<tr class=wait><td colspan=5>还没有调用</td></tr>"

    return f"""<!doctype html><meta charset=utf-8><title>仪器标定进度</title>
<meta http-equiv=refresh content=3>
<style>
body{{font:14px/1.6 -apple-system,system-ui,sans-serif;margin:28px;color:#1a1a1a;background:#fafafa}}
h1{{font-size:19px;margin:0 0 4px}} h2{{font-size:14px;margin:26px 0 8px;color:#555}}
.sub{{color:#888;font-size:12px;margin-bottom:14px}}
table{{border-collapse:collapse;width:100%;max-width:900px;background:#fff;
  box-shadow:0 1px 3px rgba(0,0,0,.08);border-radius:6px;overflow:hidden}}
th,td{{padding:9px 12px;text-align:left;border-bottom:1px solid #eee;font-size:13px}}
th{{background:#f4f6f8;font-weight:600;color:#555;font-size:12px}}
td.n{{text-align:right;font-variant-numeric:tabular-nums}}
td.r{{color:#777;font-size:12px}}
td.note2{{color:#999;font-size:11px}}
td.big2{{font-size:16px;font-weight:600}}
td.bar{{width:220px}} td.bar span{{display:block;height:7px;background:#3b82f6;border-radius:4px}}
tr.done td.bar span{{background:#22c55e}} tr.wait td.bar span{{background:#ddd}}
tr.wait{{color:#aaa}}
tr.pass td.big2{{color:#16a34a}} tr.fail td.big2{{color:#dc2626}}
.big{{font-size:30px;font-weight:600;margin:14px 0 2px}}
.verdict{{padding:10px 14px;border-radius:6px;max-width:900px;font-weight:600;font-size:13px}}
.verdict.pass{{background:#dcfce7;color:#166534}} .verdict.fail{{background:#fee2e2;color:#991b1b}}
.note{{color:#888;font-size:12px;margin-top:18px;max-width:900px}}
</style>
<h1>仪器标定 · instrument check</h1>
<div class=sub>{html.escape(os.path.basename(run_dir))} · 每 3 秒自动刷新 · 只读</div>
<div class=big>{(done/total if total else 0):.0%}
  <span style='font-size:15px;color:#888;font-weight:400'>{done} / {total or '?'} 次调用 · {status}</span></div>

<h2>① grounding 探针</h2>
{probe_html}

<h2>阶段进度</h2>
<table><tr><th>阶段</th><th>调用</th><th></th></tr>{''.join(ph)}</table>

<h2>预登记判据（跑之前定死，页面只显示达没达线）</h2>
<table><tr><th>量</th><th>实测</th><th>通过线</th><th>样本</th><th>不达线意味着</th></tr>
{gate_row('code_ok', s)}{gate_row('halluc', s)}{gate_row('eps', s)}
{gate_row('delta', s)}{gate_row('aa_nontie', s)}{gate_row('sanity', s)}
</table>

<h2>分解</h2>
<table><tr><th>量</th><th>值</th><th>样本</th><th>含义</th></tr>
<tr><td>d(AB, BA) 原始不一致</td><td class='n big2'>{_f(s['ba_raw'][0])}</td><td class=n>n={s['ba_raw'][1]}</td>
    <td class=note2>你历史上看到的那个 ~50%</td></tr>
<tr><td>其中 ε 管线噪声</td><td class='n big2'>{_f(s['eps'][0])}</td><td class=n>n={s['eps'][1]}</td>
    <td class=note2>temp=0，理论上应为 0</td></tr>
<tr><td>其中 δ 扰动敏感</td><td class='n big2'>{_f(s['delta'][0])}</td><td class=n>n={s['delta'][1]}</td>
    <td class=note2>肉眼不可见的重编码就翻转的比例</td></tr>
<tr><td><b>剩下的 = 位置效应</b></td><td class='n big2'>{_f(s['position'][0])}</td><td class=n>n={s['position'][1]}</td>
    <td class=note2>扣掉噪声和脆弱度之后，真正归因于位置对调的部分</td></tr>
</table>

<h2>最近 5 次调用</h2>
<table><tr><th>阶段</th><th>条件</th><th>对</th><th>选中码</th><th>理由</th></tr>{log}</table>

<div class=note>
判据在 <code>instrument_server.py</code> 顶部的 <code>GATES</code> 里，和这一轮的
<code>INSTRUMENT-CHECK.md</code> 一致，**跑起来之后不改**。<br>
ε / δ / 位置效应 三个数是滚动值，样本数小的时候会跳，以跑完为准。
</div>"""


def _f(v):
    return "—" if v is None else f"{v:.0%}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run-dir", required=True)
    ap.add_argument("--port", type=int, default=3091)
    a = ap.parse_args()
    os.makedirs(a.run_dir, exist_ok=True)

    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            body = render(a.run_dir).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_):
            pass

    print(f"仪器标定进度页 → http://127.0.0.1:{a.port}   （只读）")
    HTTPServer(("127.0.0.1", a.port), H).serve_forever()


if __name__ == "__main__":
    main()
