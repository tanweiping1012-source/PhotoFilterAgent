# 把 v4 装进 DeepSeek Harness

这里是 v4 agent 的 DSH 配置模板。复制到你自己的 `$DSH_HOME` 就能跑。

## 为什么要用独立的 DSH_HOME

DSH 的全部状态 —— profiles、presets、sessions、凭据、缓存 —— 都在 `$DSH_HOME` 下，
默认 `~/.dsh`。换一个 home 就能和别的版本完全隔离，互不干扰：

```
~/.dsh       v3（视觉模型打分那版）
~/.dsh-v4    v4（本地排序那版）
```

harness 的代码本身是只读共享的，两边都不改它。

## 装

```bash
# 一条命令搞定：harness、Swift 引擎、Python 环境、profile、preset、插件软链
PHOTOS=~/Desktop/你的照片目录 ./install.sh
```

`install.sh` 是幂等的，重复跑只补缺的部分。它内部调用：

```bash
DSH_HOME=~/.dsh-v4 PHOTOS=~/Desktop/你的照片目录 ./dsh-v4/sync-config.sh push
```

这一步把仓库里的模板装进 `$DSH_HOME`，同时替换占位符。**反向也能跑**：

```bash
./dsh-v4/sync-config.sh pull      # 改了 $DSH_HOME 里的配置，同步回仓库
```

> 以前这里写的是 `cp -R` 加一段手写 `sed`。那正是漂移的来源 ——
> 五个 profile 里只有三个进过仓库，其中 `photo-v4-ab` 那份还带着
> `/Users/…` 的绝对路径推到了公开仓库，另外两个（eval / eval-web）
> 仓库里根本没有，等于整轮 AB 实验无法从克隆复现。
> 现在只有一个脚本、一套占位符，`doctor.sh` 第 3/3b 项会持续核对两边是否一致。

模型路由另外配一份（**不含密钥**，只有环境变量名）：

```bash
cp dsh-v4/settings.example.yaml ~/.dsh-v4/settings.yaml
```

密钥不进仓库，二选一：`export MINIMAX_CN_API_KEY=…`，
或写进 `~/.dsh-v4/.credentials.yaml`（`chmod 600`）。

## 占位符

| 占位符 | 换成 | 装的时候由谁给 |
|---|---|---|
| `@@REPO@@` | 这个仓库的绝对路径 | 脚本自动取 |
| `@@DSH_HOME@@` | 隔离的 DSH home | `DSH_HOME`，默认 `~/.dsh-v4` |
| `@@CACHE@@` | 排序器缓存目录（放降采样图和向量，可随时删） | `CACHE` |
| `@@PHOTOS@@` | 允许处理的照片根目录 | `PHOTOS` |
| `@@EXPORT@@` | 允许导出到的目录；留空则禁止导出 | `EXPORT_ROOT`，默认 `~/Downloads` |
| `@@SCRATCH@@` | 评测考题与结果的中间目录 | `SCRATCH` |

**这一套词汇是唯一的一套。** `sync-config.sh` 和 `doctor.sh` 用的是同一张表，
别再发明第二套 —— 漏替一个占位符，`doctor.sh` 就会假报「不一致」。

`allowedRoots` 和 `allowedExportRoots` 是**结构约束** ——
不在范围内的目录，工具会直接拒绝，不靠 agent 自觉。

## 跑

```bash
cd /path/to/deepseek-harness

# Web 界面
DSH_HOME=~/.dsh-v4 pnpm dsh --profile photo-v4
# 浏览器打开 http://127.0.0.1:3080，会话里选 "Photo Filter v4" preset

# 一次性任务（本项目的验证跑的就是这个）
DSH_HOME=~/.dsh-v4 pnpm dsh --profile photo-v4-headless "从 <目录> 挑 20 张最好的人像"
```

## 两个 profile 的差别

`photo-v4` 用 `dsh-web-app` bundle，persona 从 preset 加载。
`photo-v4-headless` 用 `dsh-headless` bundle，**persona 直接覆盖 `system-prompt` 的 persona 字段** ——
因为 headless 没有 preset 选择机制，而用 `@deepseek-ai/dsh-persona` 插件会和 base 的
`system-prompt` 抢同一个 `deployment:persona` section，启动直接报错。

## 关掉的工具，以及为什么

profile 里禁用了 `tool-bash` / `tool-fs` / `tool-fs-search` / `skill-filesystem` /
`tool-str-replace-editor` / `tool-web`。

v4 的排序链路本身一张照片都不外发，但这些通用工具会绕过这个结构：
`read_image` 把**原图**（全分辨率、带 EXIF 和 GPS）直接读进对话，
`glob`/`grep` 泄露真实文件名。v3 实测模型确实尝试过前两条。

**这是结构约束，不是靠 agent 自觉。**

## 实际跑起来是什么样

四次真实运行的完整记录 —— 包括一次测量错误是怎么被发现和修掉的 ——
见 [V4 在 DSH 上的真实运行](../docs/versions/V4-DSH-RUN-2026-08-30.md)。
