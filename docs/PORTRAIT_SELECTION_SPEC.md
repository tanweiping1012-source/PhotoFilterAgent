# 人像精选 Agent 产品与流程规格

状态：当前流程 v3  
适用范围：从一批包含人物的照片中，选出质量最高且符合用户偏好的恰好 K 张照片。

## 1. 产品目标与原则

系统要解决的不是“排除明显坏片”，而是在同一拍摄批次中识别相对更好的瞬间，并给出可复现、可审计的精选结果。

核心原则：

1. **质量与偏好分离**：每张照片先按固定 baseline 评估，再叠加有界的用户偏好。没有偏好输入时，结果只由 baseline、成组比较和多样性规则决定。
2. **先质量、后多样性**：多样性只能在质量前沿内打破近似平局，不能用题材不同掩盖明显的质量差距。
3. **系列内相对比较**：连拍和相似构图的绝对分往往很接近；切线附近必须用成对比较确定更好的瞬间。
4. **选择与审计隔离**：审计者只获得冻结 rubric、匿名候选和待审集合，不得获得选择理由、排序日志或用户 oracle。
5. **精确交付**：正常完成时必须选出恰好 K 张。候选不足时应显式失败或请求用户调整 K，不能静默少选。
6. **隐私和可恢复性优先**：原图只读；远程模型只接收匿名缩略图；任何发布和导出都需要明确确认；昂贵步骤可断点续跑且不会重复计费。

## 2. 评分、偏好与最终效用

baseline 使用《旅行人像 Baseline 评分 Rubric》规定的六个维度和权重：

| 维度 | 权重 |
| --- | ---: |
| 技术质量与主体可辨识度 | 18 |
| 人物瞬间与情绪 | 22 |
| 构图与视觉层级 | 18 |
| 光线、色彩与影调 | 16 |
| 旅行环境与叙事 | 16 |
| 意图感与完成度 | 10 |

baseline 总分为各维度 0–100 分的加权和，归一到 0–100。硬门槛仅限：无法评估、没有有意拍摄的人物、主要人物不可辨识、灾难性拍摄失败。闭眼、背影、剪影、运动模糊或非常规构图都不是自动硬淘汰；它们应根据是否符合画面意图影响相应维度。

用户偏好必须表示为结构化 profile，不允许直接覆盖 baseline prompt。偏好调整 `preference_delta` 对单图限定在 `[-4, +4]`，默认 `max_quality_tradeoff=8`：偏好不能让 baseline 比另一个候选低 8 分以上的照片取代后者。当前 `set_preferences` 接受：

```json
{
  "expression": ["natural", "joyful"],
  "gaze": ["camera"],
  "framing": ["half_body", "environmental"],
  "lighting": ["soft", "natural"],
  "mood": ["warm", "documentary"],
  "dimension_focus": ["human_moment"],
  "diversity": 0.8,
  "series_retention": "balanced|one_per_family|allow_series",
  "max_quality_tradeoff": 8
}
```

省略全部字段表示通用 baseline。`diversity` 省略时继承 balanced baseline 强度 1；显式 `0`
才关闭，显式 0–1 都记录为用户偏好。`series_retention` 默认 `balanced`，由排序器自动求能满足
exact-K 的最小 family cap；另外两种分别映射 cap=1 与 unlimited。受保护属性不得成为偏好
条件。最终排序效用由 baseline、成对比较校正和有界偏好共同构成。多样性加成只能用于
baseline/校正效用相差不超过 4 分的质量前沿，单图最多 `+4`。

## 3. 端到端状态机

```text
NEW
  -> ANALYZED
  -> PREFERENCES_LOCKED
  -> BASELINE_LOW_COMPLETE
  -> BUILD_PLAN_FROZEN
  -> BUILD_RUN_COMPLETE
  -> DRAFT_EXACT_K
  -> INDEPENDENT_AUDIT_V3_PASS
  -> PROPOSED
  -> EXPORT_APPROVAL_PENDING
  -> EXPORTED

普通调用预算耗尽/可恢复中断 -> PAUSED_RETRYABLE（只能在后续新 turn 只补 remaining）
401/403/429、鉴权、额度或模型能力失败 -> BLOCKED_MODEL_ROUTE（当前 turn 禁止自动重试）
数据集指纹变化 -> STALE（旧评分不可复用）
偏好变化 -> 旧 draft/audit/proposal 失效；身份匹配的 baseline 缓存不重算
```

状态必须绑定：会话 ID、数据集指纹、rubric 版本、实际 Harness `provider + model + reasoning effort + protocol`、rubric/prompt hash、偏好版本、目标 K。每个远程评分请求以 `dataset_fingerprint + anonymous_photo_id + role/detail + route_identity + rubric_prompt_hash` 作为幂等键；交换顺序的 pairwise 请求还需包含顺序位。任一模型路由、协议或 rubric/prompt 变化都使旧评分、草案和审计失败关闭。checkpoint 至少记录成功项、失败项、重试次数、费用/调用数、冻结候选、审计种子和审计结论。恢复时只提交剩余任务，不允许整批重算造成重复计费。

## 4. 工具契约

推荐最小工具集：

| 工具 | 输入 | 关键输出/约束 |
| --- | --- | --- |
| `analyze_folder` | 只读目录、K | 匿名候选、相似族、数据集指纹；不得修改原图 |
| `set_preferences` | 结构化 profile | 规范化后的偏好和上限；不接受自由 prompt 注入 |
| `evaluate_pool` | `detail=low` | 完整人物池 baseline（包括旧视图折叠成员）；失败重试只补 missing，禁止整池 high |
| `build_selection` | `mode=plan|run`、K | plan 冻结 high/pairwise hard cap；run 按同一计划精排并输出 exact-K draft |
| custom `independent_evaluator` | folder、candidate_scope、selected_ids、target、seed | 只接受这五项；从父会话最新 request header 冻结 provider/model/reasoning，新建隔离子 Agent；不得携带 selector 理由、分数、排名或偏好；每个主 turn 最多一次 |
| `audit_selection` | 同上五项 | 仅允许 independent evaluator 调用且每个 child 恰好一次；执行 staged audit v3，普通 INCOMPLETE 在后续 turn 只补 remaining；路由熔断返回 BLOCKED |
| `propose` | 冻结 exact-K 名单 | 仅在同一 selection hash 已获得 audit v3 PASS 后接受 |
| `export_selection` | 目标目录；第二次传确认码 | 第一次只冻结并发码；必须收到发码后真实用户的新消息才复制，确认码一次性消费 |
| `status` | 无 | 状态、剩余任务、调用计数、checkpoint、失败原因；费用预测以 build plan 为准 |

工具层应使用 allowlist；专用精选 preset 不应暴露 shell、通用文件系统、Web 搜索或公网发布工具。模型可见结果默认只返回匿名 ID 和必要证据，避免暴露本地绝对路径与原始文件名。

## 5. 排序与成对比较

先对所有合格候选做 baseline。照片按感知哈希、时间和构图相似度形成相似族；每族不能只由低成本本地规则直接指定胜者。

满足任一条件时触发 pairwise：

- 两张候选综合分差不超过 4；
- 任一候选处在第 K 名切线附近且置信度不足；
- 同一相似族中有多个候选可能进入结果；
- 独立审计提出未选挑战者。

每对必须分别以 A/B 和 B/A 顺序请求。只有两次结果方向一致、最终分差至少 5 且置信度至少 0.75 时，才视为稳定胜负；否则标记为不确定，并进入更多比较或高细节复评。多候选比较应使用可复现的锦标赛或 Bradley–Terry 类聚合，禁止由主 Agent 随意挑一个族代表。

`build_selection` 先得到质量前沿，再施加受限偏好和多样性规则，输出恰好 K 张及 cutline hard negatives。结果冻结后才允许进入审计。

相似族重复控制是独立于语义多样性加分的集合约束。baseline 先计算能够满足 exact-K 的最小统一 family cap `q`，使 `Σ min(family_size, q) >= K`；无 family 的照片视为单例。这样在 12 个有效相似族中选 20 张时默认 `q=2`，不会让某个高分场景无限占据名单；家族很少时 `q` 会自动放宽，仍保证 exact-K。用户明确要求“一族一张”或“保留连拍系列”时，可通过结构化 `seriesRetention` 分别使用 cap=1 或 unlimited；无法满足显式 cap 时必须报错，不得静默少选。

语义多样性仍只在四分质量前沿内生效，最多 `+4`，不与 family cap 混为一谈。完全重复帧仍应由更紧的重复检测只保留一张；粗粒度相似族允许在自适应 cap 内保留多个真正不同的瞬间。

## 6. 独立 blind audit

审计输入由系统构造，主 Agent 不得自行删减，也不得用 selector 的分数、资格、标签、排名或偏好决定审计者的挑战池：

1. 草案中的全部 K 张；
2. 与入选照片属于同一相似族的全部未选照片；
3. cutline 附近的 hard negatives；
4. 以固定种子对剩余候选做分层随机抽样，覆盖时间段、相似族、baseline 分段和置信度分段。

审计采用可恢复的 staged flow：先对全部入选项做 high 独立评分，再对其余候选做 low 独立评分，从而建立审计者自己的 eligibility、cutline、置信区间和分层；随后仅把低清分差不超过 4、置信区间与最弱入选项重叠、`needs_review`、各入选 family 的最强替代以及固定 seed 随机样本提升到 high。可能胜出的挑战者再做 AB/BA 顺序交换 pairwise。单次工具调用必须有 high/pairwise hard cap；健康路由上因单次预算尚未覆盖完时返回 `INCOMPLETE`，只能在父 Agent 的后续新 turn 从 checkpoint 继续。每个独立 child 恰好调用一次 `audit_selection`，禁止在 child 内循环或调用 `status`；只有覆盖完整后才允许 PASS/FAIL。

出现稳定胜出的挑战者时，草案退回 `PAIRWISE_RESOLVED`，替换后必须重新审计。普通取消或可恢复工具中断只表示 `INCOMPLETE`，绝不能伪装成质量 FAIL。401/403/429、鉴权、额度、模型能力或 provider route 失败必须返回 `BLOCKED + next_action=fix_model_route + circuit_breaker`：父子 Agent 在当前 turn 立即停止，不得再调用 evaluator、audit 或 status；同一失败 route 再次进入审计必须零 provider 调用。用户修复或切换当前会话模型后，新的 route identity 才允许继续剩余项。

随机抽样用于发现遗漏，**不能证明**未抽中的照片一定更差；因此同族和 cutline hard negatives 必须全量进入审计。审计报告需明确样本覆盖率、固定种子、发现的挑战者和剩余不确定性，不得声称“随机抽样已经证明全局最优”。

## 7. 隐私、成本与操作边界

- 原图全程只读；不得修改 EXIF、移动或删除源文件。
- 远程 VLM 会接收经过方向校正、尺寸限制、去 EXIF、文件名匿名化的缩略图。界面必须在首次调用前提示传输范围、供应商、预计调用量/费用，并允许取消。
- 主 Agent、baseline、high、AB/BA 与 independent evaluator 必须统一使用当前 DSH 会话实际选择的 provider/model/reasoning；首图前验证 image input、attachment 限制、结构化 tool-call 与路由凭据。不支持时失败关闭，禁止静默 fallback。
- 照片、缩略图、评分结果和 oracle 不得发布到公网，也不得写入公开仓库或遥测。日志不得包含绝对路径、原始文件名或图像数据。
- 导出是独立的、需要用户确认的动作；默认不覆盖已有文件。发布代码到 GitHub 也必须单独确认，且提交中不能包含测试照片、清单或 oracle。
- 支持全局停止、单项重试、断点恢复和调用预算；同一幂等键的成功调用不得再次收费。

## 8. 验收标准

### 功能与质量

1. 无偏好时使用冻结 baseline，修改偏好不会改写已存 baseline 分。
2. 任何成功运行都输出恰好 K 张；不足 K 时有明确错误。
3. 切线与同族竞争按 A/B 顺序交换执行，审计者与选择者隔离。
4. blind audit 覆盖全部同族未选项、全部 cutline hard negatives 和固定种子分层随机样本。
5. 相同数据集、rubric、模型配置、偏好和随机种子能够复现结果；中断恢复不会重复已成功调用。
6. evaluator 的模型输入只能有五个冻结字段；子 Agent 会话、prompt、rubric、缓存及 selector 可见状态彼此隔离，但路由与父会话当前 request header 完全一致。
7. 同一 provider/model 上触发 auth/quota circuit 后，重复进入审计的 provider 调用增量必须为 0；切换路由后旧 cache identity 必须失效。
8. selector 候选总数、fingerprint 与匿名 ID 中不含任何配置的 oracle 子树；无合法 audit PASS receipt 时，overlap evaluator 在读取 oracle metadata/内容前失败。

### 准确率

离线验收中的 `K` 必须在不读取 oracle 内容的验收契约中预先冻结。人工 pick 子树要通过显式相对路径配置，在候选扫描、dataset fingerprint 与匿名 ID 生成前排除。系统 exact-K 与 audit v3 PASS 后，`propose` 才生成内容寻址 receipt；receipt 绑定 dataset、scope、selection hash、匿名 ID/原图哈希 multiset、实际 route、rubric/prompt 和扫描排除策略。独立评测进程必须先完整验证 receipt，再确认 oracle realpath 恰好是其声明的排除子树，之后才可读取 oracle；不需要导出照片。Oracle 不得用于 prompt、权重、阈值、候选顺序、抽样或调参。报告：

- `Precision@K = |selection ∩ oracle| / K`
- `Recall@K = |selection ∩ oracle| / |oracle|`
- `F1 = 2PR / (P + R)`
- `Jaccard = |intersection| / |union|`
- `Exact overlap = |selection ∩ oracle| / K`，同时给出命中张数（如 `18/20`）

当 K 相等时 Precision、Recall 与 exact overlap 数值相同，但仍应完整报告以便跨数据集比较。目标 exact overlap 不低于 90%；若未达到，判定当前方法未通过，不能通过查看 oracle 后反向修改当次结果。改进必须在新的冻结版本和独立测试轮次中验证。

### 安全与交付

1. 原图哈希运行前后保持一致。
2. 网络日志仅出现当前会话所选 provider 端点；不得出现 MiniMax 或任何其他隐式 fallback；遥测和公网发布关闭。
3. 导出前有显式确认，取消后没有文件写入。
4. checkpoint 可从中断点继续，成功请求计数不增加。
