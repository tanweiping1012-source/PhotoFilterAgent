# Pick overlap evaluation

只有 PhotoFilterAgent 在 exact-K、audit v3 `PASS` 和 `propose` 校验后生成的冻结 receipt，
才能解锁本地 oracle 评测。CLI 不再接受任意 `selected` 目录：

```bash
node scripts/evaluate-pick-overlap.mjs \
  --receipt /path/to/private/acceptance-receipts/RECEIPT_HASH.json \
  --oracle /absolute/source-root/me-pick \
  --json /existing/output-directory/overlap.json
```

运行顺序是 fail-closed 的：先完整校验 receipt schema、整体 hash、dataset、candidate scope、
exact-K 匿名 ID、selection hash、audit `PASS`、实际 route、rubric/prompt 和扫描排除策略；之后才
解析 oracle。Oracle 的 realpath 必须恰好等于 receipt 中 `sourceRoot + excludedRelativePath` 的
某个声明子树，不能是相邻目录、符号链接逃逸或任意外部目录。

Receipt 由插件在本地私有工作目录生成，入选证据是匿名 ID 与原图 SHA-256，不包含 selector
理由、分数、文件名或排名；无需导出或复制照片。评测器递归读取常见图片格式并以流式 SHA-256
匹配，不联网、不修改图片。`--json` 可省略，父目录必须预先存在；控制台和 JSON 只输出
`selected_count`、`oracle_count`、`intersection_count`、Precision、Recall、F1、Jaccard 和
`pass_90`，不输出路径或图片哈希。

计数采用 multiset 语义；不同匿名 ID 对应相同内容时不会被去重或夸大交集。`pass_90` 只有在
Precision 和 Recall 都不低于 `0.9` 时为 true。若 selection 与 oracle 都恰好为 K 张，即至少命中
`ceil(0.9 * K)` 张。
