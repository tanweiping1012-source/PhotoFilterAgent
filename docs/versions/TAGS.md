# 版本索引：tag ↔ 提交 ↔ 文档

> **`main` 分支刻意保持不动** —— 访客打开仓库看到的仍是 2026-08-24 的那一版。
> 所有迭代记录活在 tag、Release 和这个目录里。

## 怎么取到某一版的完整代码

```bash
git fetch --tags
git checkout v4.2          # 或 v4.1 / v4.0 / v2
```

## 版本表

| tag | 提交 | 这一版是什么 | 交付（人像 20 张） | 付费调用 | 文档 |
|---|---|---|---|---:|---|
| `v2` | `b387f45` | **= 当前 main**。视觉模型逐张打分，能出名单但没有独立证据 | 未测 | 每张 1 次 | [V2](V2-vision-scoring.md) |
| — | *不在本仓库* | **v3**：六维 rubric + 双向盲比 + 独立盲审。代码在另一份工作副本里 | 3/20 p=0.130 ⚠️ | **997 次** | [V3](V3-agent-rubric.md) · [原始设计稿](V3-original-spec-by-codex.md) |
| `v4.0` | `34eb6db` | 排序主干挪回本地：CLIP + 通用美学 + 个人口味探针 | 3/20 p=0.130 ⚠️ | 0 | [V4](V4-local-first.md) · [DSH 运行](V4-DSH-RUN-2026-08-30.md) · [泛化失败](V4-GENERALIZATION.md) |
| `v4.1` | `6c0e2a0` | 不要正样本，agent 问一句「要质量还是氛围」 | 4/20 p=0.032 | 0 | [V4.1](V4.1-ask-the-style.md) |
| `v4.2` | `e673359` | **匹配用户的选片结构** —— 不改打分，改输出的分布形状 | **5/20 p=0.0056 ✅** | 0 | [V4.2](V4.2-match-the-structure.md) |

## 为什么 v1 和 v3 没有 tag

- **v1**（纯本地技术指标）的代码没有独立的提交边界，它一直演化成了 v2；
  `engine/` 目录里那套 Swift 分析引擎就是它，至今仍在用（闭眼资格门就来自它）。
- **v3** 的代码在另一份工作副本上、且从未提交到本仓库。
  它的 707 行原始设计稿完整保留在 [V3-original-spec-by-codex.md](V3-original-spec-by-codex.md)，
  一字未改。

## 按主题读

| 想看什么 | 去哪 |
|---|---|
| 一次失败是怎么被定位的 | [V3 的事后诊断](V3-agent-rubric.md#六事后诊断为什么是这个结果) |
| 怎么判断一个选片器好不好 | [MEASUREMENT.md](../MEASUREMENT.md) |
| 换一批照片后方案失效 | [V4-GENERALIZATION.md](V4-GENERALIZATION.md) |
| 人像做到本地信号的尽头 | [V4.1-PORTRAIT-CEILING.md](V4.1-PORTRAIT-CEILING.md) |
| 风景为什么做不了 | [V4.1-SCENERY-NULL.md](V4.1-SCENERY-NULL.md) |
| 性价比最高的那处改动 | [V4.1-TEMPORAL-SPREAD.md](V4.1-TEMPORAL-SPREAD.md) |
| agent 层实测（含导出路径的故障） | [V4.1-AGENT-TEST-2026-08-31.md](V4.1-AGENT-TEST-2026-08-31.md) |

## 一句话串起来

v1 问「这张有没有毛病」，v2 问「模型觉得几分」，
v3 把 v2 的分数用一整套审计机制包起来（997 次调用 → AUC 0.497 = 掷硬币），
v4 发现**问题出在分数本身**、把打分挪回本地，
v4.1 发现**连「什么算好」都得先问一句**，
v4.2 发现**最强的先验是用户自己怎么挑** —— 让输出的形状去匹配他的行为。
