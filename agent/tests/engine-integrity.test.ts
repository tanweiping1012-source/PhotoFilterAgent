import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const engineSource = await readFile(new URL('../src/engine.ts', import.meta.url), 'utf8')
const pluginSource = await readFile(new URL('../src/anchor-lab-codex-plugin.ts', import.meta.url), 'utf8')

test('preview argv supports an analyze-frozen original SHA-256', () => {
  assert.match(engineSource, /expectedOriginalSha256\?: string/)
  assert.match(
    engineSource,
    /if \(expectedOriginalSha256\) args\.push\('--expected-sha256', expectedOriginalSha256\)/,
  )

  const verifiedPreviewCalls = pluginSource.match(
    /run\.engine\.preview\([\s\S]*?expectedOriginalSHA256\(run, id\),[\s\S]*?\)/g,
  ) ?? []
  assert.equal(verifiedPreviewCalls.length, 4, 'selector/audit score and pair previews must all be bound')
})

test('candidate pair sheet argv and C runtime bind both original identities', () => {
  assert.match(
    engineSource,
    /'--first-expected-sha256', firstExpectedOriginalSha256,[\s\S]*?'--second-expected-sha256', secondExpectedOriginalSha256/,
  )
  assert.match(
    pluginSource,
    /run\.engine\.candidatePairSheet\([\s\S]*?expectedOriginalSHA256\(run, firstId\),[\s\S]*?expectedOriginalSHA256\(run, secondId\)/,
  )
  assert.match(pluginSource, /originalContentHashes: new Map\(contentById\)/)
})
