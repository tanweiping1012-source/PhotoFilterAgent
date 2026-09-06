import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const preflightScriptPath = fileURLToPath(
  new URL('../../scripts/validate-acceptance-dataset.mjs', import.meta.url),
)

async function writeImages(root: string, contents: readonly string[]) {
  await mkdir(root, { recursive: true })
  await Promise.all(contents.map((content, index) =>
    writeFile(join(root, `fixture-${index}.jpg`), content)))
}

function runPreflight(sourceRoot: string, oracle: string, target: number, excluded = 'me-pick') {
  return spawnSync(process.execPath, [
    preflightScriptPath,
    '--source-root', sourceRoot,
    '--oracle', oracle,
    '--exclude-relative', excluded,
    '--target', String(target),
  ], { encoding: 'utf8' })
}

test('acceptance preflight validates full oracle coverage and emits aggregate path-free metrics', async () => {
  const workdir = await mkdtemp(join(tmpdir(), 'photo-filter-preflight-valid-'))
  try {
    const oracle = join(workdir, 'me-pick')
    await Promise.all([
      writeImages(workdir, ['picked-one', 'picked-two', 'other']),
      writeImages(oracle, ['picked-one', 'picked-two']),
    ])

    const result = runPreflight(workdir, oracle, 2)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr, '')
    assert.match(result.stdout, /^candidate_count=3$/mu)
    assert.match(result.stdout, /^oracle_count=2$/mu)
    assert.match(result.stdout, /^oracle_content_present_count=2$/mu)
    assert.match(result.stdout, /^candidate_oracle_coverage=1\.000000$/mu)
    assert.match(result.stdout, /^exact_target_alignment=true$/mu)
    assert.match(result.stdout, /^candidate_capacity=true$/mu)
    assert.match(result.stdout, /^valid=true$/mu)
    assert.doesNotMatch(result.stdout, /fixture|me-pick|\.jpg|[a-f0-9]{64}/u)
    assert.doesNotMatch(result.stdout, new RegExp(workdir.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
  } finally {
    await rm(workdir, { recursive: true, force: true })
  }
})

test('acceptance preflight fails closed when moved picks are absent or K is misaligned', async () => {
  const workdir = await mkdtemp(join(tmpdir(), 'photo-filter-preflight-invalid-'))
  try {
    const oracle = join(workdir, 'me-pick')
    await Promise.all([
      writeImages(workdir, ['picked-one', 'other']),
      writeImages(oracle, ['picked-one', 'picked-two']),
    ])

    const missing = runPreflight(workdir, oracle, 2)
    assert.equal(missing.status, 2, missing.stderr)
    assert.match(missing.stdout, /^oracle_content_present_count=1$/mu)
    assert.match(missing.stdout, /^candidate_oracle_coverage=0\.500000$/mu)
    assert.match(missing.stdout, /^valid=false$/mu)

    await writeFile(join(workdir, 'fixture-2.jpg'), 'picked-two')
    const wrongK = runPreflight(workdir, oracle, 3)
    assert.equal(wrongK.status, 2, wrongK.stderr)
    assert.match(wrongK.stdout, /^oracle_content_present_count=2$/mu)
    assert.match(wrongK.stdout, /^exact_target_alignment=false$/mu)
    assert.match(wrongK.stdout, /^valid=false$/mu)
  } finally {
    await rm(workdir, { recursive: true, force: true })
  }
})

test('acceptance preflight rejects an undeclared oracle and symlink escape', async () => {
  const workdir = await mkdtemp(join(tmpdir(), 'photo-filter-preflight-boundary-'))
  const outside = await mkdtemp(join(tmpdir(), 'photo-filter-preflight-outside-'))
  try {
    const oracle = join(workdir, 'me-pick')
    const undeclared = join(workdir, 'other-pick')
    await Promise.all([
      writeImages(workdir, ['one']),
      writeImages(oracle, ['one']),
      writeImages(undeclared, ['one']),
      writeImages(outside, ['one']),
    ])

    const wrong = runPreflight(workdir, undeclared, 1)
    assert.equal(wrong.status, 1)
    assert.match(wrong.stderr, /not the declared excluded child directory/u)

    const linked = join(workdir, 'linked-pick')
    await symlink(outside, linked)
    const escaped = runPreflight(workdir, linked, 1, 'linked-pick')
    assert.equal(escaped.status, 1)
    assert.match(escaped.stderr, /not the declared excluded child directory/u)
    assert.doesNotMatch(escaped.stderr, new RegExp(outside.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
  } finally {
    await Promise.all([
      rm(workdir, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ])
  }
})
