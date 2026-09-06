# PhotoFilterAgent

> 从一批旅行照片里，不只排除坏片，而是挑出真正值得留下的照片。人像正在完成整套“最好”
> 闭环验收；风景已有独立基础能力，但仍在补齐同等级的全局比较与反例审计。

<!--
候选 README，2026-08-27。正式 README 与 GitHub 发布必须等待真实 DSH 验收、独立审计和人工
pick 重合率通过。这个注释在 GitHub 页面不渲染，避免让首次访问者先阅读项目内部工作状态。
-->

## 旅行结束后，你真正面对的问题

一次旅行可能带回几百甚至几千张照片。最累的往往不是修图，而是选片：

- 同一地点连续拍了几十张，看起来几乎一样，但眼神、表情和动作只有一张最好；
- 同一个风景机位也可能拍了很多次，真正的差别在光线、云层、人流、浪花和构图时机；
- 很多照片都没有闭眼、失焦或过曝，却只有少数真正像一张完成的作品；
- 你可能喜欢自然抓拍，同行的人却更喜欢看镜头、笑容明确的照片；
- 逐张放大比较非常耗时，全部交给高清视觉模型又慢、又贵；
- AI 给出一份名单并不等于可信——你还需要知道它有没有漏掉更好的照片，失败后会不会重新收费，
  以及它会不会动到原图。

传统“坏片检测”主要回答：**这张照片能不能用？**

PhotoFilterAgent 要回答的是更难的问题：

> **在这整批照片里，人物和风景分别应该留下哪几张；如果用户有偏好，最终名单应该怎样有边界地
> 变化？**

## 它会怎样帮你

你可以直接在对话中描述任务：

> 从 `~/Pictures/冰岛旅行` 里先挑出 20 张最好的人像。偏好自然抓拍和环境人像，同一段连拍不要
> 太重复。先告诉我预计要看多少张高清图和大概会发生多少次比较，暂时不要导出。

PhotoFilterAgent 会：

1. 在本机扫描照片、区分人物与风景并建立匿名候选，不调用 AI；
2. 对人物和风景使用不同的视觉标准，不让模型临时猜测应该看什么；
3. 用低分辨率预览完成全量评估，把昂贵的高清复核集中在真正影响结果的位置；
4. 对真正难分的两张照片交换前后顺序比较两次，减少模型位置偏差；
5. 在质量足够接近时，让最终 20 张在表情、动作、景别和场景上更丰富；
6. 让一个看不到主选择过程的独立评估 Agent 尝试找出“被漏掉的更好照片”；
7. 只有验证通过才提交精确数量的名单；只有你另外确认，才会复制导出。

它不会把“技术上合格”误写成“已经选到最好”，也不会用多样性把明显更弱的照片救进名单。

## 你会得到什么

- 一份按类别精确达到目标数量的精选名单，而不是含糊的候选集合；
- 每张照片的选择理由、基础质量分和偏好后的变化；
- 本轮全量评估、高清复核、成对比较、缓存命中与剩余工作的可解释记录；
- 独立审计的 PASS / FAIL 和可复现的选择凭证；
- 中断后只补未完成项目的恢复能力；
- 只有明确确认后才执行的安全导出。

原图始终只读。AI 只接收在内存中生成、等比缩放并剥离元数据的匿名 JPEG；导出不会移动、
删除、覆盖或写回原照片。

适合旅行、人像写真、家庭和活动照片的批量精选。当前形态是运行在 DeepSeek Harness 中的 macOS
Photo Curator 插件。

## 人像与风景都属于产品，但成熟度不同

两类照片共享本机扫描、匿名预览、当前会话模型路由、缓存恢复和安全导出，但不能共用一套审美
标尺：

| | 人像重点 | 风景重点 |
|---|---|---|
| 决定性瞬间 | 表情、眼神、姿态、人物关系 | 光线、天气、人流、云浪与季节时机 |
| 构图 | 人物位置、边缘、背景干扰、人与环境关系 | 水平透视、前中后景、空间层次、视觉动线 |
| 主体 | 人物是否清楚、自然且具有感染力 | 画面是否存在明确视觉重心，而非平均杂乱 |
| 光线 | 肤色、面部塑形与人物分离 | 整体影调、动态范围、色彩和氛围 |
| 叙事 | 人物与地点、事件、旅途体验的联系 | 地点、季节、尺度和场景独特性 |

当前能力必须如实分开说明：

- **人像**：正在验收完整的“全池 baseline → high → AB/BA → Bradley–Terry → 有界多样性 →
  independent audit”最佳选择闭环。
- **风景**：已经有独立风景五维标尺、low/high 单图评分、同场景比较、缓存和精确数量校验；但仍是
  旧版人工编排流程，还没有自动冻结预算、双向比较聚合和独立反例审计。
- **人物+风景混合任务**：本地分析能够同时分类和设定数量，但当前新版人物门禁要求
  `scenery_target=0`，混合 exact-K 不能宣称已经闭环。现阶段应把人物与风景拆成两个任务运行。

因此，下面先完整解释已经进入 v3 验收的人像算法，再单独说明风景现状与需要补齐的机制。

---

## 解决思路：共享 Agent 外壳，类别使用独立选择器

```text
本机扫描、匿名化、人物/风景分类
        │
        ├── 人像 v3（已实现，待最终验收）
        │     全池 baseline → high 预算 → AB/BA → 全局聚合
        │     → 有界多样性 → 独立 Agent 寻找反例
        │
        └── 风景基础版（已实现）
              独立风景标尺 → low/high 评分 → 同场景比较
              → 目标：补齐自动预算、AB/BA、聚合与独立审计

各类别验证通过 → 精确数量名单 → 用户确认后导出
```

目标架构遵守三个基本原则：

1. **先完整，再精细**：每张候选至少获得同一套 low baseline，不能因为连拍代表选错而永远失去
   参赛机会。
2. **贵的注意力只花在会改变结果的地方**：high 和 pairwise 都有预先冻结的硬预算。
3. **选择之后必须尝试推翻自己**：独立 evaluator 不读取 selector 的理由和排名，只负责寻找反例。

---

## Agent 是怎么运行的

PhotoFilterAgent 不是把所有照片塞进一条固定脚本。它运行在
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 中，由当前会话的主 Agent 根据
已经观察到的状态决定下一步：

1. 理解用户目标、数量、偏好、允许访问的目录和副作用边界；
2. 调用受限领域工具观察候选池，而不是直接读取原图；
3. 先生成付费计划，再执行冻结计划；
4. 在人像 v3 中，根据 low 分数、family 和入选切线决定哪些照片值得 high 或 pairwise；
5. 把每次尝试和成功结果写入 checkpoint，失败后只补 remaining；
6. 当前把冻结的人像名单交给独立 evaluator；风景要达到同一门槛仍需补对应 evaluator；
7. 在审计、凭证和用户确认都满足后才允许产生副作用。

### 三个相互隔离的角色

| 角色 | 能看到什么 | 负责什么 |
|---|---|---|
| 主 Agent | 匿名候选、工具状态、用户目标和授权目录 | 规划、调用、恢复和解释，不直接看图片像素 |
| 单次视觉评分员 | 一张匿名 JPEG，或一对匿名 JPEG，以及冻结 rubric | 独立评分或比较；看不到文件名、排名、入选状态和偏好 |
| Independent evaluator | 授权目录、候选范围、冻结人像名单、K、seed | 在独立会话和缓存中重新评分并寻找反例；风景版本待补 |

主 Agent 不能手工改写 `build_selection` 冻结的 exact-K 名单；独立 evaluator 也看不到 selector 的
分数、选择理由和中间推理。

---

### 模型路由跟随当前 DSH 会话

Photo Curator preset 和视觉工具不固定 MiniMax，也没有独立的默认 `visionModel`。所有已实现的
人物与风景视觉调用都必须继承用户在当前 DSH 会话中选择的同一个
`provider/model/reasoning effort`：

- 主 Agent；
- 人像 v3 的全池 low baseline、high 复核、selector AB/BA，以及 independent evaluator 的
  baseline、promotion high 和 audit AB/BA；
- 风景基础版的 `inspect` 与同场景 `compare`。

独立 evaluator 的“独立”指独立会话、persona、prompt、rubric、缓存和不可见的 selector 状态，
不代表偷偷切换另一个模型。

在首张图片发送前，插件会检查：

- 当前 provider/model 路由和凭据是否可用；
- 是否支持 image input；
- 是否能按当前实验组需要的**完整输出合同**完成 tool call / structured output；
- Harness attachment 的图片数量和字节限制。

这里不是只发一个 `ok=true` 的形式探针。A 会在不附带图片时分别验证 legacy 单图评分和 pairwise
两类合同；B/C 会分别验证 low、high（含主人物 focus）和 pairwise 三类合同。探针与随后图片请求使用
同一个 DSH adapter、provider、model、reasoning effort 和传输协议；任一合同不通过，首张照片都不会
写入 attachment store 或发送给模型。

当前候选传输协议是 `dsh-llm-typed-envelope-v4`：模型侧使用完整类型定义的工具参数结构
`{ nonce, result }`，其中 result 直接是对象，避免 JSON 字符串的第二层转义。完整领域 JSON Schema
同时写在工具的 result 字段定义和请求的 `OUTPUT CONTRACT` 中；返回后由插件核对随机 nonce 和信封字段，并继续用原领域
validator 逐字段验真。这样做是因为 MiniMax 当前
Anthropic 兼容接口的 `tool_choice` 只支持 `auto/none`，不能依赖“强制指定某个工具”来获得可靠结构；
但协议仍坚持**必须且只能有一次目标 tool call**，纯文本 JSON、Markdown、缺字段或额外调用都按失败
处理，不会被宽松解析成评分，也不会切换供应商。参考：[MiniMax Anthropic API](https://platform.minimax.io/docs/api-reference/text-chat-anthropic)、
[MiniMax M3 Tool Use](https://platform.minimax.io/docs/guides/text-m3-function-call)。

能力不满足时明确阻止，不能静默回退到 MiniMax 或其他模型。所有 checkpoint/cache identity 都绑定
实际 provider、model、reasoning effort、视觉协议、rubric hash 和 prompt hash；切换任一项后旧结果
自动失效。无图预检缓存另绑定完整探针集合。无图探针本身会产生模型请求和少量 token，但不会包含照片内容。

任何一次开发验收所选的具体模型都只是当时的 DSH 会话配置，不是 PhotoFilterAgent 的产品默认设置。

---

## 人像算法机制：如何从“都不错”里选出“最好”

### 1. 本地分析与匿名化

`analyze_folder` 在本机完成候选枚举、基础技术指标、人物提示、匿名 ID 和视觉相似 family 分组，
不调用 AI。人工 pick/oracle 子树必须在枚举、fingerprint 和匿名 ID 产生之前明确排除。

当前 family 是视觉相似场景组，不是相机 Burst 元数据：

- 使用 64-bit 灰度感知哈希；
- 动态范围过低的图片不参与相似度分组；
- 严格近重复：Hamming 距离不超过 4，平均亮度差不超过 40，不要求时间接近；
- 同场景候选：拍摄时间在 120 秒内，Hamming 距离不超过 14，亮度差不超过 55。

这个分组只用于精排挑战者和集合数量限制，不再用一个代表过早替整组参赛。所有人物候选仍进入
全池 baseline。

### 2. 冻结 baseline rubric（A 组旧基线）

当前产品人像 v3、也是锚点实验 A 组的旧基线，在没有用户偏好时让每张人物照片使用同一套独立
rubric：

| 维度 | 权重 |
|---|---:|
| 技术质量与主体可读性 | 18% |
| 人物瞬间 | 22% |
| 构图与视觉层级 | 18% |
| 光线、色彩与影调 | 16% |
| 旅行语境与叙事 | 16% |
| 意图与完成度 | 10% |

模型只返回六维分数、置信度、像素证据、区间和可观察标签，总分由本地按冻结权重重算。

只有四类情况能够使照片失去资格：

- 无法解码或无法视觉评估；
- 没有有意拍摄的人物主体；
- 主要人物状态无法解释；
- 灾难性拍摄失败使画面意图无法成立。

在这套旧基线中，闭眼、侧脸、背影、剪影、遮挡、运动模糊或非常规表情本身都不是自动淘汰条件。
输出如果出现
“技术清晰、人物明确”却同时标记灾难性失败等自相矛盾，结构化一致性校验会拒绝该结果并只重试
这一张，不能把矛盾结果写入排名。

锚点实验 B/C 不会悄悄改写这个 A 组。它们使用另一份冻结的分层 rubric：先判断硬淘汰，再判断
`reject / keep_threshold / keep / best / uncertain` 绝对保留线，最后才给过线照片排序。单一主要人物
高置信度闭眼/眨眼、人脸因技术问题不可读、无有意人物主体和明显超出生理正常范围的姿态属于硬
淘汰；两张都不过线时必须返回 `reject_both`，不能从坏片里强选“相对不差”的一张。过线后的五维
权重为：表情与眼神 35%、五官与脸型 25%、姿态与值得保留的瞬间 15%、技术完成度 15%、环境与
画面 10%，即人物呈现合计 75%。这正是 A/B/C 要验证的产品假设，尚未通过真实验收前不会替换
正式默认基线。

### 3. 用户偏好是有界 overlay

用户可调整表情、视线、景别、光线、氛围、维度权重、多样性强度和连拍保留策略。偏好不修改
baseline rubric，也不能救回资格不合格照片。

- 单张偏好调整默认和最大都是 `±4` 分；
- baseline 分和 personalized 分分别保存；
- 空偏好严格回到 baseline；
- 多样性另有最多 4 分的集合级预算，不永久修改单图 baseline。

连拍保留策略：

- `balanced`：默认，自动选择仍能凑满 exact-K 的最小统一 family cap；
- `one_per_family`：每个 family 最多一张，容量不足时明确失败；
- `allow_series`：取消 family cap，允许保留完整系列。

### 4. 全池 low baseline

`evaluate_pool detail=low` 必须评估全部人物候选，包括同一 family 中的每一张。low 预览：

- 最长边最多 512px；
- 保持原始宽高比，不裁切、不拉伸、不补正方形；
- 应用 EXIF 方向；
- JPEG 质量 0.82；
- 不复制 EXIF、GPS、文件名或其他源文件属性；
- 只在内存中生成，不覆盖原图。

本轮测试集抽样 40 张 low 预览，中位数约 36KB、平均约 42KB、90% 不超过约 61KB。图片作为
Harness attachment 进入 provider，不能把 JPEG/Base64 字节数直接换算成视觉 token。

每次 provider 调用前先持久化 attempted ledger，成功后再写 score cache。中断恢复只补 missing；
401/403/429、额度、鉴权或模型能力错误触发 circuit breaker，同一 turn 不自动重复烧 token。

### 5. 先冻结 high 预算，再执行

`build_selection mode=plan` 不发送图片，先冻结 high 和 pairwise 预算；`mode=run` 只能执行这份计划。

当目标 `K=20` 时，当前策略为：

- high hard cap：`max(K×3, K+20) = 60`；
- 全局基础候选：`max(K×2, K+10) = 40`；
- 查看全局前 `K+10 = 30` 中出现的 family；
- 每个相关 family 最多补 2 个挑战者；
- 剩余名额按全局分数补齐到最多 60。

high 预览最长边 1536px，用于确认表情、眼神、对焦、边缘和细节。计划和每次调用都持久化；恢复时
只补未完成 high，不重新评估已经成功的照片。

### 6. AB/BA 双向盲比较

每个逻辑 pair 使用两次独立请求：

1. AB：FIRST=A，SECOND=B；
2. BA：FIRST=B，SECOND=A。

模型不知道匿名 ID、排名、入选状态或用户偏好。A 组保持旧六维合同；B/C 使用上述新五维分层合同，
并额外返回左右绝对层级和 `reject_both`。两类合同都不直接相信模型的“总胜者”：模型返回每维
`-2..2` 相对差、置信度和理由，每维 `+2/+1/0/-1/-2` 分别表示 FIRST 明显更好、FIRST 略好、难分、
SECOND 略好、SECOND 明显更好。BA 结果会归一化回固定 A/B 语义，总方向由本地按各自冻结权重
唯一计算，避免声明结果与维度证据自相矛盾。

只有同时满足以下条件才产生稳定胜者：

- 两个方向都不是 TIE；
- 归一化后指向同一张真实照片；
- 两个方向本地计算出的加权 margin 同号；
- 两个方向平均绝对 margin 至少 2 分；
- 两个方向平均置信度至少 0.70。

否则逻辑结果为 TIE。AB 和 BA 是两个可独立恢复的 directional leg，但合并后只算一场比赛。

selector 使用最多 24 组比较构造 comparison-first 图：

- 独立 audit 返回的反例优先占用比较位，但不把 evaluator 分数带回 selector；
- 最多三分之一预算用于高位 family 前两名，且两张分差不超过 6；
- 剩余预算在 Top-K 切线两侧构造相邻 ladder，最多用 24 条边连接 25 个候选；
- 每条边仍执行 AB/BA 两个 directional legs，因此硬上限为 48 次 provider calls。

连接切线 ladder 的目的不是增加调用数，而是让相对胜负处在同一个连通子图中，Bradley-Terry 才能
传播证据；旧版多个互不相连的一次性比较无法可靠形成全局顺序。

### 7. baseline 锚定的 Bradley-Terry 聚合

Bradley-Terry 把稀疏的“谁胜过谁”证据转成全局可比较分数：

```text
P(A 胜 B) = sigmoid(ability(A) - ability(B))
```

每张照片的 baseline/personalized 分数先转换为隐藏能力先验。稳定胜、负分别作为 `1/0` 输入；
AB/BA 不一致的 TIE 表示“无方向证据”，不会被错误当成两张质量相等。比较权重由置信度决定。当前
使用 `priorStrength=2`、最多 120 次正则化迭代，并限制单步更新，
所以少量 pairwise 只能局部纠偏，不会轻易推翻完整 baseline。没有 pairwise 时输出保持原分数。

### 8. 有界多样性与 family cap

有界多样性的原则是：只有质量已经足够接近，才允许“整套更丰富”影响入选。

每选下一张时：

1. 找出当前可选照片中最高的 Bradley-Terry `comparisonScore`；
2. 只保留与它相差不超过 4 分的质量前沿；
3. 用表达、视线、景别、光线、氛围、场景和姿态标签计算与已选集合的语义新颖度；
4. 按 `diversity × 4 × novelty` 增加最多 4 分；
5. 选择当前 final score 最高者并继续下一轮。

完全相似的照片奖励接近 0，完全不同的照片最多加 4；落后超过 4 分的弱片连竞争资格都没有。
family cap 是另一层硬约束：默认 `balanced` 选择满足 exact-K 所需的最小统一上限。本轮 K=20 的
测试结构中，cap=1 无法凑满，cap=2 可以，因此默认每个 family 最多两张。

当前多样性使用结构化离散标签和 Jaccard 相似度，不是 embedding。这使行为可解释、可测试，但对
细腻审美差异仍较粗，是后续可继续优化的节点。

### 9. 独立 evaluator 的 audit v3

主 Agent 只能把以下五项交给专用 evaluator：

- 授权目录；
- candidate scope；
- exact-K selected IDs；
- K；
- 固定 seed。

不能传 selector 的分数、理由、偏好、排名或中间状态。evaluator 使用父会话相同模型路由，但运行在
独立子会话中，并拥有独立 prompt、rubric role、score cache 和 pairwise cache。

完整 `FAIL` 只向 selector 返回匿名反例 ID，不返回 evaluator 分数、排序理由或审计上下文。下一轮
selector 仍需用自己的 rubric 对这些照片补齐 high 和 AB/BA；确认仍为 eligible 后，反例 ID 会成为
下一版 exact-K 的 active-set 约束。它们不能再被 family cap 或多样性奖励挤出，否则系统只会付费
重新发现同一批反例。修复后的名单仍必须交给新的独立审计尝试推翻；active-set 修复不是 PASS 捷径。

审计阶段：

1. selected 全部 high；
2. remaining 全部 low；
3. 固定 seed 随机样本优先进入 high promotion；
4. 再加入有界 cutline 和 family challengers；
5. promotion high 总上限 60，各主要组件上限 20；
6. 最强 promoted challengers 最多做 8 组 AB/BA，即 16 directional legs。

同 family 挑战者优先对比该 family 中最弱的入选照片，否则对比全局最弱入选照片。挑战者如果在
high baseline 上超过最弱入选项 4 分以上，或在严格 AB/BA 中稳定胜出，就构成反例并返回 FAIL。
只有所有计划项完整覆盖且没有反例才能 PASS。

### 10. Receipt、oracle 与导出边界

只有 audit v3 PASS 后，`propose` 才允许原样接受 selector 冻结的 exact-K 名单。Receipt v2 绑定：

- dataset fingerprint 和候选范围；
- selection hash、selected IDs 和匿名排序顺序；
- rubric/prompt/protocol；
- 实际 provider/model；
- preference hash、排序策略版本、high/pairwise 预算算法版本和本地门禁版本；
- audit PASS；
- 排除策略和入选原图内容哈希。

验收 oracle 只能在 receipt 生成后由另一个隔离评估进程读取。它只报告 selected/oracle/intersection、
precision、recall、F1、Jaccard 和是否达到 90%，不能把 oracle 反馈给 selector 继续调参。

“扫描时排除 oracle”不等于可以把人工 pick 从候选宇宙中拿走。若人工 pick 是移动产生的，付费运行
前必须用隔离的本地预检确认：oracle 数量与 K 一致，并且每一份 oracle 图片内容仍存在于排除子树后
的候选池。预检按内容 multiset 比对但只输出汇总计数，不暴露文件名、路径、哈希或命中身份，也不把
任何 oracle 信息交给 selector。缺失任意一张时，本轮 overlap 验收无效，必须先重建非破坏性的候选
视图。

生成 receipt 不等于导出。普通用户导出仍需冻结目标和名单、返回一次性确认码，并在新消息中精确
确认；之后只复制，不移动、不删除、不改名、不覆盖。

---

## 风景算法机制：已有能力与待补闭环

风景不是“没有人物的人像”。现有插件已经使用一套独立风景提示词，从五个维度评价匿名照片：

| 维度 | 当前观察内容 |
|---|---|
| 瞬间 | 光线、天气、人流、云层或水面是否处于这个场景更好的时机 |
| 构图 | 取景、水平、透视以及前中后景层次 |
| 主体 | 画面有没有明确视觉重心 |
| 光线 | 整体影调、动态范围以及死黑、死白问题 |
| 叙事 | 地点、季节和氛围是否清楚、独特 |

五维当前等权汇总，总分仍由本地计算，而不是直接相信模型给出的总分。

### 当前可以怎样运行风景任务

1. `analyze_folder` 在本机识别风景候选和视觉相似组；
2. `inspect` 用 512px low 预览评分全体或指定候选；
3. 入选边界可以用 1536px high 重新查看；
4. 同场景的 2–4 张照片可以用 `compare` 直接比较；
5. `resolve_family` 冻结旧版相似组代表；
6. `propose` 校验每张都看过、没有未解决的 family 冲突，并精确达到 scenery target；
7. 用户确认后才允许复制导出。

这个流程能够完成基础风景精选，但“主 Agent 自己挑了一份名单”还不能证明那是整批里最好的风景。

### 风景仍需补齐的 Agent 能力

要让风景达到与人像相同的产品承诺，不能简单复制人像 prompt，而应新增独立且版本化的风景闭环：

1. **风景 baseline rubric**：冻结技术可读性、构图空间、光色天气、决定性时机、地点叙事和完成度，
   并建立只适用于风景的资格与模糊意图规则。
2. **完整风景池评估**：所有风景候选都获得同一 low baseline，相似组不能提前替整组淘汰成员。
3. **风景 high 预算**：针对高分、同机位不同光线和入选切线冻结 hard cap，不允许整池临时升级 high。
4. **风景 AB/BA**：交换两张照片顺序，重点比较光线时机、空间层次、天气、人流和画面完成度；不能
   沿用“先看人脸”的旧 compare prompt。
5. **全局聚合与有界多样性**：使用 baseline 锚定的 Bradley–Terry；只在质量前沿内增加场景类型、
   视角、焦段感、时间、天气和色调的集合多样性。
6. **独立风景 evaluator**：重新 high 评入选项、low 覆盖落选项、随机抽样并寻找更强挑战者。
7. **混合任务合并门禁**：分别冻结 `portraitDraft` 与 `sceneryDraft`，分别 audit PASS 后才能合并成
   人物 K1 + 风景 K2 的最终 proposal 和 receipt。
8. **风景偏好**：支持宏大、极简、纪实、氛围、地标、自然或城市等有界偏好，仍不能救回弱片。

在这些机制完成并用独立风景人工精选集验收之前，README 只能把风景描述为“已有基础精选能力”，
不能与已进入 v3 验收的人像能力写成完全对称。

---

## 用户偏好：人像已结构化，风景仍待补齐

人像任务不输入偏好时使用统一默认标准，也可以直接用自然语言描述想要的照片：

> 我喜欢自然、不看镜头的瞬间，多保留一些能看出旅行地点的环境人像。

> 每一段连拍最多留一张，不要出现太多相同姿势。

> 这是一组动作过程，我希望同一组可以连续保留几张。

偏好会被转换成有限的结构化参数，只在质量合格且足够接近的照片之间调整顺序：

- 表情：自然、开心、严肃、抓拍、戏剧性；
- 视线：看镜头、看向画外、互动、沉思；
- 景别：特写、半身、全身、环境人像；
- 光线与氛围；
- 单图质量维度的相对重视程度；
- 集合多样性强度；
- 同一视觉相似组保留一张、均衡保留或允许系列。

偏好不是另写一套评分标准：默认 baseline 始终保留，用户偏好最多让单张移动 ±4 分，多样性最多
再影响 4 分，而且不能让资格不合格或明显更弱的照片进入名单。

风景当前可以通过 `compare` 的问题临时表达“更看重光线还是构图”等意图，但还没有与人像等价的
结构化、可缓存、可审计偏好 profile。未来应支持例如：

> 更喜欢有戏剧性天气和尺度感的风景，但不要为此牺牲构图完整性。

> 多保留不同地点和不同时段，减少同一机位的重复画面。

这些风景偏好也必须使用有限调整预算，并在 receipt 中记录，不能成为绕过 baseline 的自由 prompt。

---

## 可选锚点：让“最好”从通用标准收敛到你的审美

通用 rubric 能排除明显失败并形成一致的质量基线，但“哪一张脸型更自然”“什么样的眼神更有精神”
往往具有明显的个人差异。PhotoFilterAgent 的候选方案不是把某个人的审美写死进默认 prompt，而是把
评价拆成三层：

1. **通用 baseline**：没有个人输入时使用，对技术可读性、人物瞬间、构图、光色、环境和完成度做
   可复现判断；
2. **个人文本 profile**：通过少量 A/B/都淘汰问答，把用户稳定表达的门槛沉淀成版本化规则；
3. **视觉锚点**：只选 6–8 组最能表达边界的真实图片范例，让视觉模型在难以用文字完整描述的
   眼神、五官、脸型和姿态上校准。

完整问答集和运行时锚点不是同一件事。以当前个人实验为例，用户完成了 30 条判断，其中包含 2 组
用于一致性复测的重复题，因此共有 28 个唯一 pair、56 张不同照片。这 30 条全部保留为离线金标准，
用于检查规则覆盖和结果稳定性；运行时只从中冻结 7 组代表性边界、14 张照片。这样既能保持人脸
可读，也不会在每一次 high / AB/BA 调用中重复发送 56 张无关范例。若 A/B/C 证明 7 组覆盖不足，
再按实际错误类型增量补锚点，而不是未经验证就把完整题库塞进每次请求。

这不是训练或微调模型。文本规则和匿名参考图只在本轮视觉请求中作为受限上下文，照片不会被发布到
公网；视觉调用仍只走用户当前 DSH 会话选择的 provider/model。

视觉锚点不会加入全池 low。原因有两个：第一，给数百张候选重复附带范例会显著增加成本；第二，
单一人物、单一场景的范例容易让初筛过严。它只进入 high 与 AB/BA：

```text
全池 low：通用或个人文本 Rubric
    ↓
切线 high：文本 Rubric + 可选视觉锚点
    ↓
AB/BA：同一合同，交换 FIRST / SECOND 后再判断
```

### 为什么必须做 A/B/C，而不是直接上线锚点

候选版本预注册三组完全相同的数据、模型、预算和随机种子：

| 组别 | low | high / AB/BA | 回答的问题 |
|---|---|---|---|
| A | 旧冻结基线 | 旧冻结基线 | 改造前表现如何 |
| B | 新文本 Rubric | 新文本 Rubric | 分层文字规则是否带来增益 |
| C | 与 B 字节级相同 | 文本 + 视觉锚点 | 图片范例是否提供额外增益 |

B/C 的 low 只有在请求合同逐字节相同时才可共享缓存；C 的 high、pairwise、selector 与 independent
evaluator 都必须绑定视觉包、布局和 QA 收据哈希，不能借用 B 的结果。正式验收还要求视觉锚点与
候选/人工盲测集没有任何精确图片重合，否则 C 只能算 in-sample 诊断，不能作为准确率结论。
当前 14 张运行时锚点与冻结的 309 张候选已完成原图内容哈希预检，精确重合为 0；预检不打开图片，
也不读取 oracle。

当前 Harness 每条消息最多两张图。C 因此采用“锚点参考图版 + 目标图”的版本化协议；pairwise 的
第二张是带 FIRST/SECOND 标签的双候选图版。参考图版只有在 14 张范例全部出现、13 张关键人脸都
带显式放大区域、独立视觉复核逐格确认可读、标签清楚、保持比例、去元数据且不含路径/文件名后，
才会生成不可变 PASS 收据。图版像素、布局或收据任一变化都会使缓存失效。

实际候选不能依赖本机人脸检测“碰巧可用”。B/C 的每个 high 结果还必须在同一次视觉调用中返回并
冻结主人物头脸 focus；C pairwise 用两个冻结 focus 生成放大图。双候选收据绑定 FIRST/SECOND 匿名
顺序、两张 high JPEG、两个 focus、2/2 inset、图版像素和去元数据报告。focus 缺失、越界、错序或
图版未出现两个人脸放大区时均在发送前停止，不能回退到无放大图版。

这套锚点实验目前已经完成 Rubric、匿名视觉包、阶段级缓存身份、不可变实验 manifest、新 B/C 视觉
客户端、真实参考图版本地渲染和真实双候选图版 2/2 focus inset 验证。4096×4096 参考图版的精确
像素已由隔离复核者逐格通过：14/14 资产、13/13 关键人脸、标签、顺序、比例、同源对应与隐私门禁
均为 PASS，并已生成同时绑定本地渲染证据和隔离视觉证据的 v2 收据。DSH A/B/C 付费运行和隔离
overlap 仍未完成，因此它仍是候选实验，不是当前默认能力，也不能宣称已经提高准确率。

第一次真实 A 组运行使用旧的 `dsh-llm-tool-call-v1`：模型在首个图片评分请求中没有调用复杂的嵌套
评分工具，系统以 `STRUCTURED_OUTPUT_UNSUPPORTED` 阻止，未落入任何有效评分、未解析模型文本、
未 fallback，也没有继续启动 B/C。该结果证明旧传输合同不适配当前所选路由，不证明评分 Rubric
本身好坏。随后 v2 在真实 DSH 通过 A 的两类无图合同预检，但首张图片返回
`INVALID_TOOL_ENVELOPE`，有效评分为 0，B/C 未启动。旧错误未区分外层解析与内层解析，不能据此
断言具体失效层。v3 去除二次 JSON 转义，但无图预检暴露了 failureCodes、evidence 和 observableTags
中的空数组类型不匹配。v4 将完整字段类型同时放回工具 schema，保留对象返回和不含 provider 内容的
错误阶段诊断。真实 DSH A 组前 10 张评分成功，第 11 张因信封字段不匹配停止，尚未完成首批 16 张。
因此只证明部分请求能够工作，不证明协议已稳定。协议变化会使旧缓存/状态失效，未知付费操作不能自动重新购买。

### Codex 独立实验身份

为避免与其他人或其他思路开发的 Agent 混在一起，这条候选线使用完全独立的运行身份：

| 表面 | 固定身份 |
|---|---|
| DSH 中显示名 | `Photo Curator Anchor Lab (Codex)` |
| preset / 技术 ID | `photo-anchor-lab-codex-v1` |
| package | `@photo-filter-agent/dsh-photo-anchor-lab-codex-v1` |
| 工具前缀 | `anchor_lab_codex_*` |
| 独立 DSH_HOME | `~/.dsh-anchor-lab-codex-v1` |
| 本地端口 | `3082` |

它不会覆盖标准 `Photo Curator`、Claude 的实验 preset 或 3080 服务，也不会共享 Swift build、运行源码
快照、状态目录和收据目录。安装时源码与分析引擎会各自冻结为内容快照；同一个状态 namespace 还会
绑定首次创建它的 DSH 父会话，并在每次 checkpoint 写入时做跨进程锁和内容版本校验。这个验收
preset 故意不注册导出工具。

---

## 隐私、费用与失败恢复

### 原图安全

- 原照片只读，不会被评分流程修改；
- 发送给视觉模型的是 512px 或 1536px 的匿名衍生 JPEG；
- 预览保持原始比例，并移除 EXIF、GPS、文件名和其他元数据；
- 主 Agent 只接收匿名 ID 和结构化结果，图片像素不进入主对话历史；
- 导出需要单独确认，只复制，不移动、不删除、不覆盖。

### 费用可见

- 全池先用 512px 预览完成统一评估；
- high 和 AB/BA 执行前先生成冻结预算；
- 计划会区分已缓存、需要调用和最大调用上限；
- 实际价格由用户当前选择的模型供应商决定，项目不会用历史平均值冒充本轮账单。

### 可以从中断处继续

- high 候选和 pairwise 计划在首个付费调用前持久化；
- 每个 AB、BA 方向分别缓存；
- 普通失败只补未完成项，不重跑已经成功的图片；
- 鉴权、额度、限流或模型能力错误会停止当前链路，不会静默切换另一个模型继续。

---

## 安装与第一次使用

PhotoFilterAgent 当前只支持 macOS，并作为 Photo Curator 插件运行在 DeepSeek Harness 中。

### 准备环境

| 依赖 | 要求 |
|---|---|
| macOS | 本地图像分析依赖 Apple Vision / ImageIO |
| Xcode Command Line Tools | `swift --version` 可运行 |
| Node.js | 22.19 或更高 |
| pnpm | 可运行 `pnpm --version` |
| DeepSeek Harness | 当前验收版本 `dsh-v0.1.0-rc.8` |
| 视觉模型 | 当前会话模型必须支持 image input 与 tool call / structured output |

### 安装插件

```bash
git clone https://github.com/tanweiping1012-source/PhotoFilterAgent.git
cd PhotoFilterAgent
PHOTO_FILTER_ALLOWED_ROOTS='/Users/you/Pictures' \
./install.sh /absolute/path/to/deepseek-harness
```

`PHOTO_FILTER_ALLOWED_ROOTS` 是插件能够访问的照片根目录。普通用户不需要配置人工精选或 oracle。

如果你在做离线验收，并且测试集内存在人工精选子目录，必须在安装时显式排除：

```bash
PHOTO_FILTER_ALLOWED_ROOTS='/absolute/path/to/test-photos' \
PHOTO_FILTER_EXCLUDED_RELATIVE_PATHS='relative/path/to/human-pick' \
./install.sh /absolute/path/to/deepseek-harness
```

插件不会自行猜测名为 `pick` 的目录；排除规则会在枚举、fingerprint 和匿名 ID 产生之前生效。

### 启动 DSH Web

```bash
cd /absolute/path/to/deepseek-harness
pnpm dsh --profile web
```

浏览器打开 `http://127.0.0.1:3080`：

1. 新建会话；
2. 选择 **Photo Curator**；
3. 选择一个支持图片和结构化工具调用的 provider/model；
4. 输入照片目录、目标数量和可选偏好。

当前建议把人物与风景拆成两个任务。人像任务可以直接复制：

> 请从 `/absolute/path/to/photos` 的人物照片中选出最好的 20 张。没有额外审美偏好，使用默认标准；
> 同一视觉相似组均衡保留。先显示付费计划，完成独立复核后给我看名单，暂时不要导出。

风景基础精选可以使用：

> 请只处理 `/absolute/path/to/photos` 中的风景照片，目标 10 张。先完成 low 评分，再针对同场景照片
> 比较光线时机、构图层次和氛围；给我看候选与理由，暂时不要导出。请明确说明这不是 v3 独立审计结果。

不要在当前版本要求一次会话同时完成“最好人像 K1 + 最好风景 K2”：人物 v3 门禁与旧风景流程尚未
完成合并，这种混合任务目前不能生成可信的统一 proposal。

首张图片发送前会运行模型能力预检。如果当前模型不支持图片或结构化工具，任务会明确停止；请在
DSH 会话里选择合适模型后重新开始，不需要也不应该修改 PhotoFilterAgent 去固定某个供应商。

### 只安装 Codex 锚点实验（开发验收）

普通用户不需要这一步。要并行验证 A/B/C 且不影响已有 DSH 时，显式提供本地锚点包、参考图版及其
两份收据，再运行独立安装器：

```bash
PHOTO_ANCHOR_LAB_CODEX_DSH_HOME="$HOME/.dsh-anchor-lab-codex-v1" \
PHOTO_ANCHOR_LAB_CODEX_ALLOWED_ROOTS='/absolute/path/to/test-photos' \
PHOTO_ANCHOR_LAB_CODEX_EXCLUDED_RELATIVE_PATHS='relative/path/to/human-pick' \
PHOTO_ANCHOR_LAB_CODEX_ANCHOR_PACK_PATH='/absolute/path/to/anchor-pack.json' \
PHOTO_ANCHOR_LAB_CODEX_REFERENCE_SHEET_PATH='/absolute/path/to/reference-sheet.jpg' \
PHOTO_ANCHOR_LAB_CODEX_REFERENCE_SHEET_RECEIPT_PATH='/absolute/path/to/reference-sheet-receipt.json' \
PHOTO_ANCHOR_LAB_CODEX_ANCHOR_OVERLAP_RECEIPT_PATH='/absolute/path/to/anchor-overlap-receipt.json' \
bash scripts/install-anchor-lab-codex-v1.sh /absolute/path/to/deepseek-harness
```

在这个独立 DSH_HOME 中单独配置供应商凭据与会话模型，然后启动：

```bash
cd /absolute/path/to/deepseek-harness
DSH_TELEMETRY_DISABLED=1 \
DSH_HOME="$HOME/.dsh-anchor-lab-codex-v1" \
pnpm dsh --profile web --port 3082 --no-open
```

浏览器打开 `http://127.0.0.1:3082`，新建会话并选择 **Photo Curator Anchor Lab (Codex)**。A/B/C
必须使用同一候选快照、exact-K、seed、预算和当前会话 provider/model；任何一项变化都创建新身份，
不能复用旧结果。人工 pick 在三组都获得 exact-K 与终态独立审计之前保持不可见。

---

## 当前能力与限制

- 当前同时具备人物/风景本地分类与基础视觉评分，但完整 v3“选最好”闭环只实现并正在验收人像。
- 风景仍使用旧版 `inspect / compare / resolve_family`；没有独立风景 audit，不能把结果称为已验证的
  “整批最佳风景”。
- 新版人物 flow 要求 `scenery_target=0`，人物+风景混合 exact-K proposal 尚未打通。
- 视觉相似 family 来自感知哈希、亮度和时间，不等同于相机 Burst 元数据，长场景可能被归成大组。
- AB/BA 只用于高分 family 和入选切线，是局部纠偏，不是全池两两锦标赛。
- 集合多样性依赖模型生成的离散标签，不是图像 embedding，对细腻审美差异仍较粗。
- 视觉调用成本和速度取决于用户当前选择的模型；项目只能约束调用范围，不能承诺固定价格。
- DeepSeek Harness 仍处于开发者预览阶段；升级 Harness 版本后需要重新适配和验收。

详细评分标准见 [旅行人像 baseline rubric](docs/qa/TRAVEL_PORTRAIT_BASELINE_RUBRIC.md)，流程规范见
[人物选择规范](docs/PORTRAIT_SELECTION_SPEC.md)。真实质量指标只应引用完整的独立 QA 报告，不能用
本地技术指标或某次未完成运行替代。

---

## 开发验收状态（候选稿）

<details>
<summary>查看当前未发布的真实运行证据、剩余问题和发布门槛</summary>

以下是人像候选版本的本地证据，不是风景结果，也不是已发布结论：

- 完整 309 张会话已经完成 selector baseline/high、旧版 AB/BA、独立 evaluator 全池审计和 exact-20
  overlap。审计最终为有效 `FAIL`，存在更强挑战者；人工精选重合为 `3/20 = 15%`，Jaccard 约
  `8.11%`，远低于 90% 门槛。因此旧算法已被明确判定为不合格，不能生成 PASS receipt 或发布。
- 旧 checkpoint 中有 165 个 selector directional legs、82 组完整 AB/BA。模型声明的 winner 与六维
  加权方向只在 `72/165 = 43.6%` legs 一致；82 组中只有 6 组的归一化 margin 同号，最终 82 组全部
  聚合为无方向 TIE。旧结果实际主要由绝对分数与 family/diversity 决定，没有得到有效相对排序证据。
- pairwise v2 已删除 provider 总 winner 字段，由本地从六维 delta 唯一计算方向；pairwise planner 已
  改为 audit 优先、family 有界、切线连通 ladder。prompt hash 与算法版本变化会使旧双图 cache 失效，
  但 309 张单图 audit baseline cache 保持可复用。
- 本地 Q-ReAlign Mini 0.8B 只作为尚未进入生产的候选召回实验。在不读取 oracle 的固定样本上，MPS
  `30×3` 重复评分最大漂移为 0、Top-20 自重合为 20/20，30 张分数均不同；但 K=20 切线 margin 只有
  `0.00396`，稳定不代表准确，所以它不能直接决定最终 Top-20，也尚未通过人工精选信号检验。
- Q-ReAlign MPS 实测 30×3 的本地分析约 28.8 秒、模型加载约 15.2 秒、每次评分约 8.1 秒；CPU 小样
  每次约 77.6 秒。CPU/MPS 数值不共用 cache，设备能力在扫描照片前预检，不支持时明确阻止且不 fallback。
- receipt 已升级为 v2，绑定偏好、selector 路由、baseline/pairwise prompt、排序与预算策略、本地门禁、
  exact-K 内容集合和匿名顺序。任何决策输入变化都会使旧 selection hash 与授权失效。
- 当前离线回归覆盖新 pairwise 结构、connected cutline ladder、receipt v2、审计停滞保护、错误账本、
  数据集/oracle 隔离、Q-ReAlign 实验边界，以及锚点 A/B/C 合同、参考图版 QA 和新 B/C 视觉客户端；
  当前 Agent 完整回归为 232/232，Swift 引擎回归为 31/31，Codex 独立 preset scaffold 与 DSH rc.8
  真实 package import 为 6/6。
- 真实本地图版已经生成：参考图版为 4096×4096、14/14 资产、13/13 显式 focus、无 APP1/APP13/COM；
  双候选图版为 3072×1536、FIRST/SECOND 两侧 2/2 focus inset。两类收据都绑定实际 JPEG、顺序和
  渲染证据，旧的自报哈希/布尔值接口会 fail-closed。参考图版精确哈希
  `79a6d998…991eaf0` 已获得隔离逐格 PASS，最终质量收据为 `f2600da1…342d81f`。

因此目前可以确认“旧版为什么失败已经被证据定位，新版修复已通过离线回归，候选召回实验具备重复
稳定性”；仍不能确认新版已经选对最好的 20 张。下一步必须在 DSH 真实链路中用冻结的新 prompt 和
planner 重建 exact-20，再完成独立审计与一次锁定 overlap。

此外，v1 和 v2 均在 A 组首张真实图片上阻断，v2 的无图预检通过并不代表带图输出可靠。
当前 v4 使用完整类型的对象信封并增加隐私安全诊断；真实图片批次为 11 次尝试、10 次成功，
第 11 次 `INVALID_TOOL_ENVELOPE` 阻断，仍未闭环。工作区另已实现收到明确格式拒绝后的有限恢复：
按原 cacheKey 记录 failed，跨 turn 最多两次总尝试，超过上限停止；真正未知的网络结果仍保留 reserved。
恢复和重载测试通过，但此追加修复尚未安装到运行中的冻结快照。旧 reserved 不能直接推定为可重试。

### 已知仍需闭环的工程问题

1. audit 账本已改为持久化 `attempted/succeeded/failed/unresolved`，调用前先写 checkpoint，并以当前
   冻结计划内的唯一 score / pair-leg cache identity 报告 `unique_cached_assets`；恢复测试确认不会再
   把同一缓存重复累计。旧 checkpoint 只保存了成功次数，首次恢复会明确标记
   `accounting=legacy_success_lower_bound`，不会伪造未知的历史失败；最终验收仍需用 DSH session/网络
   轨迹补充核对旧阶段。
2. PhotoFilterAgent 在收到 provider 的 401/403/429 后会打开 circuit breaker；但错误返回插件之前，
   旧 DSH 主 Agent/adapter 曾对一次确定性 2056 自动尝试 5 次。插件无法在工具尚未被调用时拦截。
   本机 Harness 已把 MiniMax 中文 Token Plan 耗尽识别为 terminal `QUOTA`，真实验证只有一次请求。
   正式发布仍需确保用户所依赖的 Harness 版本包含等价修复，并在最终网络轨迹中复核。
3. family 仍来自 pHash、亮度和时间阈值，可能把很长的一段同场景照片归为一个大组；它不是相机
   Burst/拍摄序列的真实语义边界。当前“全池 baseline + family challengers + 最多两张”的设计已经
   避免整组被一个代表淘汰，但更精细的序列切分仍是后续质量优化节点。
4. `dsh-llm-typed-envelope-v4` 只通过前 10 张真实评分，尚未稳定完成批次；pairwise v2 和 connected
   ladder 也未完成真实验收；
   本地单元测试只能证明完整合同预检、nonce/JSON 解码、方向计算、缓存失效和图结构正确，不能替代
   真实图片评分、AB/BA 一致率与最终 overlap。真实运行若仍返回纯文本或错误工具结构，必须继续
   fail-closed，不能降低验证标准来“跑通”。
5. Q-ReAlign 当前只通过稳定性门槛，尚未证明与“最好照片”或人工 pick 有信号；在信号检验完成前，
   不能把它接入生产 Top-K，也不能把它的分数写入正式产品宣传。
6. 个人锚点方案已完成真实参考图版的本地结构验证、隔离逐格视觉 QA PASS 和双候选 2/2 人脸放大
   验证，且锚点与 309 张候选的原图内容重合为 0；但仍没有完成 DSH A/B/C 与隔离 oracle overlap。
   当前生产路径仍是 A 组旧客户端；B/C 不会通过
   配置开关悄悄替换默认规则。

---

## 新版冻结后的唯一闭环顺序

1. 重新安装内容寻址的 Codex runtime snapshot，重启 3082 并确认 DSH Web 已加载最新
   `Photo Curator Anchor Lab (Codex)`；旧 v1/v2 会话只保留为失败证据，不能恢复或重试其 unknown
   operation。
2. 不联网的数据集预检必须得到 309 候选、20 oracle、20/20 内容覆盖、K=20 对齐和 `valid=true`。
   这一步已经实测通过，重复运行仍不得向 selector 输出内容身份。
3. 为 A/B/C 分别创建新的父会话，三组共用新的 v4 seed，使用当前 DSH 会话实际选择的同一 provider/model；先让
   A 完成 2 个无图合同探针，B/C 各完成 3 个无图合同探针，再分别运行一次
   `analyze_folder`：people target=20、scenery target=0、people_only、无 limit。确认 fingerprint 不漂移，
   仅复用同协议、同完整身份的 baseline cache；旧协议结果不能复用于 v4。禁止插件固定或 fallback 到另一个模型。
4. 使用 pairwise v2 prompt 与 connected ladder 重建 selector exact-20。每个 high 结果同时冻结主人物
   头脸 focus；pairwise 只能使用与 FIRST/SECOND 高分辨率预览和两个 focus 同时绑定的 2/2 inset 图版。
   只补因 prompt/算法身份变化而失效的 high/pairwise 资产，不重新支付仍有效的 baseline；记录新
   selection hash 和 AB/BA 有效胜率。
5. 使用新 draft 的五项冻结输入只调用一次 `independent_evaluator`；单图 baseline cache 继续复用，
   只补新 audit 上下文真正 missing 的资产。遇到
   401/403/429、quota 或 circuit breaker 立即停止外层续跑，且 Harness adapter 的确定性错误重试
   必须纳入最终网络轨迹与修复验证。
6. 如果得到有效 PASS，调用 `propose` 生成 exact-20 receipt v2，不导出照片。
7. 如果得到有效 FAIL，只依据 evaluator 反例重建 selector 名单并重新 audit；此时仍不能读取 oracle。
8. Receipt 生成后，启动另一个隔离评估 Agent/进程读取人工 pick，计算重合指标。`pass_90` 必须为真；
   若低于 90%，如实报告，不能用 oracle 反向调参伪造通过。
9. 完成安全、缓存、模型路由和网络端点复核：全链路只能出现当前会话所选 provider endpoint，不能
   出现隐藏 fallback。
10. 核对 audit 新增 attempted/succeeded/failed/unresolved 与唯一缓存统计；对旧阶段，
   用 DSH session/网络轨迹补足 checkpoint 无法重建的历史失败数，不得把 lower bound 写成精确总量。
11. 通过全部验收后，才把本候选稿中得到实证的内容同步到正式 `README.md`、规范、QA 记录和必要
   代码/测试；删除或改写正式 README 中与当前 v3 冲突的旧营销表述。
12. 按用户最新要求，可先将原本实现提交到 Codex 独立分支并创建 draft PR，明确未完成的实验。
    PR 不合并 main；继续独立 A/B/C 实验并更新实测结果，最终由用户对比决定是否合并。
    所有提交仍须排除照片、oracle、凭据、本机私有路径和运行缓存。

---

## 正式发布门槛

- [ ] 最新 DSH/Photo Curator preset 已真实加载。
- [ ] 全链路实际 provider/model 与当前会话一致。
- [ ] A 的 2 类、B/C 的 3 类无图完整合同预检 PASS，且无 fallback endpoint。
- [x] 真实参考图版本地结构门禁通过，14/14 资产、13/13 focus、无隐私 JPEG 段。
- [x] exact 当前参考图版由隔离复核者逐格确认并生成 PASS 收据。
- [x] 真实双候选图版已验证 FIRST/SECOND 2/2 focus inset 与 v2 来源回执。
- [x] 309 候选 / 20 oracle 的本地数据集预检有效，oracle 内容覆盖 20/20，K=20 对齐。
- [ ] 全池 baseline 完整覆盖。
- [ ] selector high 和 AB/BA 冻结计划完整完成。
- [ ] exact-K draft 的 selection hash 稳定。
- [ ] independent evaluator 完整覆盖并给出有效 PASS。
- [ ] `propose` 生成可验证 receipt，未调用 export。
- [ ] oracle 只在 receipt 后读取。
- [ ] 与人工 pick 的验收指标达到约定的 90% 门槛。
- [ ] 原照片没有被移动、删除、覆盖或修改。
- [ ] audit attempted/succeeded/failed 和唯一缓存统计与真实调用轨迹一致。
- [x] 当前离线实现的 Agent 232/232、Swift 31/31、独立 preset/DSH package import 6/6 回归通过。
- [ ] 真实 DSH 验收完成后，文档中的数字与最终 receipt/audit 一致。
- [ ] 待发布 diff 不含照片、凭据、用户路径、oracle 内容或缓存。
- [ ] 正式 README、spec、QA 记录和实现保持一致。

在这些条件全部满足之前，本文件保持候选状态，正式 README 和 GitHub 发布都不应把方案描述为
“已经验证无问题”。

</details>

---

## 版本演进

### 阶段一：本地技术筛选

最初版本依靠 Apple Vision、清晰度、曝光、人脸质量和感知哈希完成快速分类与坏片提示。它能在
本机低成本处理大量照片，但技术指标只能判断“能不能用”，无法代表人的审美选择。

### 阶段二：可以调用视觉模型的自动选片流程

第二阶段加入 low/high 视觉评分、相似组比较、缓存和导出，让产品第一次能够根据图片内容给出
名单。不过它仍然容易过早折叠连拍，并且主要目标是排除问题照片，没有独立证据证明最终选到的是
整批中最好的照片。

### 阶段三：先完成“最好人像”闭环

当前候选版本把所有人物候选重新纳入统一 baseline，并加入：

- 有硬预算的 high 决赛圈；
- AB/BA 双向盲比较；
- baseline 锚定的 Bradley-Terry 聚合；
- 有质量边界的用户偏好和集合多样性；
- 与 selector 隔离的 independent evaluator；
- receipt 之后才允许进行的人工标准集验收；
- provider/model 一致性、checkpoint、恢复和 fail-closed 安全边界。

这一阶段只有在真实 DSH 链路完成独立审计、人工精选指标和安全复核后，才会同步到正式 README 并
作为已验证版本发布。

### 阶段四：让风景与混合任务达到同一标准

下一阶段不是简单在 README 加上“支持风景”，而是补齐版本化风景 rubric、完整风景池、high 预算、
风景 AB/BA、全局聚合、有界多样性、独立风景 evaluator，以及人物/风景双 draft 合并门禁。完成后，
用户才能在同一个任务中可信地要求“人物保留 K1 张、风景保留 K2 张”，并对两个类别分别说明为什么
它们是整批中最值得保留的照片。
