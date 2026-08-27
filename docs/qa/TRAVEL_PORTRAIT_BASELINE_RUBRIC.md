# 旅行人像 Baseline 评分 Rubric

状态：冻结 v1  
用途：在不知道用户偏好、精选结果和人工 oracle 的前提下，对每张旅行人像做独立质量评估。

## 1. 评估边界

评估者只根据图像内容打分，不猜测摄影者身份、人物关系或受保护属性。baseline 衡量“这张照片作为旅行人像是否成立且出色”，不负责模仿某个用户的个人口味。

先判断资格，再对六个维度分别给 0–100 分。只有以下情况可判为不合格：

- `HR_UNASSESSABLE_ASSET`：文件损坏、无法解码或画面信息不足以评估；
- `HR_NO_INTENTIONAL_HUMAN_SUBJECT`：画面没有有意拍摄的人物主体；
- `HR_PRIMARY_SUBJECT_UNINTERPRETABLE`：主要人物无法辨识到足以评价姿态、瞬间或画面作用；
- `HR_CATASTROPHIC_CAPTURE_FAILURE`：整张照片因灾难性曝光、遮挡、失焦等已无法作为人像使用。

闭眼、背影、剪影、人物较小、运动模糊、偏色、强烈阴影或非常规构图都不是自动硬淘汰。应判断它们是意图的一部分还是偶发缺陷：自然眨眼通常显著降低“人物瞬间与情绪”，但安静闭眼、动作或氛围表达可以是成立的瞬间。

## 2. 通用评分锚点

每个维度使用同一组锚点，可在锚点之间给整数分：

| 分数 | 含义 |
| ---: | --- |
| 0 | 该维度完全失败，且严重破坏照片用途 |
| 25 | 明显较差，缺陷主导观看体验 |
| 50 | 基本可用但普通，优缺点大致抵消 |
| 75 | 明显优秀，有具体且稳定的优点 |
| 100 | 罕见地出色，几乎没有妨碍该维度的缺陷 |

不要因为“没有明显错误”就给高分；75 以上必须能指出正向证据，90 以上应非常克制。

## 3. 六维评分

### 3.1 技术质量与主体可辨识度（18%）

判断对焦、细节、曝光、动态范围、噪点、压缩痕迹和运动表现是否支持主要人物。技术处理服务于表达即可，不要求所有照片都锐利或曝光中性。

- 25：人物因非意图失焦、严重过曝/欠曝或遮挡而难以观看。
- 50：可用，但锐度、曝光或噪点有显著妥协。
- 75：主体清楚，技术选择可靠，观看无明显阻碍。
- 100：技术执行精准且强化画面意图。

### 3.2 人物瞬间与情绪（22%）

判断表情、眼神、姿态、手势、动作时机和人物之间互动是否自然、有张力或有意义。这是权重最高的维度。

- 25：偶发眨眼、尴尬表情、僵硬姿态或错误动作相位明显破坏人物呈现。
- 50：表情姿态正常但普通，没有明显错误也没有强瞬间。
- 75：自然、有感染力或动作时机准确，人物状态可信。
- 100：决定性的、不可轻易复制的人物瞬间。

### 3.3 构图与视觉层级（18%）

判断主体位置、取景、边缘处理、空间关系、背景干扰、线条和层次是否使视线清楚地到达人物。中心构图、留白或裁切没有固定优劣，关键是是否有意且有效。

- 25：边缘误切、背景冲突或视觉重心混乱持续干扰主体。
- 50：构图可读但常规，存在小干扰或空间利用一般。
- 75：层级清晰，人物与环境关系有控制力。
- 100：构图精确、独特，并显著增强瞬间或叙事。

### 3.4 光线、色彩与影调（16%）

判断光线方向、人物肤色/色彩关系、反差、层次和氛围是否协调并支持主体。不要把高调、低调、逆光或风格化色彩自动视为缺陷。

- 25：光色使人物难看或画面关系破碎，且看不出表达意图。
- 50：光色基本正确但平淡，或有可见的小问题。
- 75：光线塑造人物，色彩与影调协调且有氛围。
- 100：光色具有决定性的表达力和完成度。

### 3.5 旅行环境与叙事（16%）

判断地点、活动、天气、尺度或环境线索是否与人物共同构成旅行记忆，而不是把人物随意放在背景前。紧凑特写也可通过情绪、物件或动作传达旅行语境。

- 25：环境杂乱或与人物无关，削弱照片意义。
- 50：能看出旅行场景，但关系常规、信息有限。
- 75：人物与地点相互解释，画面具有清楚故事或记忆点。
- 100：环境、人物与瞬间形成不可替代的完整叙事。

### 3.6 意图感与完成度（10%）

判断照片是否像一个被看见并完成的画面，而非仅仅按下快门：形式选择是否一致，细节是否收束，风格和内容是否互相支持。

- 25：明显像误触、试拍或未完成构想。
- 50：是一张完整记录，但选择较默认。
- 75：形式决策清楚，画面完整且有作者意图。
- 100：所有关键选择高度一致，呈现成熟且独特的最终作品感。

## 4. 总分与结构化输出

仅对 `eligibility.status="eligible"` 的照片计算：

```text
baseline_total =
  technical_subject_legibility * 0.18 +
  human_moment * 0.22 +
  composition_visual_hierarchy * 0.18 +
  light_color_tone * 0.16 +
  travel_context_story * 0.16 +
  intentionality_finish * 0.10
```

六个维度分先在本地规范化为整数，再由本地按冻结权重重算总分；模型不得输出或决定 `baselineScore`。按当前整数维度分和整数百分比权重，总分精度不超过两位小数。

供应商模型必须且只能调用 `submit_portrait_baseline`，其 tool payload 与当前生产 schema 对齐如下。它不包含匿名 ID、rubric 版本、总分、推荐、名次或选择状态：

```json
{
  "eligibility": {
    "status": "eligible",
    "failureCodes": [],
    "evidence": ["最多四条可见证据"],
    "assessability": 0.0,
    "ambiguousIntent": false
  },
  "dimensionScores": {
    "technical_subject_legibility": 0,
    "human_moment": 0,
    "composition_visual_hierarchy": 0,
    "light_color_tone": 0,
    "travel_context_story": 0,
    "intentionality_finish": 0
  },
  "dimensionConfidences": {
    "technical_subject_legibility": 0.0,
    "human_moment": 0.0,
    "composition_visual_hierarchy": 0.0,
    "light_color_tone": 0.0,
    "travel_context_story": 0.0,
    "intentionality_finish": 0.0
  },
  "dimensionEvidence": {
    "technical_subject_legibility": ["最多三条可见证据"],
    "human_moment": [],
    "composition_visual_hierarchy": [],
    "light_color_tone": [],
    "travel_context_story": [],
    "intentionality_finish": []
  },
  "overallConfidence": 0.0,
  "scoreInterval": [0, 100],
  "observableTags": {
    "expression": [],
    "gaze": [],
    "framing": [],
    "lighting": [],
    "mood": [],
    "scene": [],
    "poseAction": []
  },
  "summary": ""
}
```

本地校验、规范化并补齐身份后，才形成可持久化的 `PortraitBaselineAssessment`：

```json
{
  "id": "opaque-id",
  "rubricVersion": "travel-portrait-baseline-v1",
  "eligibility": {
    "status": "eligible|ineligible|needs_review",
    "failureCodes": [],
    "evidence": [],
    "assessability": 0.0,
    "ambiguousIntent": false
  },
  "dimensionScores": {},
  "dimensionConfidences": {},
  "dimensionEvidence": {},
  "baselineScore": 0.0,
  "overallConfidence": 0.0,
  "scoreInterval": [0, 100],
  "observableTags": {},
  "summary": ""
}
```

`id` 与 `rubricVersion` 由本地加入；`baselineScore` 由本地重算，非 `eligible` 时必须为 `null`。`ineligible` 没有合法 `failureCodes`，或 `eligible` 却带有 failure code 时，本地必须降为 `needs_review`，不能静默硬淘汰。`overallConfidence`、各维度 confidence 和 `assessability` 均为 0–1，只表示评估可靠程度，不能直接抬高总分。证据必须可见、具体，禁止使用“高级感”“氛围很好”等没有图像依据的空泛描述。

## 5. 成对比较协议

当两张照片 baseline/校正分差不超过 4、位于 K 的切线附近、属于同一相似族且都有竞争力，或被审计列为挑战者时，使用成对比较。

比较问题固定为：**在不考虑个人偏好的前提下，哪一张是更成功的旅行人像？** 优先依次考虑人物瞬间、构图与视觉层级、技术可用性、光色、旅行叙事和完成度；不能只复述绝对总分。

每个方向的供应商 tool payload 只包含 `winner=FIRST|SECOND|TIE`、六维 `dimensionDeltas`、`confidence` 和一条 `reason`。每维 delta 必须是 `-2|-1|0|1|2`；正数表示 FIRST 更好，负数表示 SECOND 更好。

每对执行两次：第一次 A 在前、B 在后；第二次交换顺序。系统把第二次结果归一回同一 A/B 方向，并按 `Σ(dimensionDelta × weight / 100) × 5` 计算每条 directional weighted margin，范围为 `[-10, 10]`。最终 `margin` 是两条 directional margin 绝对值的平均值，范围为 `[0, 10]`；最终 confidence 是两次 confidence 的平均值。

只有两次都给出同一非 `TIE` 胜者、方向与 weighted margin 符号一致、最终 `margin >= 5` 且平均 `confidence >= 0.75` 时，才形成稳定胜负；否则本地结果为 `TIE`。不稳定项应进入更多比较或高细节复评，不能由主 Agent 凭直觉裁决。

## 6. 偏好与多样性边界

baseline 文档和评估 prompt 中不得加入用户偏好。偏好由后续独立层根据结构化 profile 计算，单图调整上限为 `±4`，默认 `max_quality_tradeoff=8`，不得恢复硬门槛不合格项，也不得使用受保护属性。集合重复偏好使用独立的 `seriesRetention=balanced|one_per_family|allow_series`；它不改写单图 baseline。

多样性只在质量前沿中选择：候选与当前边界的质量差不超过 4 时，才允许按场景、构图、动作或相似族给予最多 `+4` 的多样性效用。质量优先；完全重复或近重复最多保留一张，除非用户明确要求保留连拍序列。

## 7. 盲审要求

独立审计者不得接收主 Agent 的选择理由、历史对话、用户 pick/oracle、偏好标签、selector 分数、资格、标签或排名。审计池必须含：全部入选项、全部同族未选项、全部由审计者独立计算的 cutline hard negatives，以及按固定种子从剩余照片中做的分层随机样本。审计者先 high 评全部入选项，再以本 rubric 的 low 档独立覆盖其余候选，建立自己的 cutline；只有可能超过最弱入选项的照片才晋升 high 并运行顺序交换 pairwise。

主 Agent、selector baseline/high、AB/BA 和 independent evaluator 必须统一使用当前 Harness 会话的完整 `provider + model + protocol + reasoning effort` 路由。PhotoFilterAgent 不得持有独立视觉模型、endpoint 或 API Key，也不得在路由、图片能力、凭据或结构化 tool call 失败时 fallback 到其他供应商、模型或纯文本 JSON；任一不一致都必须在图片请求前失败关闭。

每个 selector/audit score 与 AB/BA leg 的有效身份必须覆盖 role、数据集、匿名 ID、detail、rubric/prompt hash 和实际 Harness route identity；pairwise 还必须覆盖两端匿名 ID 与 `AB|BA` 顺序。凭据值不得写入缓存键。每项成功后立即 checkpoint；切换 provider、model、protocol、reasoning effort 或 rubric/prompt 时旧 score、draft 和 audit 必须失效。当前 Harness 尚未提供 endpoint/adapter 配置修订身份；在同名 provider/model 下改变 endpoint 或 adapter 配置时，必须显式清除相关缓存，不能把旧结果视为同一路由证据。

覆盖不足返回 `INCOMPLETE`，保持 selection hash 不变并只补 remaining；覆盖完整且存在稳定反例才返回 `FAIL`。

随机抽样只能发现风险，不能证明全池不存在更好的照片。审计报告必须列明覆盖范围和未覆盖风险。若出现稳定胜出的挑战者，当前选择不通过。

## 8. 冻结与变更控制

rubric 版本、维度、权重、硬门槛、pairwise 判定阈值和偏好上限构成一个冻结单元。任何修改都必须升版本，并在不知道测试 oracle 的条件下完成。离线验收时先冻结输出，再由另一个独立进程读取 oracle 计算 Precision@K、Recall@K、F1、Jaccard 和 exact overlap；严禁用 oracle 调整本轮权重、prompt、排序或替换结果。

远程 VLM 评估仅允许传输去 EXIF、匿名文件名、限制尺寸的缩略图；图像和结果不得公网发布。原图只读，导出和代码发布分别需要明确确认。每项评分应使用幂等键并写入 checkpoint，以便中断恢复而不重复调用或计费。
