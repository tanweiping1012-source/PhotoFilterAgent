# 照片筛选 Agent

跑在 **DeepSeek Harness** 上的照片策展 agent：给它一个照片目录和保留目标，它自己决定
看哪些、看多细、什么时候够了，最后给出保留名单与理由。

原图全程只读——工具集里没有任何修改、移动或删除原图的能力，导出只有复制一条路径。

---

## 一条命令

```bash
./run.sh ~/Desktop/照片测试 50 3 3 ~/Desktop/照片筛选结果
#         照片目录          取样 人物 风景 导出目录
```

省略后面的参数就是全量、人物 6 张、风景 6 张、不导出：

```bash
./run.sh ~/Desktop/照片测试
```

也可以直接对话（同一个 profile，可多轮）：

```bash
cd <harness 目录>
pnpm dsh --profile photo "帮我从 ~/Desktop/照片测试 里挑 5 张最好的人物照"
```

---

## 它是怎么工作的

### 分工

| | 谁提供 |
|---|---|
| agent 循环、工具调度、会话、模型接入 | **DeepSeek Harness** |
| 本地照片分析（分类/连拍组/清晰度曝光） | `engine/` —— Swift CLI，独立进程 |
| 9 个模型可见工具、视觉打分、提议校验 | `agent/` —— cordis 插件 |

harness 的 `dsh-base` + `dsh-headless` 两个 bundle 提供底座，我们的插件通过
`~/.dsh/profiles/photo/cordis.patch.yml` 挂进去。

### 策略

问题的形状不是"给每张照片打分"，而是**带成本的 top-k 搜索**：要从 118 张里选 6 张，
根本不需要知道全部 118 张的准确分数，只需要便宜地砍掉底部、把钱花在切线附近。

而候选池不是一堆平的照片，它有结构——**连拍组**。这把问题拆成两个：

| | 判断类型 | 用什么 |
|---|---|---|
| **组内**（3 张几乎一样的连拍） | 纯相对 | `compare` —— 摆在一起比 |
| **组间**（海边 vs 山顶） | 需要绝对标尺 | `inspect` —— 五维打分 |

连拍之间的差别在表情、眼神、手的位置，清晰度指标对此完全无能为力。所以组内一律用比较，
不给每张都打绝对分——那是在为注定落选的照片付钱。

实际跑下来 agent 就是这么做的：11 组连拍各比一次定代表，剩下的 low 档粗筛，
只有切线咬得紧（分差 < 3）时才对那几张用 high 档。

### 工具

| 工具 | 花钱 | 说明 |
|---|---|---|
| `analyze_folder` | 免费 | 本地递归分析：分类、连拍组、清晰度曝光 |
| `list_candidates` | 免费 | 仍在竞争的候选与本地指标（不含图像） |
| `status` | 免费 | 排名、**切线分差**、待定连拍组、已花费 |
| `inspect` | **付费** | 五维打分，low=512px / high=1536px |
| `compare` | **付费** | 连拍组内 A/B，用低档图，很便宜 |
| `resolve_family` | 免费 | 定下组代表，同组其余退出候选 |
| `propose` | 免费 | 提交名单，过五项校验 |
| `export_selection` | 免费 | **只复制**到目标目录 |
| `local_fallback_selection` | 免费 | 无 Key 时的确定性选片 |

`status` 里的 **切线分差** 是给 agent 的成本信号：差 15 分就别再看了，差 1 分说明名次不稳。

### 提议校验（五条）

1. 都在候选池里
2. 不超过保留目标
3. 同一连拍组不超过一张
4. **每张都必须被 inspect 过** ← 防止推荐一张从没打开过的照片
5. 每张有理由

校验不过会把**原因**告诉模型，让它改了再提，而不是直接失败。

---

## 已验证的结果

在 `/Users/bytedance/Desktop/照片测试`（473 张真实照片）上实测：

### 人物 vs 风景分类：**99.6%**

真值取自目录结构（`me/` 是人物，其余是风景），不是我们标的。

```
                预测人物   预测风景
真值人物            307          2
真值风景              0        164

总准确率  99.6% (471/473)   人物精确率 100%   人物召回 99.4%
```

全量 473 张本地分析耗时 **14 秒**，不联网、不花钱。

### 端到端策展

50 张取样、人物 3 + 风景 3：

- 11 组连拍全部 `compare` 后定代表
- 打分 29 次、比较 14 次、**命中缓存省下 6 次**
- 只有切线附近用 high 档

### 原图安全

导出前后对 473 个源文件做全量 `shasum -a 256`：

```
✅ 473 个原文件逐字节完全一致 —— 未被移动、删除、改名或修改
✅ 6 个导出副本与原图逐字节相同
```

### 跨会话不重复计费

分数落盘在 `~/.dsh/photo-curator/state-*.json`，按「目录 + 取样上限」分片。
再次运行同一目录时已打过的分直接命中缓存：

```
已花费：打分 2 次 · 比较 0 次 · 命中缓存省下 2 次
```

打分次数没有从 2 变成 4——同一张同档位永远只付一次钱。

---

## 一个诚实的发现

`local_fallback_selection` 用的纯本地技术指标（清晰度/宽容度/过曝），和人的口味
**几乎不相关**。对着你自己的 `me-pick` / `景色pick` 实测：

```
人物：系统选 6 张 vs 人工精选 20 张 → 重合 0 张（随机期望 0.39）
风景：系统选 6 张 vs 人工精选 14 张 → 重合 0 张（随机期望 0.51）
人工精选在系统排名里散布在 20–302 名之间
```

这正是**视觉模型不可省**的证据：你选的是表情、是瞬间、是构图，本地分析器看不见这些。
本地兜底是安全网，不是产品。

接上视觉模型后，50 张样本（含 4 张你的人工精选）里 agent 选 6 张命中 1 张
（随机期望 0.52）。样本太小不构成统计显著，但方向对了。

---

## 配置

`~/.dsh/profiles/photo/cordis.patch.yml`：

```yaml
- insert:
    - id: photo-curator
      name: '@photo-curator/dsh-photo-curator'
      config:
        engineBinary: .../engine/.build/release/photocurate
        workdir: /Users/bytedance/.dsh/photo-curator
        visionModel: MiniMax-M3
        allowKeychain: false      # Keychain 读取会弹图形授权框并阻塞
        maxInspectBatch: 8
        visionTimeoutMs: 120000
```

### API Key

按 **环境变量 → `~/.dsh/.credentials.yaml` → Keychain** 的顺序解析。

当前用的是 `~/.dsh/.credentials.yaml` 里的 `MINIMAX_CN_API_KEY`（你已经配好的）。
Key 只在内存里传递：不写文件、不进 session log、不进模型可见的任何一步。

**Keychain 默认关闭**——从一个不拥有该条目的进程读取会弹出图形授权框并阻塞，
无人值守运行时那等于挂死。

---

## 隐私边界

- **发出去的只有**引擎生成的无元数据缩放 JPEG（最长边 512 / 1024 / 1536px）
- **不发**原图、文件名、绝对路径、GPS、绝对拍摄时间
- 候选表里只有匿名 ID（`p001`…）和相对秒数；ID ↔ 路径的映射只存在于
  `~/.dsh/photo-curator/index.json`，模型永远拿不到

---

## 目录结构

```
engine/     Swift：移植自 PhotoFilter 的分析引擎 + CLI
  Sources/photocurate/
    PhotoAnalysisPipeline.swift   单次解码流水线 + 并行调度
    PeopleSubjectClassifier.swift Vision 人物主题判定
    SimilarityGrouper.swift       连拍相似家族聚类
    TechnicalQualityAnalyzer.swift 清晰度 / 反差 / 曝光
    Selection.swift               确定性选片（分位数归一化）
    main.swift                    analyze / select / preview / resolve / export
agent/      TypeScript：cordis 插件
  src/
    index.ts    9 个模型可见工具
    state.ts    RunState、切线分差、提议五项校验、跨会话持久化
    vision.ts   MiniMax 视觉客户端
    engine.ts   CLI 封装
    apikey.ts   Key 解析
bench/      评测脚本（分类准确率、选片重合度）
run.sh      一键运行
```

---

## 已知限制

1. **11GB / 473 张全量策展没跑过**——本地分析跑过（14 秒），但全量视觉打分会很贵。
   目前验证到 50 张取样。
2. **DeepSeek Harness 是 v0.1 developer preview**，官方声明会有破坏性变更。
   插件对它的耦合面收窄在 `ctx.tools.register` + `defineTool` 上。
3. **分级授权还没做**。设计里 `propose` / `export_selection` 属于高风险动作应当弹确认，
   目前是直接执行——不过 `export` 只复制，最坏情况是多了一份副本。
4. **选片质量只在 50 张样本上量过**，命中 1/4，样本太小。
