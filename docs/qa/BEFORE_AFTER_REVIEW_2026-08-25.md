# PhotoFilterAgent 昨日至今 Before / After Review（2026-08-25）

## 结论

项目已经从“能排除明显坏片并给出一份排序”的固定流程，推进到一套可审计、可恢复、支持结构化用户偏好的“最佳人像候选系统”。可靠性与离线逻辑已经大幅闭环：PhotoFilterAgent 现在自有严格五字段的 independent evaluator，并从父请求的实时 `requestHeader` 冻结 provider/model/reasoning。产品质量目标仍未最终验收：统一路由前的 M3 真实重跑只完成 57/289 独立审计；该结果已经按设计失效，新的所选 provider 尚未完成付费全量重跑。因此当前不能声称已经挑出全批最好的照片，也不能声称准确率达到 90%。

本轮没有读取照片、`me-pick` 或真实 checkpoint，没有调用模型、导出或发布 GitHub。

## Before：任务开始时是什么

### 产品能力

- 主流程是 `analyze → inspect/compare → resolve_family → propose → export`；能做技术质量过滤和局部比较，但没有一套冻结的“最好人像”rubric、exact-K 选择协议或独立反证机制。
- 用户偏好没有受约束的结构化层，无法证明偏好只在有限范围内调整通用 baseline，也无法稳定复现不同用户的输出差异。
- 相似连拍主要靠局部处理，没有集合级 family 上限；第一次真实名单出现单一连拍族 11/20，占 55%。

### Agent 与可靠性

- 长任务缺少完整的付费阶段 checkpoint、冻结预算和逐项 AB/BA leg；中断或重试存在重复调用、重复计费和候选计划漂移风险。
- 审计覆盖不完整曾被错误表述为质量 FAIL；selector 状态还会影响 evaluator 的 challenger 选择，独立性不足。
- 导出授权、来源门禁和文件冲突处理不够强，尚不能把“模型建议”和“真实文件副作用”严格分开。

### 模型架构

- 领域视觉评分曾独立直连固定 MiniMax 路径，与用户当前 Harness 会话模型不是同一条 adapter 路由。
- provider/model、endpoint/Key 和 evaluator 路由分散配置；切换会话模型不能保证 baseline、high、pairwise 与审计使用同一模型。

## 中间真实运行暴露了什么

### 第一次失败运行

- low baseline：289/289。
- high 复核累计膨胀到 208；AB/BA 为 19 对 / 38 legs。
- exact-20 中单一 family 占 11/20。
- 独立审计只到 22/255，额度失败却被错误解释为质量 FAIL。

这次运行证明了“能跑”不等于“最好”：成本边界、集合多样性和独立反证都没有闭环。

### 第二次（修复后）M3 重跑：统一路由前的历史证据

- low baseline：289/289；high 计划冻结为 60，首轮 59/60，重试只补 1。
- 完成 5 对 / 10 legs AB/BA；exact-20 覆盖 11 个 family，任一 family 最多 2 张。
- independent evaluator 先完成 selected high 20/20，再推进 remaining low 37 张，总进度 57/289。
- exact-20 hash：`ebfeeea0dc9c57aff71b3424e2cc90848de0852ab7c1aa92faf2f24586c4a938`。
- 用户实际运行界面记录约 80 分钟、6.3M input tokens、39.5K output tokens、98% cache hit、136 steps、6 rounds；累计 tool time 为 107m40s。它们是 UI 对这次旧流程的观测值，不能据此推导选片质量。
- 会话后段出现重复 `independent_evaluator → status`。审计持久状态始终是 Stage A `20/20`、Stage B `37/269`（合计 `57/289`）、Stage C/D `0`；`p233` 的实际失败为 HTTP 401。
- 循环根因不是“发现了质量反例”，而是旧流程仍使用可接收任意 prompt 的通用 evaluator，内部最多可重试 20 次，同时把 401 错分为 `retry_audit`，促使 Agent 再次调用 evaluator/status。

这是一份有价值的运行与故障历史，但没有到 Stage C/D，因而既不是质量 PASS，也不是质量 FAIL。它由统一路由与自有五字段 evaluator 上线前的 M3 使用路径生成；M3 是这名用户当时的会话选择，不是产品默认配置。新协议下这些资产必须 stale，不能接着跑或混入新结果。

## After：目前已经完成什么

### 1. “最好照片”的可执行定义

- 独立 baseline rubric 固定为六维 100 分，并把 eligibility 与可排序质量分分开；技术硬失败不能被审美偏好救回。
- 空偏好是真正 baseline invariant；用户偏好只通过白名单结构化字段进入第二层，单图调整受 `±4` 和质量 tradeoff 上限约束。
- exact-K 排名加入可满足目标的最小自适应 family cap；默认减少近重复，用户明确选择 `allow_series` 时才放宽。
- 边界候选使用 high 复核和 AB/BA 顺序交换比较；两方向不稳定就记为 TIE，不能强行选胜者。

### 2. 独立 evaluator 与反证

- PhotoFilterAgent 自有的 evaluator 从触发工具的父请求实时 `requestHeader` 捕获 provider/model/reasoning，不回退到创建 Agent 时可能过期的 options；缺少 header 时失败关闭。
- evaluator 使用新的独立 child、固定 persona、独立 prompt/rubric/cache/audit state，只允许 `audit_selection`，`maxDepth=1`；模型侧只收到 folder、candidate_scope、selected_ids、target、seed 五字段，多余字段直接拒绝。
- 每个 child 恰好调用一次 `audit_selection`，禁止在 child 内调用 status 或重试；selector 的评分、理由、偏好、排名与推理均不可见。
- audit v3：selected 全部 high；remaining 全部独立 low；只把 evaluator 自己的 cutline、同族强候选和固定 seed 随机样本晋升 high；最后最多 8 对 / 16 legs AB/BA。
- 覆盖不足只能 `INCOMPLETE`；只有完整覆盖后的稳定强反例才 `FAIL`，没有反例才 `PASS`。
- audit 工具有真实子会话 lineage 门禁；root/main Agent 在 engine、attachment 或模型调用前即被拒绝。
- 401/403/429、auth、quota 等路由错误返回 `BLOCKED`（底层审计状态保持 `INCOMPLETE`）与 `next_action=fix_model_route`；相同坏 route 再次进入时直接读取熔断状态，provider 调用为 0。

### 3. 费用、恢复与副作用安全

- low、high、每条 AB/BA leg 和 audit item 都逐项 checkpoint；重试只补 remaining。
- high 和 audit 每轮有冻结预算与硬上限；首次付费调用前必须先持久化计划，写失败时 provider 调用为 0。
- 401/403/429、auth、quota、credential 等错误会熔断后续付费调用；基础设施失败不会伪装成质量结论。
- 导出采用两阶段、selection-hash 绑定的一次性确认码；确认前复制 0 张。目标位于源目录、重名或已存在文件都会在复制前拒绝，不覆盖原图。

### 4. 用户当前 Harness 模型统一路由

- 已删除固定 `visionModel`、MiniMax endpoint、独立视觉 Key 和独立 evaluator 默认模型。
- main scoring、baseline、high、AB/BA 和 audit provider 统一通过 Harness LLM adapter 的隔离 one-shot 请求；Photo Curator preset 不固定具体厂商或模型。
- 每个工具调用都优先读取当前会话最新 `request/header`，再绑定 `provider/model/reasoning effort/protocol`。
- independent evaluator 不再依赖通用 preset 子 Agent 的静态 options，而由 PhotoFilterAgent 在父工具请求内创建独立 child，并在 child request 上再次强制同一路由。
- 首张图片前校验 exact route、显式 image input、JPEG/双图 attachment 限制，并执行一次不含图片的极小 tool-call 动态探针；失败时图片不保存、不发送，也不 fallback。
- cache/checkpoint identity 绑定 provider、model、reasoning、protocol 与 rubric/prompt hash；切换模型即让旧资产 stale。
- 状态输出显示实际全链路模型和动态预检状态。
- M3 和此前讨论过的其他模型都只是用户侧会话选择，不写入 preset、profile 或产品默认配置；真实重跑应继承用户届时实际选定的 provider/model。

## 当前验证结果

| 层级 | 结果 | 能证明什么 | 不能证明什么 |
| --- | --- | --- | --- |
| Agent 离线回归 | 90/90 PASS | rubric、偏好、exact-K、预算、恢复、审计、授权、实时 requestHeader evaluator 路由、child request 强制、child 单次审计门禁与同 route 熔断零调用 | 真实所选 provider 的看图质量 |
| 严格 TypeScript | PASS | 当前插件入口在 Harness 包解析下无类型错误 | 运行时 provider 服务可用 |
| 静态生产路径扫描 | PASS | `agent/src`、preset、profile、README 无固定 MiniMax route、endpoint、Key | 用户 Harness 自身没有其他 provider 配置 |
| Harness fake adapter | PASS | header 优先、text-only/image fail-closed、无图片前探针、无 fallback、请求只走选中 route | 真实凭据、真实图片协议和 50 万 token 是否足够 |
| Swift 当前构建产物 xctest | 7/7 PASS | ExportSafety 与人物分类回归通过 | 本轮 `swift test` wrapper 重新编译；其被 sandbox 阻止，未进入测试 |
| 旧 M3 真实视觉运行 | 289 low、60 high、10 legs、audit 57/289 | 预算和 remaining-only 在统一路由前真实工作，也暴露 401 重试循环 | audit PASS/FAIL、“最好”、90% overlap；且该缓存已 stale |
| 本机真实安装与 UI roster | PASS | rc.8 安装器、自有 evaluator preset、插件软链和 UI 的 Photo Curator 入口可发现；读取白名单仅测试目录，导出白名单为空 | 未发送消息，不能证明真实 provider 看图或 endpoint |

## 还要做什么

### P0：不消耗照片评分额度已完成/仍需产品化

1. **已完成**：在真实 `~/.dsh` 安装路径重装；安装器检测 rc.8，roster 结构检查通过，UI 新任务选择器可见 Photo Curator；已安装 preset 不再含通用 `dsh-tool-subagent`，照片读取白名单仅 `/Users/bytedance/Desktop/照片测试`，导出白名单为空。全程未发送消息或调用模型。
2. **仍需 Harness**：提供无网络 `inspectRoute()`，明确 image input、tool calling/structured output、credential readiness。当前动态探针是安全的 fail-closed 临时方案，但会消耗少量 token。
3. **仍需 Harness**：暴露稳定 adapter/config cache identity。当前 identity 已满足 provider/model/protocol/rubric/prompt 绑定，但同名 provider 更换 endpoint/config 时仍缺少可持久化修订号。
4. **仍需 UI**：把成本、当前阶段、N/M、cached/paid/remaining、暂停/继续和全局停止做成可操作界面；当前状态机有数据，用户界面还没有完整呈现。
5. **已完成**：oracle 相对路径在候选扫描、fingerprint 和匿名 ID 之前排除；PASS 后由插件生成绑定 exact-K、模型/rubric/prompt 与内容哈希 multiset 的 receipt。独立 overlap CLI 先验 receipt、再验证 oracle realpath，未通过时不会读取 oracle，也不再要求开放导出目录。

### P0：需要用户选定真实 provider 并授权付费才能完成

1. 新建 Photo Curator 会话，由用户明确选择届时要验收的 provider/model；动态预检 PASS 后才允许首张图片，产品不得把 M3 或其他个人使用模型写成默认值。
2. 从 289/289 low baseline 重新开始；旧 exact-20 与 57/289 cache 保持 stale，不混用。
3. 按冻结预算完成 high、AB/BA 和新 exact-20；同时核验 network/trace 的实际 endpoint，只能出现用户所选 provider route，不能出现 MiniMax、其他模型或隐式 fallback。
4. independent evaluator 保持同一 provider/model，但使用独立会话、prompt、rubric、缓存和不可见 selector 状态；固定 seed 反证直到明确 PASS/FAIL。
5. 只有 audit PASS 后才向用户展示最终名单并请求导出确认。

### P0：需要用户确认才能继续

1. 用户确认后才实际导出；重合率验收本身不要求导出。
2. audit PASS、`propose` 与 receipt 冻结之后，另一个隔离 evaluator 才读取 `/Users/bytedance/Desktop/照片测试` 下已声明排除的 `me-pick`，计算 exact overlap、Precision@K、Recall@K、F1 与 Jaccard；目标重合率不得低于 90%。oracle 不能反向调本轮 prompt 或权重。
3. 把结果、已知限制和 diff 发给用户确认；只有再次明确同意后才发布 GitHub。

## 尚未闭环的原始要求

- 还没有一份可追溯的“GitHub 类似项目广泛检索”交付物；即使早期做过零散调查，也不能把未留证据的活动算完成。后续如要补做，只搜索公开代码/论文，不上传任何用户照片或本地内容。
- 还没有在同一批真实照片上跑默认 baseline 与至少两组结构化偏好的 A/B 结果，因此“不同用户偏好能稳定改变输出”目前只完成合成验证。
- 新协议下真实所选 provider 的独立审计尚未运行，冻结 receipt 与 oracle overlap 尚未产生，导出未发生，GitHub 未发布。
