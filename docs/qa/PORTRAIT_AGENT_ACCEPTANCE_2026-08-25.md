# 人物精选 Agent 真实验收记录（2026-08-25）

状态：**自有五字段 evaluator 与统一实时路由的离线改造已通过；真实所选 provider 的付费全链路尚未启动，尚无质量 PASS/FAIL**  
测试方式：通过 DeepSeek Harness 的 `Photo Curator` preset 实际运行，不以源码静态阅读替代体验。  
评测边界：此前真实运行只使用委托人授权测试集建立的 289 张隔离候选；本轮统一路由改造没有读取任何照片、真实 checkpoint 或人工 `me-pick` oracle，没有调用模型、导出或公网发布。

## 0. 统一路由前的 M3 真实重跑证据（历史、已失效）

- 完整目录、无 `limit`；`candidate_scope=people_only`；空偏好已验证为真正 baseline（`isBaseline=true`、`diversityExplicit=false`、adjustment=0）。
- low baseline 289/289 完成。一次失败项在同参数重试后补齐；`evaluate_pool` 已强制 low-only，不能再因单张失败误触发整池 high。
- `build_selection(plan)` 冻结 high 预算 60；`run` 首轮 59/60，重试仅补 1 张并命中其余 59 张缓存；随后完成 5 对/10 legs 双向比较。
- 新 exact-20 的 `selection_hash=ebfeeea0dc9c57aff71b3424e2cc90848de0852ab7c1aa92faf2f24586c4a938`。20 张分布在 11 个 family，任一 family 最多 2 张（10%），旧版单族 11/20 问题未复现。
- 独立 evaluator 首轮 Stage A 完成 18/20，2 张基础设施失败后正确返回 `INCOMPLETE`；修复 evaluator 状态契约后，重试只补这 2 张并进入 Stage B。
- 独立审计曾持久化 57/289：selected high 20/20、remaining low 37/269；尚未进入 Stage C/D，因此从未形成质量 PASS/FAIL。
- 用户实际运行界面记录：约 80 分钟、6.3M input tokens、39.5K output tokens、98% cache hit、136 steps、6 rounds，累计 tool time 107m40s。这些是统一路由前旧流程的成本与运行证据，不是选片质量指标。
- 会话后段重复出现 `independent_evaluator → status`。持久审计状态没有越过 Stage A `20/20`、Stage B `37/269`（合计 `57/289`），Stage C/D 均为 `0`；`p233` 的实际错误是 HTTP 401。
- 根因是当时仍使用可接收任意 prompt 的通用 evaluator，内部最多允许 20 次 retry，且 401 被错误归类为 `retry_audit`，从而诱发 evaluator/status 循环。它表示基础设施与控制流失败，既不是质量 PASS，也不是质量 FAIL。
- 这份 exact-20 与 57 张 audit cache 使用统一 Harness 路由改造前的独立视觉调用身份生成。文件仍物理保留用于审计历史，但新代码会因 route/protocol/prompt identity 不同把它们判为 stale；不能继续补 remaining，也不能作为新模型结果复用。
- M3 只是这名用户当时在 DSH 中的会话选择，不是 Photo Curator 产品默认模型，也不应写入 agent、preset 或 profile。旧运行还出现过 `429 / 2056 Token Plan 用量上限`；它只描述历史验收环境。

### 无额度闭环（不代表真实选片质量通过）

- 已移除 Photo Curator 的固定视觉模型、MiniMax endpoint、独立 API Key 和默认 evaluator `visionModel`。主 Agent、baseline、high、AB/BA 和 independent evaluator 的评分身份统一绑定当前 DSH `provider/model/reasoning/protocol`；任何具体模型都只是用户会话选择，不写进产品 preset。
- PhotoFilterAgent 现自有严格五字段 evaluator：从触发工具的父请求实时 `requestHeader` 捕获 provider/model/reasoning，缺 header 时失败关闭；以新的独立 child、固定 persona、`toolFilter=audit_selection`、`maxDepth=1` 运行。子 Agent 只得到 folder、candidate_scope、selected_ids、target、seed，额外字段直接拒绝，且必须恰好调用一次 `audit_selection`，禁止 status 与内部重试。
- 所有图片调用改经 Harness 统一 LLM adapter 的隔离 one-shot；在首张图片前先校验 exact route、显式 image input、JPEG/双图 attachment 限制，再运行一次不含图片的极小 tool-call 动态探针。探针失败会在图片前阻止，不会 fallback 到 MiniMax。注意动态探针会消耗少量 token，本轮只用 fake adapter 验证，未真实执行。
- score、draft、pairwise 和 audit cache identity 已绑定实际 provider、model、reasoning effort、协议与 rubric/prompt hash；切换模型即失败关闭。状态输出会显示全链路实际模型和预检状态。
- 已把生产 `audit_selection` 的 staged audit 状态机提取为可注入 runner，并用 19 个纯合成匿名候选验证 `INCOMPLETE → PASS` 与 `INCOMPLETE → FAIL`。第一次恰好用完 32 次预算并停在 AB/BA 中间；新 `RunState` 从临时 checkpoint 恢复后只补剩余一条 BA leg，已成功落盘的 provider 操作没有重复。
- `audit_selection` 增加运行时来源门禁：主/root Agent 在初始化路径、engine 或视觉 provider 之前即被拒绝；只有带 Harness 持久子会话 lineage 的独立 evaluator 能调用。persona 隔离不再是唯一防线。
- 401/403/429、auth、quota 等 provider 路由错误会返回 `BLOCKED + next_action=fix_model_route`（持久质量状态仍为 `INCOMPLETE`）；同一坏 route 再次进入只读取熔断 checkpoint，provider 调用为 0，不再形成 evaluator/status 循环。
- 导出改为两阶段授权：第一次只冻结 selection hash、规范化目标目录和一次性码，复制 0 张；只有发码后新出现的真实用户消息精确确认同一码，才允许第二次调用。错码、旧消息、模型/tool/plugin 伪造、名单或目录变化均失败关闭。
- 本地导出引擎拒绝目标等于/位于源目录、重复 basename 和已有同名目标；不再删除或覆盖目标文件。完整预检通过后才开始复制。
- 真实安装器复验发现旧 README 使用的 `{version, refs}` 凭据格式不兼容 Harness rc.8，会在启动、尚未调用模型前失败。安装器现会在不输出 secret 的前提下原子迁移为扁平 ref→string 映射；README 示例同步修正，并有合成值回归测试。
- 当前离线回归：Agent `93/93`，新增覆盖 oracle scan exclusion、严格 audit PASS receipt、selection hash/内容 multiset、receipt-before-oracle 门禁和 declared realpath 授权；严格 TypeScript typecheck、`node --check`、`git diff --check` 全部通过。Swift `16/16`，其中新增候选子树排除、symlink 越界/绕过和 content-hashes 流式只读测试。
- 已按真实用户路径重新安装到 `~/.dsh`：rc.8 版本检查、preset roster、插件链接与 UI 新任务选择器的 Photo Curator 可发现性均 PASS；安装产物不含通用 `dsh-tool-subagent`，读取白名单仅为授权测试目录，导出白名单为空。该 UI 检查没有发送消息或调用模型，因此不能替代真实 provider route/endpoint 验收。
- 证据边界：这些测试证明状态机、恢复、权限和文件安全逻辑闭环；由于旧模型身份缓存已 stale，它们不能替代用户新选定 provider 路由下从 289 张 low baseline 开始的完整真实重跑，也不能证明最终名单达到 90% oracle overlap。
- 已知残余窗口：若进程恰好在供应商成功返回后、checkpoint 落盘前崩溃，最后一次请求仍可能重发，彻底消除需要供应商幂等键/请求收据；复制阶段若发生磁盘或 I/O 中途故障，可能留下已复制的部分副本，但不会覆盖既有文件或修改原图。
- 当前 Harness 还没有静态暴露 tool calling、structured output、凭据 readiness 或 adapter 配置修订身份；动态探针能证明 exact route/credential/tool-call 当次可用，但不能证明完整图片链路额度充足。provider 同名配置若更换 endpoint，目前也没有可持久化的 adapter revision 可加入 cache identity。

### 本轮通过真实 UI 新定位并修复的问题

1. **空 preference 被工具层 `undefined` 误判为显式 diversity**：在输入规范化时移除未定义字段，空对象恢复真正 baseline。
2. **单张 low 失败诱导 Agent 调整池 high**：`evaluate_pool` 只接受 low；失败输出包含 ID 与具体 provider error，persona 禁止猜测文件损坏。
3. **selector 付费资产只在整批末保存**：改为每张成功后原子 checkpoint；写失败立即停止后续调用；429/2056/2062 熔断。
4. **selector pairwise 的 AB 成功、BA 失败会丢腿**：AB/BA 使用方向身份分别保存；计划内任一 leg 未完成时返回 `INCOMPLETE + retry_build_selection`，禁止冻结草案。
5. **首次 high 付费前冻结写失败仍继续花费**：增加 durable prerequisite gate；`saveState=false` 时 provider 调用为 0。
6. **独立子 Agent 先调 `analyze_folder` 会把目标改成 0**：evaluator 现在只允许 `audit_selection`；工具按五项输入自举候选和冻结 checkpoint，以 hash 校验后的 keep/target 为准，并在任何付费前修复持久 target。
7. **每轮 48 次审计超过 Harness one-shot 墙钟上限，只显示 generic error**：真实运行在第 39 次附近被终止但 checkpoint 未丢；单轮硬预算降为 32，使每轮能显式返回 `INCOMPLETE` 并续跑 remaining。
8. **`analyze_folder(limit=N)` 无法证明“全批最好”且与五项审计契约不兼容**：`build_selection` 对 limit 增加硬拒绝；最终最佳人像只能使用完整目录。
9. **界面切换模型时通用子 Agent 可能继承旧 options**：已改为 PhotoFilterAgent 自有 evaluator，在工具执行瞬间从父请求 `requestHeader` 冻结 provider/model/reasoning，并在独立 child request 上再次强制同一路由；不读取 stale `parent.options`，缺 header 或 identity 不一致即失败关闭。该机制已完成离线测试与本机 preset/UI 安装验收，但仍需真实 provider route/endpoint 验收，不能据此宣称真实看图质量通过。
10. **人工 pick 位于输入根目录下会污染 selector 候选和重合率**：新增显式 `excludedRelativePaths`，Swift 枚举器在图像分析、fingerprint 和匿名 ID 前跳过整棵子树，并拒绝绝对路径、`..`、根路径、NUL 与 symlink 逃逸。插件在 audit PASS 后只对冻结匿名 ID 计算本地 SHA-256，生成不可覆盖 receipt；独立 evaluator 验证 receipt 与 oracle realpath 后才读 pick，无需导出。

以下第 1–5 节保留第一次失败运行的证据与当时结论，作为修复前对照；不代表当前新名单。

## 1. 已跑通的真实路径

1. 本地扫描 289 张候选，得到本地人物 287、风景 2；因用户明确整批均为人物候选，本轮使用 `candidate_scope=people_only`，人物评估池为 289。
2. 空偏好 profile，baseline adjustment 为 0。
3. 289/289 完成 low baseline；首轮 15 张失败，重试只补失败项，随后全部命中缓存。
4. `build_selection` 完成 high 复核与双向 pairwise，冻结 exact-20；selection hash 为 `e067697bbdd6f48e79a44999ef9c85dbaf8f148f0543d7ca9335873047b034b6`。
5. Harness 原生一次性独立子 Agent 只收到 folder、candidate scope、selected IDs、target、seed，未收到主 Agent 的分数、理由、排名、偏好或推理。
6. 独立审计开始后在 22/255 张处耗尽模型套餐额度，没有形成质量 PASS/FAIL。

源照片安全复验：以运行前隔离副本为基准，对 289 张受支持候选做逐字节 checksum dry-run，比对无差异；原图未被修改。

## 2. 实测调用与耗时

| 项目 | 实测 |
| --- | ---: |
| 全池 low baseline | 289 张 |
| high 复核 | 208 张 |
| 双向 pairwise | 19 对 / 38 次方向调用 |
| 独立 audit 已调用 | 22 次 |
| 本轮已发生人物视觉调用 | 557 次 |
| 主名单冻结前后总耗时 | 约 47 分钟 |
| 缓存命中记录 | 921 次 |

`cached` 表示工具避免了重复付费请求，不应与真实付费调用相加。

## 3. 问题与修复节点

### [严重] high 精评候选跨重试膨胀，预算上限失效

- **实际**：设计意图约为 Top 60；实现把头部 family 的全部成员加入复核池，首轮后又按 mixed low/high 结果重新规划，最终累计 high 达到 208。
- **影响**：耗时和费用不可预测，并直接耗尽后续盲审所需额度。
- **定位**：`agent/src/index.ts::build_selection` 的 refinement family expansion 与重试规划；`agent/src/state.ts` 缺少冻结的 refinement checkpoint。
- **修复**：high hard cap；每个头部 family 仅补有限 challenger；首次付费前冻结 candidate IDs，重试只补同一集合中的失败项；提供 `mode=plan` 零费用预算预览。

### [严重] 审计覆盖失败被误判为质量 FAIL

- **实际**：审计仅完成 22/255，剩余请求因额度失败；工具却返回 `FAIL` 并要求回到 `build_selection`。
- **影响**：没有发现审美反例也会推翻冻结名单，诱发无意义重建和重复付费。
- **定位**：`agent/src/index.ts::audit_selection` 把 `failedIds.length > 0` 合并进 `passed=false`；`PortraitAuditReport` 只有 boolean。
- **修复**：三态 `PASS / FAIL / INCOMPLETE`。覆盖不完整只能 `INCOMPLETE + retry_audit`；覆盖完整且存在稳定更强 challenger 才能 `FAIL + rebuild_selection`。

### [严重] 旧审计没有逐项 checkpoint，重试会重复支付已完成 22 张

- **实际**：旧状态只累加 `portraitAudit=22`，未保存 22 张 assessment 和已完成 pairwise。
- **影响**：UI/Agent 声称可恢复，但实际无法幂等续跑，违反费用知情与断点恢复承诺。
- **定位**：`audit_selection` 的 `auditScores`、`jpegById` 和 pairwise 结果仅存在于单次调用内。
- **修复**：增加与 selector 物理隔离的 audit score/pairwise cache，键绑定 dataset、rubric、model、detail、顺序；每项成功立即落盘，重试只补 remaining。

### [严重] 独立子 Agent 的挑战池仍受 selector 分数影响

- **实际**：子 Agent 对话与单图 audit prompt 已隔离，但 `audit_selection` 仍从 selector 的 `portraitScores` 取得 eligibility、baseline 和 tags，用它们选择 hard negatives 与随机分层。
- **影响**：审计者会重新看图，却不是独立决定“审谁”；selector 的遗漏可能同时污染审计覆盖，不满足独立验收要求。
- **定位**：`agent/src/index.ts::portraitRankingCandidates(state, true)` 被 `audit_selection` 用作 challenger sampler；fresh evaluator 的 `analyze_folder` 会恢复共享 selector state。
- **修复**：audit v3 不读取 selector score/preference/comparison/reason。先 high 审全部 selected，再用独立 low rubric 覆盖其余候选、建立自己的 cutline；仅把置信区间重叠、分差不超过 4、每族最强替代和固定种子随机样本晋升 high，最后做可断点的 AB/BA。只有 v3 完整覆盖后的 PASS 才能放行。

### [严重] 冻结名单被单一连拍族支配，不是可用的“最好的一组”

- **实际**：20 张中 11 张来自同一个相似族，占 55%；本地抽查可见为高度近似的同场景取景。没有读取人工 oracle。
- **影响**：绝对分对某一场景的系统性偏爱压过集合价值，用户得到大量近重复照片。
- **定位**：`agent/src/ranking.ts::rankPortraits` 只给新 family 最多 4 分 novelty；当同族分数连续高 4 分以上时可无限重复。
- **修复**：baseline 使用可满足 exact-K 的最小自适应 family cap；无 family 的照片视为单例。用户明确要求保留系列时才允许结构化 preference 放宽。语义多样性仍受 4 分质量前沿约束。
- **修复后离线复算**：在同一真实评分 checkpoint 上，exact-20 变为 10 个 family、每族 2 张；最大 family 占比从 55% 降为 10%。该复算未读取 oracle，最终名单仍需 Harness 重新冻结与盲审。

### [严重] 长时付费任务缺少可操作的成本与进度界面

- **实际**：长时间只显示“运行中”和总耗时；看不到当前批次 N/M、剩余调用、预计费用/ETA，也没有步骤级暂停与安全停止。首次任务虽已由委托人在会话外明确批准，但产品内没有完整的持续知情反馈。
- **影响**：用户无法判断是否卡住、是否继续烧钱，也无法在保留 checkpoint 的前提下暂停。
- **定位**：Harness 工具契约只返回最终字符串；`evaluate_pool`、`build_selection`、`audit_selection` 没有统一 RunEvent/Progress 状态。
- **修复规划**：将付费步骤拆成 plan/start/pause/resume/stop；状态机持久化 `planned/completed/remaining/paid/cached/retry/error/ETA`，侧栏实时渲染并提供全局停止。

### [一般] 模型选择器未提前标识凭证与套餐可用性

- **实际**：MiniMax 在运行后才暴露 `429 / 2056 Token Plan 用量上限`；DeepSeek-V4-Pro 可选，但运行后才报 `MISSING_CREDENTIAL`。
- **影响**：用户在关键审计阶段才发现无法继续。
- **已完成**：PhotoFilterAgent 在首张图片前做 exact route、显式 image input、attachment 限制和不含图片的 tool-call 动态探针；凭据、路由或结构化工具调用失败会阻止图片发送且不 fallback。
- **仍待 Harness**：为 UI/plan 提供零额度的 route inspection seam，静态暴露 tool calling、structured output 与 credential readiness；额度是否足够仍需供应商能力或预算接口，不能由一次极小探针证明。

### [一般] `needs_review` 与“调用失败”容易混淆

- **实际**：289 张已经都有评分，但主 Agent 把 5 张 `needs_review` 当成失败，再调用一次 low；本次因缓存未重复付费。
- **影响**：模型容易误触发无效重试，状态语义不清。
- **修复规划**：工具返回分离 `completed/eligible/needs_review/failed/remaining`，并把 `next_action=build_selection` 作为结构化字段。

## 4. 当前验收结论

- baseline rubric、结构化偏好、exact-K、双向 pairwise、冻结 hash 和独立子 Agent 隔离机制均已建立。
- 首轮结果因单族 11/20 过度集中，产品质量不能通过；第二轮旧路由 exact-20 虽降到每族最多 2 张，但 audit 只到 57/289，仍未证明“最好”。
- 固定 MiniMax 视觉旁路已经移除，PhotoFilterAgent 侧的统一路由、预检、无 fallback、模型身份缓存失效、自有五字段 evaluator 和状态展示已通过离线测试。真实安装环境与所选 provider endpoint 仍需核验。
- 旧 22/255 与 M3 重跑的 57/289 都是历史 `INCOMPLETE`，不能称为 PASS，也不能解释成质量 FAIL；在用户新选定的真实 provider 路由下必须从全池 low 重新冻结并审计。
- 在新版本重新冻结结果并完成 blind audit 前，不导出；在另一个隔离进程完成 oracle overlap 前，不声称达到 90%；在委托人最终确认前，不发布 GitHub。

## 5. 重跑门槛

1. high 计划和审计计划能在付费前显示，重试累计调用不越冻结预算。
2. audit score/pairwise checkpoint 的中断恢复回归测试通过。
3. exact-20 不再由单一近重复 family 支配；重复策略可由结构化用户偏好显式放宽。
4. audit sampler 对 selector state 的访问隔离测试通过，旧 v1/v2 PASS 不可放行。
5. **已完成**：按真实用户路径重装并在 UI 新任务选择器确认 Photo Curator 可发现；没有发送照片或模型请求。
6. **下一付费门槛**：由用户明确选择本轮真实验收的 provider/model 后启动全新运行；动态探针 PASS 后，核验 network/trace 的实际 endpoint，所有模型请求只能出现该 provider 路由，不能出现 MiniMax、其他模型或 fallback。
7. 旧统一路由前缓存保持 stale；全池 289 张从 low baseline 开始重新评分，再按冻结预算完成 high 与 AB/BA。
8. 新冻结名单由独立 evaluator 返回明确 PASS；随后才请求导出确认并运行隔离 oracle overlap。
