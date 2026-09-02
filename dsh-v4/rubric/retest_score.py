#!/usr/bin/env python3
"""标注者自己的重测信度 —— 任何模型能达到的一致性上限。

为什么必须先算这个：如果标注者自己重测只有 75% 一致，那模型跑到 70%
就已经贴着天花板，再优化提示词也没有空间；而且标注者自己会翻的那些题
是**纯噪声**，留在 AB 实验的分母里只会稀释真实效果。

两个口径都报：
  照片级  同一张照片，两次「留/不留」一不一致
  对级    同一对照片，两次的偏好方向一不一致（这一级才是 AB 实验的单位）

⚠️ keep/reject 是从散文里读出来的编码（见 retest.json，逐题附原话）。
   编码错了这个数就错了 —— 所以原话跟着一起存，可以核对。
"""
import collections, itertools, json, os, pathlib, sys

CAT = collections.Counter()


def load_order():
    """每题的展示顺序。第一轮用 _题目对照.json（**不是** _对照表.json，
    后者不按题号索引，用它会有 8 组对错）。"""
    h = pathlib.Path.home()
    T = json.loads((h / '.dsh-v4/photo-filter-v4/stage2-meta/_题目对照.json').read_text())
    Q = json.loads((h / '.dsh-v4/photo-filter-v4/ab-meta/ab-questions.json').read_text())
    r1 = {q: v['shown'] for q, v in T.items()}
    r2 = {q: [os.path.basename(p) for p in v['shown']] for q, v in Q.items()}
    # 第一轮的重测配对 = 同一 src_group 出现两次
    import collections
    by = collections.defaultdict(list)
    for q, v in T.items():
        by[v['src_group']].append(q)
    p1 = [tuple(sorted(v, key=int)[:2]) for v in by.values() if len(v) > 1]
    return r1, r2, sorted(p1, key=lambda x: int(x[0]))


def verdict(spec, i):
    if i in spec['keep']:
        return 'keep'
    if i in spec['reject']:
        return 'reject'
    return None


def main():
    here = pathlib.Path(__file__).parent
    E = json.loads((here / 'retest.json').read_text())
    r1, r2, p1 = load_order()
    # 第二轮的重测配对（内容哈希去重的结果）
    p2 = [('4', '9'), ('6', '25'), ('7', '17'), ('11', '28'), ('12', '13'),
          ('20', '30'), ('20', '33')]

    rows = []
    for rnd, pairs, order in (('第一轮', p1, r1), ('第二轮', p2, r2)):
        enc = E[rnd]
        for a, b in pairs:
            if a not in enc or b not in enc:
                continue
            A, B = order[a], order[b]
            same_order = A == B
            # b 的第 i 张 == a 的第几张
            m = {i + 1: A.index(x) + 1 for i, x in enumerate(B) if x in A}
            rows.append(dict(rnd=rnd, a=a, b=b, n=len(A), same_order=same_order, map=m))

    print("=" * 66)
    print("  标注者重测信度 —— 模型能达到的一致性上限")
    print("=" * 66)

    ph_ok = ph_n = 0
    pr_ok = pr_n = 0
    skipped = []
    print(f"\n{'':>4}{'题对':<12}{'张数':>4}{'照片级一致':>12}{'对级一致':>11}   备注")
    for r in rows:
        if r['same_order']:
            skipped.append(f"{r['rnd']}题{r['a']}/题{r['b']}")
            print(f"{'':>4}{r['rnd'][1]}轮 {r['a']}/{r['b']:<6}{r['n']:>4}{'—':>12}{'—':>11}   顺序没打乱，不算")
            continue
        ea, eb = None, None
        for rnd in ('第一轮', '第二轮'):
            if r['rnd'] == rnd:
                ea, eb = json.loads((here / 'retest.json').read_text())[rnd][r['a']], \
                         json.loads((here / 'retest.json').read_text())[rnd][r['b']]
        # 照片级
        ok = n = 0
        va = {}
        for ib, ia in r['map'].items():
            x, y = verdict(ea, ia), verdict(eb, ib)
            if x is None or y is None:
                continue
            va[ia] = (x, y)
            n += 1
            ok += x == y
        ph_ok += ok; ph_n += n
        # 对级：两次都表达了偏好方向的对
        # 对级必须**分解**，不能只报一个总一致率。
        #
        # 踩过：第一版把「一次给方向、一次判平」也算成不一致，
        # 得出 44.2%，看起来标注者自相矛盾得离谱。分解之后才看清：
        # 真正判反的只有 2.6%，绝大部分「不一致」是及格线飘了一格，
        # 不是判断反了。这两件事对实验的含义完全不同。
        pok = pn = 0
        for i, j in itertools.combinations(sorted(va), 2):
            (xa, ya), (xb, yb) = va[i], va[j]
            da = 0 if xa == xb else (1 if xa == 'keep' else -1)
            db = 0 if ya == yb else (1 if ya == 'keep' else -1)
            if da == 0 and db == 0:
                CAT['两次都判平'] += 1
            elif da == 0 or db == 0:
                CAT['一次给方向一次判平'] += 1
            elif da == db:
                CAT['两次方向相同'] += 1; pok += 1; pn += 1
            else:
                CAT['两次方向相反'] += 1; pn += 1
        pr_ok += pok; pr_n += pn
        print(f"{'':>4}{r['rnd'][1]}轮 {r['a']}/{r['b']:<6}{r['n']:>4}"
              f"{f'{ok}/{n}':>12}{f'{pok}/{pn}':>11}")

    print("\n" + "-" * 66)
    print(f"  照片级重测一致   {ph_ok}/{ph_n} = {ph_ok / max(ph_n,1):.1%}")
    print(f"  对级·两次都给方向 {pr_ok}/{pr_n} = {pr_ok / max(pr_n,1):.1%}   ← 排序的天花板")
    tot = sum(CAT.values())
    print(f"\n  全部 {tot} 对的分解：")
    for k in ('两次方向相同', '两次方向相反', '一次给方向一次判平', '两次都判平'):
        print(f"    {k:<22}{CAT[k]:>3}  {CAT[k] / max(tot,1):>6.1%}")
    print(f"\n  真正判反只占 {CAT['两次方向相反'] / max(tot,1):.1%}。")
    print(f"  不稳的是**及格线**不是排序：{CAT['一次给方向一次判平'] / max(tot,1):.0%} 的对是")
    print(f"  一次划在线两边、一次划在同一边。")
    if skipped:
        print(f"\n  排除 {len(skipped)} 对：{'，'.join(skipped)}（展示顺序没打乱，"
              f"分不出是判断稳定还是认出来照抄）")
    print("\n  ⚠️ 这是**上限**，不是目标。模型再好也不会超过标注者自己的稳定性；")
    print("     贴近它就说明提示词那一侧已经没有空间了。")
    return 0


if __name__ == '__main__':
    sys.exit(main())
