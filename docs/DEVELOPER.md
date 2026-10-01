# 给开发者：这个 agent 是怎么搭起来的

写给第一次打开这个仓库、想看懂或想改它的人。只想用它挑照片，看 [README 的「快速上手」](../README.md#快速上手)就够了。

## 一句话

这是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（下面简称 DSH）的一个**插件**。你在 DSH 里跟一个对话模型聊天，这个模型**自己不看照片**，它只会调用插件提供的 7 个工具；工具在你的电脑上跑一个 Python 排序器挑照片，默认不调任何视觉模型；只有打开「视觉复核」，才会把照片的小图发给一个视觉模型当裁判。

## 四层，从上往下

```
你（浏览器里的 web 界面，或命令行）
  │ 对话
DSH 0.2（DeepSeek Harness）      对话、调模型、调度工具、记会话。本项目不改它的代码
  │ 调工具
agent-v4/（TypeScript 插件）      7 个工具；目录授权检查；匿名编号；阶段 2/3 的视觉对决
  │ 子进程：python -m photofilter_rank.cli …
ranker/（Python 排序器）          缩略图缓存、CLIP 分组、质量分、三个阶段的选片规则
  │ 子进程
engine/（Swift，苹果 Vision 框架）  人脸、睁眼程度、头部俯仰角
```

每一层都能单独跑：`engine` 是一个命令行程序；`ranker` 不需要 DSH 也能用（README 的「只用命令行排序器」）；插件是 DSH 按 profile 配置加载的一个 npm 包。

## 一次「帮我挑 20 张」到底发生了什么

1. **`scan_folder`**：先确认目录在授权范围（`allowedRoots`）里，不在就拒绝。排序器数照片、算数据集指纹、建缩略图缓存；插件给每张照片发一个匿名编号 `p001`、`p002`…，对照表存在 `workdir` 里。**真实文件名不进对话**，模型只见得到编号。
2. **`rank_photos`**：
   1. 排序器在本机跑完三个阶段（原理见 README）：闭眼的挡掉 → 按 CLIP 相似度分组、组内按本地分打擂台 → 按时间段配额选出最终名单。同时给出一份「复核计划」（`pipeline.py` 的 `tournament_plan`）：所有至少两张的组，按组从大到小，逐组要打的擂台局；加下一组就超过 `refine_max_matches`（60）局时停，后面更小的组不打。不按「会不会进名单」挑组，理由见该函数的说明。
   2. **阶段 2 视觉复核**（`stage2Vlm`，默认关）：打开后按复核计划逐局请视觉模型当裁判。每张照片生成 512px 整幅小图 + 448px 人脸特写，剥掉元数据、边上烧一个 4 位随机码；同一对照片正着问一次、反着问一次（`compare.ts`，经 DSH 的 `llm` 服务发出，`harness-vision.ts` 是这层适配）。两次说法一致才算数。裁决写成文件交回排序器重放，得到新名单。
   3. **阶段 3 视觉复核**（`stage3Vlm`，默认关）：每个时间段里「最后一个入选的」和「第一个落选的」比一次，候补正反两次都赢才换人（`stage3.ts`）。实测没有收益，所以默认关。
   4. 每次真调了视觉模型，都在 `workdir/runs/<时间>-<随机串>/` 下留运行记录：`calls.jsonl`（每次调用一行，不含图片和模型原话）、`stage2-verdicts.json`、`run.json`（汇总）。摘要里告诉用户这次花了几次调用。
3. 之后按用户的话调用：`explain_ranking`（为什么选/没选某张）、`set_my_favorites`（只记录，不参与排序——实测没收益）、`evaluate_against_answer`（有人工精选时算命中）、`compare_within_groups`（用户要求时再多比几对）、`export_selection`（把名单**复制**到授权的导出目录，两步确认，原图只读）。

## 目录地图

| 路径 | 是什么 |
|---|---|
| `install.sh` | 从零装好一切：DSH（固定到验证过的版本）、Swift 引擎、Python 环境、profile |
| `release/`、根目录 `package.json` | 另一种装法：打成 DSH 标准插件包（`npm pack` → `dsh plugin add`），自带一个精简人设、视觉复核默认关；CI 在 `.github/workflows/dsh-release.yml` |
| `agent-v4/src/index.ts` | 插件入口：配置项（`Config`，每项有注释）与 7 个工具 |
| `agent-v4/src/ranker.ts` | 调 Python 排序器的子进程封装 |
| `agent-v4/src/compare.ts` | 阶段 2 的成对比较：提示词、正反两问、解析答案 |
| `agent-v4/src/stage3.ts` | 阶段 3 的段内对决 |
| `agent-v4/src/harness-vision.ts` | 把图片和提示词交给 DSH 的 `llm` / `attachments` 服务 |
| `agent-v4/src/identity.ts` · `codes.ts` · `anchors.ts` | 匿名编号 · 烧进图里的 4 位码 · 范例照片齐不齐的检查 |
| `agent-v4/src/pairEval.ts` · `instrument.ts` | 只给实验用的两个评测工具，配了 `evalPairsFile` 才注册，普通用户看不见 |
| `ranker/photofilter_rank/` | 排序器。入口 `cli.py`；`rank.py` / `pipeline.py` 串起三个阶段；`eligibility.py` 闭眼门；`dedupe.py` 分组；`stage2.py` 擂台赛；`stage3.py` 段内对决；`embed.py` CLIP；`quality.py` 质量分；`config.py` 所有阈值 |
| `engine/` | Swift 写的本地分析程序，用苹果 Vision 框架看人脸和眼睛 |
| `profiles/photo-v4/` | web 界面用的 DSH profile（人设 + 插件配置 + 模型 + 关掉的工具） |
| `profiles/photo-v4-headless/` | 命令行一次性任务用的 profile |
| `dsh-v4/sync-config.sh` | 把 `profiles/` 里的模板装进 `$DSH_HOME`（换占位符、链接插件） |
| `dsh-v4/doctor.sh` | 自检：哪一层没装好、装进去的配置和仓库有没有走样 |
| `dsh-v4/ab-experiment/` | 所有实验的预登记判据、报告和数据 |
| `docs/versions/` | 这个工具一版一版怎么演进过来的 |

**旧版本，留作记录，不再维护**：`agent/`、`run.sh`、`profiles/photo/`、`profiles/photo-web/`（v3，让视觉模型给每张打分，实测等于抛硬币）；`bench/`（早期基准）；`profiles/photo-v4-ab/`、`photo-v4-eval/`、`photo-v4-eval-web/`（DSH 0.1 时期的实验 profile，`install.sh` 不装它们，没有迁移到 0.2）。

## 配置：写在哪、改了怎么生效

- 仓库里的 `profiles/<名字>/` 是**模板**，里面的 `@@REPO@@`、`@@PHOTOS@@` 这类占位符在安装时换成本机路径（全表见 [dsh-v4/README.md](../dsh-v4/README.md#占位符)）。
- `dsh-v4/sync-config.sh push` 把模板装进 `$DSH_HOME/profiles/<名字>/`，并在那里 `pnpm install`，把插件以链接方式装进去——改插件源码不用重装，**重启 DSH 就生效**。
- 改了 `$DSH_HOME` 里的配置想同步回仓库：`sync-config.sh pull`。
- **web 版的插件配置只有一份**：在 `profiles/photo-v4/cordis.patch.yml` 的 `preset-photo-filter-v4` 那一条的 `plugins` 里。命令行版在 `profiles/photo-v4-headless/cordis.patch.yml` 的 `photo-filter-v4` 那一条。
- 配置项的含义看 `agent-v4/src/index.ts` 里 `Config` 的注释；没写的键取那里的默认值。

## 跑测试

排序器（纯 Python，十几秒，不需要模型权重）：

```bash
cd ranker && python3 -m pytest tests -q
```

没装排序器环境的话，`pip install numpy Pillow pytest` 就够（CI 也是这么装的）。

插件（类型检查 + 行为测试）。依赖装到一份临时拷贝里，**不要装进 `agent-v4/` 本身**：DSH 从链接加载插件时，插件目录里多出来的一套 `@deepseek-ai/*` 会和 DSH 自己那套打架。

```bash
bash agent-v4/test.sh
```

改了用户或模型看得见的行为，还要真跑一次 agent（`doctor.sh` 先过），看对话里说的和运行记录对不对得上。

## 已知的坑

- DSH 还在预览期，版本之间有破坏性变更。`install.sh` 固定到验证过的版本，升级前先看 [dsh-v4/README.md](../dsh-v4/README.md) 里「从 DSH 0.1 迁到 0.2 改了什么」。
- DSH 0.2 按 Node 原生方式加载插件的 TypeScript 源码，**不支持**参数属性（`constructor(private x: string)`）这类需要编译的语法，写了插件会加载失败。
- 视觉模型的答案本身不稳：同一对照片、输入逐字节相同，重问一遍 62.8% 会改口（[一致性测试报告](../dsh-v4/ab-experiment/VLM-PAIRWISE-REPORT.md)）。改提示词之前先想清楚要怎么测出差别。
