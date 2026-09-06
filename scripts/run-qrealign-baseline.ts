#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { PhotoEngine, type Candidate } from '../agent/src/engine.ts'
import { LOCAL_PORTRAIT_GATE_VERSION, localPortraitEligible } from '../agent/src/local-eligibility.ts'

const MODEL_REVISION = 'fe1f45a7574c9e9d908875af9f7e90cb946aa19f'
const MODEL_WEIGHT_SHA256 = 'bde34df0375fff90d2dee716a127039c57d310c0c868b9f52f4fc2d1ead34aac'
const EXPERIMENT_VERSION = 'qrealign-candidate-baseline-v1'
const PREVIEW_DETAIL = 'standard' as const
const SCORER_SCRIPT = fileURLToPath(new URL('../experiments/qrealign/qrealign_server.py', import.meta.url))
const runFile = promisify(execFile)

type Args = Record<string, string>

function parseArgs(argv: string[]): Args {
  const result: Args = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined) throw new Error(`invalid argument near ${key ?? '<end>'}`)
    result[key.slice(2)] = value
  }
  return result
}

async function requireWithin(path: string, root: string): Promise<string> {
  if (!isAbsolute(path) || !isAbsolute(root)) throw new Error('folder and allowed-root must be absolute')
  const [resolvedPath, resolvedRoot] = await Promise.all([realpath(path), realpath(root)])
  const rest = relative(resolvedRoot, resolvedPath)
  if (rest.startsWith('..') || isAbsolute(rest)) throw new Error('folder is outside allowed-root')
  return resolvedPath
}

function seededCandidates(candidates: Candidate[], fingerprint: string, limit?: number): Candidate[] {
  const ordered = [...candidates].sort((left, right) => {
    const digest = (id: string) => createHash('sha256')
      .update(`${EXPERIMENT_VERSION}\u0000${fingerprint}\u0000${id}`)
      .digest('hex')
    return digest(left.id).localeCompare(digest(right.id)) || left.id.localeCompare(right.id)
  })
  return limit === undefined ? ordered : ordered.slice(0, limit)
}

function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string,
  onTimeout: () => void,
): Promise<T> {
  return new Promise<T>((resolveValue, reject) => {
    const timer = setTimeout(() => {
      onTimeout()
      reject(new Error(message))
    }, milliseconds)
    promise.then(
      value => {
        clearTimeout(timer)
        resolveValue(value)
      },
      error => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

async function main(): Promise<void> {
  const analysisStartedAt = performance.now()
  const args = parseArgs(process.argv.slice(2))
  const required = ['folder', 'allowed-root', 'engine-binary', 'engine-workdir', 'model-dir', 'python', 'output']
  for (const name of required) if (!args[name]) throw new Error(`missing --${name}`)
  const folder = await requireWithin(args.folder, args['allowed-root'])
  const modelDir = await realpath(args['model-dir'])
  const repeats = Number(args.repeats ?? '1')
  const target = Number(args.target ?? '20')
  const sampleLimit = args['sample-limit'] === undefined ? undefined : Number(args['sample-limit'])
  const scoreTimeoutSeconds = Number(args['score-timeout-seconds'] ?? '180')
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 5) throw new Error('repeats must be 1..5')
  if (!Number.isInteger(target) || target < 1) throw new Error('target must be positive')
  if (sampleLimit !== undefined && (!Number.isInteger(sampleLimit) || sampleLimit < target)) {
    throw new Error('sample-limit must be an integer >= target')
  }
  if (!Number.isInteger(scoreTimeoutSeconds) || scoreTimeoutSeconds < 10 || scoreTimeoutSeconds > 600) {
    throw new Error('score-timeout-seconds must be an integer in 10..600')
  }

  const scorerArgs = [
    SCORER_SCRIPT,
    '--model-dir', modelDir,
    '--model-revision', MODEL_REVISION,
    '--task', 'aesthetics',
    '--device', args.device ?? 'cpu',
    '--dtype', args.dtype ?? 'auto',
  ]
  const scorerEnv = {
    ...process.env,
    HF_HUB_DISABLE_PROGRESS_BARS: '1',
    TRANSFORMERS_VERBOSITY: 'error',
  }
  const preflight = await runFile(args.python, [...scorerArgs, '--preflight-only'], {
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
    env: scorerEnv,
  })
  const preflightResult = JSON.parse(preflight.stdout.trim()) as Record<string, unknown>
  if (preflightResult.type !== 'preflight' || preflightResult.available !== true) {
    throw new Error(`Q-ReAlign device preflight failed: ${preflight.stdout.trim()}`)
  }

  const engine = new PhotoEngine(args['engine-binary'], args['engine-workdir'])
  const report = await engine.analyze(folder, undefined, undefined, ['me-pick'])
  const localAnalysisSeconds = (performance.now() - analysisStartedAt) / 1000
  const eligible = report.candidates.filter(localPortraitEligible)
  const candidates = seededCandidates(eligible, report.dataset_fingerprint, sampleLimit)
  if (candidates.length < target) throw new Error(`only ${candidates.length} locally eligible candidates for K=${target}`)

  const startedAt = performance.now()
  const child = spawn(args.python, scorerArgs, {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: scorerEnv,
  })
  const lines = createInterface({ input: child.stdout })
  const stopChild = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  }
  process.once('exit', stopChild)
  const queue: Array<{
    resolve: (value: Record<string, unknown>) => void
    reject: (error: Error) => void
  }> = []
  let terminalError: Error | undefined
  lines.on('line', line => queue.shift()?.resolve(JSON.parse(line) as Record<string, unknown>))
  child.on('error', error => {
    terminalError = error
    while (queue.length) queue.shift()!.reject(error)
  })
  child.on('exit', (code, signal) => {
    if (code === 0) return
    terminalError = new Error(`Q-ReAlign scorer exited code=${code ?? 'null'} signal=${signal ?? 'none'}`)
    while (queue.length) queue.shift()!.reject(terminalError)
  })
  const childExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolveExit => {
    child.once('exit', (code, signal) => resolveExit({ code, signal }))
  })
  const next = () => terminalError
    ? Promise.reject(terminalError)
    : new Promise<Record<string, unknown>>((resolveLine, reject) =>
        queue.push({ resolve: resolveLine, reject }))
  const ready = await withTimeout(next(), 360_000, 'Q-ReAlign model load timed out after 360 seconds', stopChild)
  if (ready.type !== 'ready') throw new Error(`scorer did not become ready: ${JSON.stringify(ready)}`)
  const modelLoadSeconds = (performance.now() - startedAt) / 1000

  const runs: Record<string, number>[] = []
  const previews = new Map<string, string>()
  const inferenceStartedAt = performance.now()
  const totalScores = candidates.length * repeats
  let completedScores = 0
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    const scores: Record<string, number> = {}
    for (const candidate of candidates) {
      let jpegBase64 = previews.get(candidate.id)
      if (!jpegBase64) {
        jpegBase64 = (await engine.preview(candidate.id, PREVIEW_DETAIL)).jpeg_base64
        previews.set(candidate.id, jpegBase64)
      }
      const responsePromise = next()
      child.stdin.write(`${JSON.stringify({ id: candidate.id, jpeg_base64: jpegBase64 })}\n`)
      const response = await withTimeout(
        responsePromise,
        scoreTimeoutSeconds * 1000,
        `Q-ReAlign score timed out at anonymous item ${completedScores + 1}/${totalScores}`,
        stopChild,
      )
      if (response.type !== 'score' || response.id !== candidate.id || typeof response.score !== 'number') {
        throw new Error(`local scorer failed for ${candidate.id}: ${JSON.stringify(response)}`)
      }
      scores[candidate.id] = response.score
      completedScores += 1
      console.error(JSON.stringify({
        type: 'qrealign_progress',
        completed: completedScores,
        total: totalScores,
        repeat: repeat + 1,
        repeats,
      }))
    }
    runs.push(scores)
  }
  child.stdin.end()
  const exited = await childExit
  if (exited.code !== 0) throw terminalError ?? new Error(`Q-ReAlign scorer exited with ${exited.code}`)
  process.removeListener('exit', stopChild)
  const inferenceSeconds = (performance.now() - inferenceStartedAt) / 1000

  let maxAbsoluteDelta = 0
  for (const candidate of candidates) {
    const values = runs.map(run => run[candidate.id])
    maxAbsoluteDelta = Math.max(maxAbsoluteDelta, Math.max(...values) - Math.min(...values))
  }
  const ranked = Object.entries(runs[0])
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
  const topK = ranked.slice(0, target).map(([id]) => id)
  const topKSets = runs.map(run => new Set(Object.entries(run)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, target).map(([id]) => id)))
  const minimumTopKOverlap = Math.min(...topKSets.map(set => topK.filter(id => set.has(id)).length))
  const identity = ready.identity as Record<string, unknown>
  const protocolHash = createHash('sha256').update(JSON.stringify({
    experiment: EXPERIMENT_VERSION,
    identity,
    modelWeightSha256: MODEL_WEIGHT_SHA256,
    localGate: LOCAL_PORTRAIT_GATE_VERSION,
    previewDetail: PREVIEW_DETAIL,
    dataset: report.dataset_fingerprint,
    target,
  })).digest('hex')
  const artifact = {
    schema_version: EXPERIMENT_VERSION,
    dataset_fingerprint: report.dataset_fingerprint,
    candidate_count: candidates.length,
    locally_rejected_count: report.candidates.length - eligible.length,
    target,
    repeats,
    identity,
    model_weight_sha256: MODEL_WEIGHT_SHA256,
    preview_detail: PREVIEW_DETAIL,
    score_timeout_seconds: scoreTimeoutSeconds,
    local_gate_version: LOCAL_PORTRAIT_GATE_VERSION,
    protocol_hash: protocolHash,
    timing: {
      local_analysis_seconds: Number(localAnalysisSeconds.toFixed(3)),
      model_load_seconds: Number(modelLoadSeconds.toFixed(3)),
      inference_seconds: Number(inferenceSeconds.toFixed(3)),
      seconds_per_score: Number((inferenceSeconds / (candidates.length * repeats)).toFixed(3)),
    },
    stability: {
      max_absolute_delta: maxAbsoluteDelta,
      minimum_top_k_overlap: minimumTopKOverlap,
    },
    scores: runs[0],
    score_runs: runs,
    top_k: topK,
  }
  await mkdir(dirname(resolve(args.output)), { recursive: true })
  await writeFile(args.output, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  console.log(JSON.stringify({
    dataset_fingerprint: report.dataset_fingerprint,
    candidate_count: candidates.length,
    target,
    repeats,
    protocol_hash: protocolHash,
    stability: artifact.stability,
    output: args.output,
  }, null, 2))
}

await main()
