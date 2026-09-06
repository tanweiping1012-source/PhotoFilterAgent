import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('Q-ReAlign experiment pins model revision and refuses remote model loading', async () => {
  const [server, runner] = await Promise.all([
    readFile(new URL('../../experiments/qrealign/qrealign_server.py', import.meta.url), 'utf8'),
    readFile(new URL('../../scripts/run-qrealign-baseline.ts', import.meta.url), 'utf8'),
  ])
  assert.match(server, /local_files_only=True/u)
  assert.match(server, /torch\.use_deterministic_algorithms\(True\)/u)
  assert.match(server, /--preflight-only/u)
  assert.match(runner, /fe1f45a7574c9e9d908875af9f7e90cb946aa19f/u)
  assert.match(runner, /bde34df0375fff90d2dee716a127039c57d310c0c868b9f52f4fc2d1ead34aac/u)
  assert.match(runner, /engine\.analyze\(folder, undefined, undefined, \['me-pick'\]\)/u)
  assert.match(runner, /previewDetail: PREVIEW_DETAIL/u)
  assert.match(runner, /score timed out at anonymous item/u)
  assert.match(runner, /qrealign_progress/u)
  assert.ok(runner.indexOf("'--preflight-only'") < runner.indexOf('engine.analyze'))
  assert.doesNotMatch(server, /https?:\/\//u)
})

test('Q-ReAlign artifact contains no photo path or filename fields', async () => {
  const runner = await readFile(new URL('../../scripts/run-qrealign-baseline.ts', import.meta.url), 'utf8')
  assert.match(runner, /dataset_fingerprint/u)
  assert.match(runner, /scores: runs\[0\]/u)
  assert.match(runner, /score_runs: runs/u)
  assert.match(runner, /local_analysis_seconds/u)
  assert.doesNotMatch(runner, /original_path|filename|relative_path/u)
})
