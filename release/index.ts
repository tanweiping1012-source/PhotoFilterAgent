import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Config as ToolConfig } from '../agent-v4/src/index.ts'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const data = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'photofilter')
export const name = 'photofilter'
export const Config = z.object({
  allowedRoots: z.array(z.string()).default([]),
  allowedExportRoots: z.array(z.string()).default([]),
  python: z.string().default(join(data, 'venv', 'bin', 'python')),
  engineBinary: z.string().default(join(data, 'engine', 'release', 'photofilter')),
  rankerDir: z.string().default(join(root, 'ranker')),
  workdir: z.string().default(join(data, 'state')),
  cacheDir: z.string().default(join(data, 'cache')),
  excludedRelativePaths: z.array(z.string()).default([]),
  stage2Vlm: z.boolean().default(false),
  stage3Vlm: z.boolean().default(false),
  defaultTarget: z.number().min(1).step(1).default(20),
  rankerTimeoutMs: z.number().min(10000).default(1800000),
  anchorsFile: z.string().default(''),
  rubricFile: z.string().default(''),
  stage3AnchorsFile: z.string().default(''),
  stage3RubricFile: z.string().default(''),
})
const persona = `你是 PhotoFilter 照片初筛助手。只处理用户指定且已授权的目录。
先 scan_folder，再 rank_photos，然后如实解释工具返回的名单、限制和实际调用次数。
默认使用本地排序，阶段 2 和阶段 3 视觉复核默认关闭；对话模型本身仍可能收费。
开启视觉复核后会把去元数据的派生图片发给当前会话模型，必须先告知用户。
不要把初筛说成已经达到用户审美，不要编造效果或调用数。
用户要求导出时先调用 export_selection 获取确认码，等用户回复后再提交该码；绝不编造。
新会话或重启后须重新扫描、排序；旧导出确认码不会恢复。原图只读，导出只复制。`

export default class PhotoFilter {
  static inject = ['agentPresets']
  static Config = Config
  constructor(private ctx: Context, private config: any) {}
  async *[Service.init]() {
    const registry = this.ctx.get('agentPresets') as any
    yield await registry.register({
      id: 'photo-filter-v4', name: 'PhotoFilter',
      description: '本地照片初筛 · 视觉复核默认关闭 · macOS 14+',
      plugins: [
        { id: 'photofilter-persona', name: '@deepseek-ai/dsh-persona', config: { prefix: persona, complete: true, includeRuntimeContext: false } },
        { id: 'photofilter-tools', name: '@photo-filter-agent/dsh-photo-filter-v4/tools', config: ToolConfig(this.config) },
      ],
    })
  }
}
