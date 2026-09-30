#!/usr/bin/env python3
"""部署的 profile 与仓库模板在「我们写的那些条目」上是否一致。一致退出 0，有漂移退出 1。

    python check_profile_drift.py <部署的 cordis.patch.yml> <仓库模板 cordis.patch.yml> <占位符替换表 JSON>

为什么不逐字节比：DSH 0.2 起界面上的设置（比如关掉「预览版说明」）会写回 profile 文件，
DSH 写回时会把整个文件重新序列化（`["x"]` 变成 `[ "x" ]`），还会追加它自己的条目。
逐字节比较会在用户每改一次界面设置之后都报「不一致」—— 假警报会把人训练成忽略这个工具。

所以只核模板里出现的条目：模板里的每一条（按 id 找；`insert` 块里的按插入的 id 找），
解析成数据结构后与部署的那一条逐项相等。部署里多出来的条目（DSH 或用户在界面上加的）不算漂移，只列出来。
占位符（@@REPO@@ 等）在比较前先按替换表换成本机路径，与 sync-config.sh push 同一套。
"""
import json
import sys

import yaml


def entries(doc: list) -> dict:
    """patch 列表 → {id: 条目}。`- insert: [...]` 里插入的条目按各自的 id 收进来。"""
    out = {}
    for item in doc or []:
        if not isinstance(item, dict):
            continue
        if "insert" in item:
            for row in item["insert"] or []:
                if isinstance(row, dict) and "id" in row:
                    out[row["id"]] = row
        elif "id" in item:
            out[item["id"]] = item
    return out


def main() -> int:
    deployed_path, template_path, subs_path = sys.argv[1:4]
    subs = json.loads(open(subs_path, encoding="utf-8").read())
    template_text = open(template_path, encoding="utf-8").read()
    for placeholder, value in subs.items():
        template_text = template_text.replace(placeholder, value)
    deployed = entries(yaml.safe_load(open(deployed_path, encoding="utf-8")))
    template = entries(yaml.safe_load(template_text))

    drift = []
    for key, want in template.items():
        have = deployed.get(key)
        if have is None:
            drift.append(f"条目 {key} 在部署的 profile 里没有了")
        elif have != want:
            fields = sorted(k for k in set(want) | set(have) if want.get(k) != have.get(k))
            drift.append(f"条目 {key} 的 {', '.join(fields)} 与模板不同")
    extra = sorted(set(deployed) - set(template))
    for line in drift:
        print(line)
    if extra:
        print(f"（部署里另有 {len(extra)} 条模板里没有的条目，是 DSH 或界面设置写入的，不算漂移：{', '.join(extra)}）")
    return 1 if drift else 0


if __name__ == "__main__":
    sys.exit(main())
