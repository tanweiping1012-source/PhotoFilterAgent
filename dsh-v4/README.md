# agent 在 DeepSeek Harness 里的配置

这里说明 agent 装进 DSH 之后长什么样、常改的配置在哪、怎么换模型、DSH 版本升级要注意什么。只想装好用起来，看 [README 的「快速上手」](../README.md#快速上手)；想看代码结构，看[给开发者的说明](../docs/DEVELOPER.md)。

## DSH 版本

本项目在 **DSH 0.2.0-rc.2**（2026-09-29 发布的预览版，npm 上的 `latest`）上验证。`install.sh` 会克隆这个版本（tag `dsh-v0.2.0-rc.2`），不跟着 master 走：DSH 还在预览期，版本之间有破坏性变更。如果 `~/deepseek-harness` 里已经有一份别的版本，`install.sh` 会停下来告诉你怎么办，不会动它。

## 装好之后有什么

`install.sh` 把所有东西装进 `DSH_HOME`（默认 `~/.dsh-photo-filter`）。DSH 的全部状态都在这个目录下，和你别的 DSH 用法互不影响。

```
~/.dsh-photo-filter/
  profiles/photo-v4/            web 界面用的 profile
  profiles/photo-v4-headless/   命令行一次性任务用的 profile
  ranker-venv/                  排序器的 Python 环境
  photo-filter-v4/              匿名编号对照表、每次运行的记录（runs/）
  .credentials.yaml             在网页「设置 → 模型」里填的 API Key（DSH 自己管，不进仓库）
  sessions/ …                   DSH 的会话记录
```

排序器的缩略图与特征缓存放在 `~/.cache/photofilter-rank`，可以随时删，删了下次重建。

## 两个 profile

| | `photo-v4` | `photo-v4-headless` |
|---|---|---|
| 用法 | `pnpm dsh --profile photo-v4`，浏览器里对话 | `pnpm dsh --profile photo-v4-headless "任务"`，跑完就退出 |
| 人设写在哪 | profile 里 `preset-photo-filter-v4` 那一条的 `persona` | profile 里 `system-prompt` 的 `personaPrefix` |
| 插件配置写在哪 | 同一个 preset 的 `plugins` 里 `photo-filter-v4` 那一条 | profile 顶层 `photo-filter-v4` 那一条 |

两份人设逐字相同，改一份就要同步另一份（`ranker/tests/test_repo_hygiene.py` 会核）。web 版的插件配置**只有 preset 里那一份**：DSH 0.1 时 preset 和 profile 各有一份，web 会话只认 preset 那份，曾经因此白跑过 121 次调用。

两个 profile 都关掉了 DSH 自带的通用工具（shell、文件读写、网页、子 agent、工作流等），模型只看得到 7 个照片工具。原因是通用工具能绕过「只发剥掉元数据的小图」这条约束：`read_image` 能把原图（全分辨率、带 EXIF 与 GPS）直接读进对话，`glob` / `grep` 会泄露真实文件名。web 版还关掉了 DSH 自带的四个 preset，免得误选一个带 shell 的。

## 常改的配置

改仓库里的模板（`profiles/<名字>/cordis.patch.yml`），再装一次、重启 DSH：

```bash
PHOTOS=~/Pictures/我的旅行照片 bash dsh-v4/sync-config.sh push
```

也可以直接改 `$DSH_HOME/profiles/<名字>/cordis.patch.yml`，改完用 `sync-config.sh pull` 同步回仓库。注意 `push` 会整份覆盖部署的 profile，你在网页设置里改过的界面选项（比如关掉「预览版说明」）会回到默认。

| 配置项 | 默认 | 说明 |
|---|---|---|
| `allowedRoots` | 安装时的 `PHOTOS` | agent 只能处理这些目录里的照片，别的目录直接拒绝 |
| `allowedExportRoots` | `~/Downloads` | 只能把照片复制到这些目录下；安装时用 `EXPORT_ROOT` 改 |
| `defaultTarget` | 20 | 用户没说挑几张时挑几张 |
| `stage2Vlm` | `false` | 阶段 2 是否请视觉模型复核。默认关：实测没让结果变好（同一批 299 张，开着跑 5 次得 7·5·7·7·6，纯本地 7），却每次多花约 120 次调用、10 分钟。打开后按组从大到小逐组打擂台，最多 60 局，名单每次会不同 |
| `stage3Vlm` | `false` | 阶段 3 是否请视觉模型复核，见下面 |
| `anchorsFile` | `$DSH_HOME/anchors.json` | 可选的范例照片，见下面。文件不存在就不用 |
| `excludedRelativePaths` | 作者的答案目录 | 扫描时跳过的子目录。作者用它把自己挑的「标准答案」挡在候选池外；你的照片里没有这些目录就不起作用 |

全部配置项及其含义在 `agent-v4/src/index.ts` 的 `Config` 注释里。

### 阶段 3 视觉复核（默认关）

第三步挑完之后，可以让视觉模型在每个时间段里比一次「已入选 vs 候补」，候补正反两次都赢才换人。**实测没有把名单变好**：2026-09-28 的端到端 A/B（四组各 5 次）三种配置都有把精选换下去的情况，测不出它有用，加标准、加范例也测不出区别，所以默认关。数据见[端到端 A/B 报告](ab-experiment/stage3/REPORT-E2E.md)。想自己试，在插件配置里加：

```yaml
stage3Vlm: true
# 可选：阶段 3 自己的判据与范例，和阶段 2 的 rubricFile / anchorsFile 是两份
stage3RubricFile: /path/to/你的判据.txt
stage3AnchorsFile: /path/to/你的范例.json   # 格式同 anchors-default.json；配了却读不出来会直接报错
```

每次运行多花约 21 次调用（10 局 × 正反两次 + 1 次预检）。

### 范例照片（锚点）：不需要

锚点是「这个人以前怎么挑的」几组示例照片，阶段 2 复核时连同说明一起给裁判看。**你不需要提供**：实测给不给范例，交出来的照片完全一样（[第二步 A/B 报告](ab-experiment/REPORT-RUBRIC-ANCHORS.md)）。

仓库里的 `anchors-default.json` 是作者本人的范例，指向作者自己的照片。`sync-config.sh push` 会逐张核这些照片在不在本机：都在才装成 `$DSH_HOME/anchors.json`，否则不装（以前装过的改名为 `anchors.json.disabled`）。所以别人装的时候不会有锚点，阶段 2 照常运行。

## 换模型

默认模型是 MiniMax-M3（`minimax-cn` 提供方），配置在 profile 的 `llm-pi-ai` 与 `agent-default-model` 两条里。对话用这个模型；打开视觉复核时，裁判也用它，那时**它必须能看图**，不能看图的话会在预检时停下、退回本地排序，并在结果里说明。视觉复核默认关，所以只聊天的话，不能看图的模型也行。本项目的全部实验都是在 MiniMax-M3 上做的，换了模型，实验里的数字就不适用了。

换法：在网页「设置 → 模型」里添加提供方、填 Key，再在对话框右下角选模型；或者改 profile 里那两条（写法见 DSH 的 `packages/llm/llm-pi-ai` 说明）。

## 占位符

仓库里的 profile 模板用占位符代替本机路径，`sync-config.sh push` 装的时候替换，`pull` 的时候换回去：

| 占位符 | 换成 | 由谁给 |
|---|---|---|
| `@@REPO@@` | 这个仓库的绝对路径 | 脚本自动取 |
| `@@DSH_HOME@@` | agent 的 DSH home | `DSH_HOME`，默认 `~/.dsh-photo-filter` |
| `@@CACHE@@` | 排序器缓存目录 | `CACHE`，默认 `~/.cache/photofilter-rank` |
| `@@PHOTOS@@` | 允许处理的照片根目录 | `PHOTOS`，必填 |
| `@@EXPORT@@` | 允许导出到的目录 | `EXPORT_ROOT`，默认 `~/Downloads` |
| `@@SCRATCH@@` | 评测考题与结果的中间目录（只有实验 profile 用） | `SCRATCH` |

`sync-config.sh` 和 `doctor.sh` 用同一张表。漏替一个占位符，`doctor.sh` 就会报「不一致」。

## 自检

```bash
bash dsh-v4/doctor.sh
```

逐层核对：DSH 加载的插件是不是仓库这份、Swift 引擎是不是最新编译的、部署的 profile 和仓库模板对不对得上（只比模板里写了的条目，DSH 或网页设置自己加的条目不算）、锚点照片齐不齐、DSH 启动之后代码有没有再改。

## 复现以前的实验

`ab-experiment/` 里的实验脚本是 DSH 0.1 时期写的。第四轮端到端 A/B 的 `stage3/e2e/make_e2e_profiles.py` 读的是 `~/.dsh-v4` 里 0.1 格式的 `photo-v4`，还要求它的 `stage2Vlm` 是 `true`（第四轮四组第二步全开）；对不上会直接报错停下。所以别把现在的模板装进 `~/.dsh-v4`：现在的模板是 0.2 格式，而且视觉复核默认关。复现时用当时的配置：作者机器上的 `~/.dsh-v4/photo-filter-v4/archive/round4-e2e/` 存着实验期间的 preset 原件（`preset-during-e2e.agent.cordis.yml`），每次改动的 md5 记在同目录的 `preset-md5-log.tsv`。

## 从 DSH 0.1 迁到 0.2 改了什么

以前按 0.1 装过的，重跑一次 `install.sh`：它装进新的 `DSH_HOME`，不动旧的；`~/deepseek-harness` 还是旧版的话，它会停下来提示你换个目录（`HARNESS=~/dsh-0.2 ./install.sh`）或把那份切到新版本。改动如下，升级 DSH 时可以对照：

- **preset 写进 profile**。0.2 不再读 `$DSH_HOME/.agent-presets/`，改为在 profile 里声明 `@deepseek-ai/dsh-agent-preset` 条目，并用 `agent-preset-registry` 的 `default` 指定默认 preset。
- **人设的键改名**：`dsh-persona` 的 `text` → `prefix`；`system-prompt` 的 `persona` → `personaPrefix`。
- **没有 `settings.yaml` 了**：模型提供方写在 profile 的 `llm-pi-ai` 条目里，默认模型写在 `agent-default-model` 条目里。
- **插件要作为 profile 的依赖安装**：profile 的 `package.json` 里写 `link:` 依赖，在 profile 目录里 `pnpm install`。0.2 不再给手工软链进来的插件解析 `@deepseek-ai/*`。插件在 `peerDependencies` 里声明支持的 DSH 版本范围。
- **插件源码按 Node 原生方式加载**：不支持参数属性（`constructor(private x: string)`）等需要编译的 TypeScript 写法。
- **新增的内置工具要关掉**：`tool-pwsh`、`tool-jobs`、`tool-skill`、`plan-mode`、子 agent 与工作流、`tool-todo`、`tool-goal`；`tool-str-replace-editor` 在 0.2 里已经没有了。
- **网页设置会写回 profile**：DSH 会把界面选项写进 `cordis.patch.yml` 并重新排版整个文件，所以 `doctor.sh` 改为按条目比较，不再逐字节比较。
