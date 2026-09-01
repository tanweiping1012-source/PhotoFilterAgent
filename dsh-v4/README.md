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
export DSH_HOME=~/.dsh-v4
mkdir -p $DSH_HOME/{profiles,.agent-presets}

# 模型路由与凭据（agent 的对话循环要用；照片排序不用）
cp ~/.dsh/settings.yaml     $DSH_HOME/
cp ~/.dsh/.credentials.yaml $DSH_HOME/ && chmod 600 $DSH_HOME/.credentials.yaml

# 本目录的模板
cp -R dsh-v4/profile-photo-v4          $DSH_HOME/profiles/photo-v4
cp -R dsh-v4/profile-photo-v4-headless $DSH_HOME/profiles/photo-v4-headless
cp -R dsh-v4/preset-photo-filter-v4    $DSH_HOME/.agent-presets/photo-filter-v4

# 插件软链
mkdir -p $DSH_HOME/profiles/node_modules/@photo-filter-agent
ln -sfn "$PWD/agent-v4" \
        $DSH_HOME/profiles/node_modules/@photo-filter-agent/dsh-photo-filter-v4

# Python 环境（排序器要用）
python3 -m venv $DSH_HOME/ranker-venv
$DSH_HOME/ranker-venv/bin/pip install -r ranker/requirements.txt
```

模板里的路径是占位符，装的时候替换掉：

```bash
cd $DSH_HOME
grep -rl '@@' profiles/photo-v4* .agent-presets/photo-filter-v4 | while read f; do
  sed -i '' \
    -e "s|@@REPO@@|/absolute/path/to/PhotoFilterAgent|g" \
    -e "s|@@DSH_HOME@@|$DSH_HOME|g" \
    -e "s|@@CACHE@@|$HOME/.cache/photofilter-rank|g" \
    -e "s|@@PHOTOS@@|/absolute/path/to/your/photos|g" \
    -e "s|@@EXPORT@@|$HOME/Downloads|g" "$f"
done
```

| 占位符 | 换成 |
|---|---|
| `@@REPO@@` | 这个仓库的绝对路径 |
| `@@DSH_HOME@@` | 你的隔离 DSH home |
| `@@CACHE@@` | 排序器缓存目录（放降采样图和向量，可随时删） |
| `@@PHOTOS@@` | 允许处理的照片根目录 |
| `@@EXPORT@@` | 允许导出到的目录；留空则禁止导出 |

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
