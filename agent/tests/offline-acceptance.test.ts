import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  normalizeCredentialObject,
  renderFlatCredentials,
} from '../../scripts/migrate-credentials.mjs'

const presetUrl = new URL('../../presets/photo-curator/agent.cordis.yml', import.meta.url)
const readmeUrl = new URL('../../README.md', import.meta.url)
const profileUrl = new URL('../../profiles/photo/cordis.patch.yml', import.meta.url)
const profileWebUrl = new URL('../../profiles/photo-web/cordis.patch.yml', import.meta.url)
const installUrl = new URL('../../install.sh', import.meta.url)
const indexUrl = new URL('../src/index.ts', import.meta.url)
const harnessVisionUrl = new URL('../src/harness-vision.ts', import.meta.url)
const independentEvaluatorUrl = new URL('../src/independent-evaluator.ts', import.meta.url)
const portraitVisionUrl = new URL('../src/portrait-vision.ts', import.meta.url)
const legacyVisionUrl = new URL('../src/vision.ts', import.meta.url)

test('Photo Curator has no fixed visual provider model endpoint or independent key route', async () => {
  const [preset, readme, independentEvaluator, ...production] = await Promise.all([
    readFile(presetUrl, 'utf8'), readFile(readmeUrl, 'utf8'),
    readFile(independentEvaluatorUrl, 'utf8'),
    ...[profileUrl, profileWebUrl, installUrl, indexUrl, harnessVisionUrl, portraitVisionUrl, legacyVisionUrl]
      .map(url => readFile(url, 'utf8')),
  ])
  assert.doesNotMatch(preset, /@deepseek-ai\/dsh-tool-subagent|^- id: independent-evaluator$/mu)
  assert.match(independentEvaluator, /session\.requestHeader\(\)\?\.config/u)
  assert.match(independentEvaluator, /ctx\.subagents\.start\('spawn'/u)
  assert.match(independentEvaluator, /toolFilter:\s*\{ allow:\s*\['audit_selection'\]\s*\}/u)
  assert.match(independentEvaluator, /const TOOL_INPUT_KEYS = Object\.freeze/u)
  const runtime = [preset, readme, independentEvaluator, production[0], production[1], ...production.slice(3)].join('\n')
  assert.doesNotMatch(runtime, /visionModel|api\.minimaxi\.com|MiniMax-M3|MINIMAX_(?:CN_)?API_KEY/u)
  assert.match(runtime, /resolveHarnessModelRoute/u)
  assert.match(runtime, /requestHeader/u)
  assert.doesNotMatch(production[2] ?? '', /MINIMAX_(?:CN_)?API_KEY/u)
})

test('legacy credentials migrate to the flat rc.8 map without changing secret values', () => {
  const normalized = normalizeCredentialObject({
    version: 1,
    refs: { SYNTHETIC_API_KEY: 'synthetic-secret:with-punctuation' },
  })
  assert.equal(normalized.migrated, true)
  assert.deepEqual(normalized.entries, {
    SYNTHETIC_API_KEY: 'synthetic-secret:with-punctuation',
  })
  assert.equal(
    renderFlatCredentials(normalized.entries),
    'SYNTHETIC_API_KEY: "synthetic-secret:with-punctuation"\n',
  )

  const current = normalizeCredentialObject({ TEST_API_KEY: 'already-flat' })
  assert.equal(current.migrated, false)
  assert.throws(() => normalizeCredentialObject({ TEST_API_KEY: 123 }), /非空字符串/u)
})

test('oracle exclusion and acceptance receipt are wired into the production proposal path', async () => {
  const [preset, install, source] = await Promise.all([
    readFile(presetUrl, 'utf8'),
    readFile(installUrl, 'utf8'),
    readFile(indexUrl, 'utf8'),
  ])
  assert.match(preset, /excludedRelativePaths:\s*@@PHOTO_FILTER_EXCLUDED_RELATIVE_PATHS@@/u)
  assert.match(install, /PHOTO_FILTER_EXCLUDED_RELATIVE_PATHS/u)
  assert.match(source, /engine\.analyze\(folder, args\.limit, exec\.signal, excludedRelativePaths\)/u)
  assert.match(source, /engine\.contentHashes\(keep, exec\.signal\)/u)
  assert.match(source, /createFrozenSelectionReceipt\(/u)
  const proposeStart = source.indexOf("name: 'propose'")
  const proposeEnd = source.indexOf("name: 'export_selection'", proposeStart)
  const propose = source.slice(proposeStart, proposeEnd)
  assert.ok(propose.indexOf('validateProposal(state, args.keep)') >= 0)
  assert.ok(propose.indexOf('validateProposal(state, args.keep)') < propose.indexOf('freezeAcceptanceReceipt(state, exec)'))
  assert.ok(propose.indexOf('freezeAcceptanceReceipt(state, exec)') < propose.indexOf('state.proposal ='))
  assert.match(propose, /oracle 尚未读取/u)
})
