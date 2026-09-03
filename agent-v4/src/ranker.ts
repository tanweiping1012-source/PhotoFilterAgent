/**
 * Python 排序器的进程桥。
 *
 * 为什么排序核心是 Python：它依赖 CLIP 和 pyiqa，这两个只有 Python 生态里有成熟实现。
 * 为什么不把结果算在 TypeScript 里：排序必须是**确定性**的单一实现，
 * 有两份实现就有两份行为，v3 的教训之一就是同一件事散落在多处。
 * @module
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface RankNotes {
  warnings?: string[]
  label_concentration?: number | null
  cold_strategy?: string
  face_detect_rate?: number
  /** 这一轮用的挑片风格：quality（拍得清楚好看）/ mood（有氛围）。 */
  style?: string
  n_families?: number
  largest_family?: number
  family_threshold?: number
  family_cap_used?: number
  relaxed?: number
  near_duplicate_pairs?: number
  labels_used?: string[]
  labels_pinned?: string[]
  /** 资格门拦下的闭眼照。免费本地检测，见 ranker/photofilter_rank/eligibility.py。 */
  blocked_closed_eyes?: string[]
  n_blocked?: number
  device?: string
}

export interface RankResult {
  selected: string[]
  ranking: string[]
  scores: Record<string, number>
  families: Record<string, number>
  mode: string
  n_labels: number
  fingerprint: string
  n_candidates: number
  elapsed_sec: number
  notes: RankNotes
}

export interface ScanResult {
  n_photos: number
  fingerprint: string
  folder: string
  names: string[]
}

export interface EvalResult {
  auc: number
  hits: number
  k: number
  n_total: number
  n_gold: number
  random_expected: number
  p_value: number
  lift_mean: number
  /** 产品**真正交付**的那份名单里命中了几张。这是要报给用户的主指标。 */
  delivered_hits: number
  delivered_n: number
  delivered_p_value: number
  mode: string
  notes: RankNotes
  selected: string[]
  elapsed_sec: number
  excluded_trained: string[]
}

/** 排序器进程失败时抛这个，携带 stderr 尾部，便于把真实原因报给用户而不是猜。 */
export class RankerError extends Error {
  constructor(message: string, readonly detail: string) {
    super(message)
    this.name = 'RankerError'
  }
}

export class Ranker {
  constructor(
    private readonly python: string,
    private readonly rankerDir: string,
    private readonly cacheDir: string,
    private readonly timeoutMs: number,
    /** Swift 本地分析引擎，用于闭眼资格门。空则资格门不生效，排序器会如实报告。 */
    private readonly engineBinary?: string,
  ) {}

  /** 资格门参数。不给引擎时不加 --engine，排序器会把「没生效」写进 warnings。 */
  private gate(): string[] {
    return this.engineBinary ? ['--engine', this.engineBinary] : []
  }

  private run(args: string[], signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.python, ['-m', 'photofilter_rank.cli', ...args], {
        cwd: this.rankerDir,
        env: {
          ...process.env,
          PYTHONPATH: this.rankerDir,
          PHOTOFILTER_CACHE: this.cacheDir,
          PYTHONWARNINGS: 'ignore',
          // 排序器一张照片都不往外发，但仍然显式断网口，让"不联网"是结构保证而不是承诺。
          // 首次运行需要下模型，由 install 阶段完成，运行期不再需要网络。
          HF_HUB_OFFLINE: '1',
          TRANSFORMERS_OFFLINE: '1',
        },
        signal,
      })
      let out = ''
      let err = ''
      child.stdout.on('data', (d) => { out += d })
      child.stderr.on('data', (d) => { err += d })
      const timer = setTimeout(() => child.kill('SIGKILL'), this.timeoutMs)
      child.on('error', (e) => { clearTimeout(timer); reject(new RankerError(`排序器无法启动：${e.message}`, err.slice(-2000))) })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve(out)
        else reject(new RankerError(`排序器退出码 ${code}`, err.slice(-2000) || out.slice(-2000)))
      })
    })
  }

  /** 把 --json 写到临时文件再读回来：stdout 里混着进度输出，不能直接当 JSON 解析。 */
  private async runJson<T>(args: string[], signal?: AbortSignal): Promise<{ value: T; stdout: string }> {
    const dir = mkdtempSync(join(tmpdir(), 'pfv4-'))
    const jsonPath = join(dir, 'out.json')
    try {
      const stdout = await this.run([...args, '--json', jsonPath], signal)
      return { value: JSON.parse(readFileSync(jsonPath, 'utf8')) as T, stdout }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  async scan(folder: string, exclude: string[], signal?: AbortSignal): Promise<ScanResult> {
    const args = ['scan', folder, '--quiet']
    if (exclude.length) args.push('--exclude', ...exclude)
    return (await this.runJson<ScanResult>(args, signal)).value
  }

  /** 给指定照片生成无元数据的 512px base64 小图。原图不出本机。 */
  /**
   * 出小图。`withFace=true` 时额外出一张高清人脸裁切。
   *
   * 512px 的整幅小图上，环境人像的人脸只剩约 30 像素，91% 的照片不足 48 像素 ——
   * 模型判断不了表情。所以凡是要发给视觉模型比较的，都必须带上人脸。
   */
  async preview(
    folder: string, names: string[], exclude: string[], size = 512,
    signal?: AbortSignal, withFace = false,
    /**
     * 把名字烧进图里：{文件名: "例1甲"}。
     *
     * 「这是第几张」用提示词绕了三次都没绕干净（序数指照片还是指图、
     * 加锚点后编号基准被推移、名字仍要模型自己对应到第几幅）。
     * 烧进图里之后模型不用数 —— 图上写着就是谁。
     */
    labelMap?: Record<string, string>,
    /**
     * {文件名: 编码}。**加边**写在图上方，不覆盖画面。
     *
     * 仪器标定和**生产阶段 2** 都用它：JIA/YI 是槽位标签，只按位置作答的模型
     * 也能填满，从答案里分辨不出来；把码抄回来，答案才指向具体那张照片。
     *
     * 和 labelMap 是两回事，不要合并：labelMap 盖在画面上（锚点用，锚点不参与判断），
     * codeMap 必须加边（参与判断的图，压住画面就分不清「判断」和「被挡住了」）。
     */
    codeMap?: Record<string, string>,
    /** 仪器标定专用：JPEG 质量下调 N 档，出一份肉眼无差、字节不同的副本（δ 条件）。 */
    qualityDelta = 0,
    /** 仪器标定专用：高斯模糊半径，造一个明显更差的副本做正对照。 */
    degrade = 0,
  ): Promise<{ previews: Record<string, string>; faces: Record<string, string>; missing: string[] }> {
    const args = ['preview', folder, '--names', ...names, '--size', String(size), ...this.gate()]
    if (withFace) args.push('--with-face')
    let labelFile: string | undefined
    if (labelMap && Object.keys(labelMap).length) {
      labelFile = join(mkdtempSync(join(tmpdir(), 'pfv4-lbl-')), 'labels.json')
      writeFileSync(labelFile, JSON.stringify(labelMap))
      args.push('--label-map', labelFile)
    }
    if (codeMap && Object.keys(codeMap).length) {
      const f = join(mkdtempSync(join(tmpdir(), 'pfv4-code-')), 'codes.json')
      writeFileSync(f, JSON.stringify(codeMap))
      args.push('--code-map', f)
    }
    if (qualityDelta > 0) args.push('--quality-delta', String(qualityDelta))
    if (degrade > 0) args.push('--degrade', String(degrade))
    if (exclude.length) args.push('--exclude', ...exclude)
    const v = (await this.runJson<{
      previews: Record<string, string>; faces?: Record<string, string>; missing: string[]
    }>(args, signal)).value
    return { previews: v.previews, faces: v.faces ?? {}, missing: v.missing }
  }

  async rank(
    folder: string, target: number, exclude: string[], labels: string[],
    style: string, signal?: AbortSignal,
    /**
     * VLM 复核的裁决文件。给了就用回放裁判重出名单。
     *
     * 为什么要绕这一圈：擂台赛跑在 Python 侧，视觉模型跑在这一侧（TS）。
     * 所以流程是「排序器出复核计划 → 这里跑模型 → 裁决写文件 → 排序器重放」。
     */
    verdictsFile?: string,
  ): Promise<RankResult> {
    const dir = mkdtempSync(join(tmpdir(), 'pfv4-lbl-'))
    try {
      const args = ['pick', folder, '--target', String(target), '--style', style, ...this.gate()]
      if (exclude.length) args.push('--exclude', ...exclude)
      if (labels.length) {
        const p = join(dir, 'labels.txt')
        writeFileSync(p, labels.join('\n'))
        args.push('--labels', p)
      }
      if (verdictsFile) args.push('--verdicts', verdictsFile)
      return (await this.runJson<RankResult>(args, signal)).value
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  async evaluate(
    folder: string, target: number, exclude: string[], labels: string[], goldFile: string,
    signal?: AbortSignal,
  ): Promise<EvalResult> {
    const dir = mkdtempSync(join(tmpdir(), 'pfv4-lbl-'))
    try {
      const args = ['eval', folder, '--gold', goldFile, '--target', String(target), ...this.gate()]
      if (exclude.length) args.push('--exclude', ...exclude)
      if (labels.length) {
        const p = join(dir, 'labels.txt')
        writeFileSync(p, labels.join('\n'))
        args.push('--labels', p)
      }
      return (await this.runJson<EvalResult>(args, signal)).value
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}
