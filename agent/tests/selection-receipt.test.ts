import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  createFrozenSelectionReceipt,
  parseFrozenSelectionReceiptJson,
  photoScanPolicyIdentity,
  selectionHashFromReceiptItems,
  serializeFrozenSelectionReceipt,
  sha256Hex,
  validateFrozenSelectionReceipt,
  type FrozenSelectionReceiptInput,
} from '../../scripts/selection-receipt.mjs'

const overlapScriptPath = fileURLToPath(
  new URL('../../scripts/evaluate-pick-overlap.mjs', import.meta.url),
)
const DATASET_FINGERPRINT = sha256Hex('synthetic-dataset')
const RUBRIC_VERSION = 'portrait-baseline-v1.0.0'
const RUBRIC_IDENTITY = Object.freeze({
  version: RUBRIC_VERSION,
  hash: sha256Hex('synthetic-rubric'),
})
const PROMPT_IDENTITY = Object.freeze({
  selectorBaselineHash: sha256Hex('synthetic-selector-prompt'),
  auditBaselineHash: sha256Hex('synthetic-audit-baseline-prompt'),
  auditPairwiseHash: sha256Hex('synthetic-audit-pairwise-prompt'),
})

function selectedItems(contents: readonly string[]) {
  return contents.map((content, index) => ({
    id: `p${String(index + 1).padStart(3, '0')}`,
    sha256: sha256Hex(content),
  }))
}

function receiptInput(sourceRoot: string, contents: readonly string[]): FrozenSelectionReceiptInput {
  const items = selectedItems(contents)
  return {
    sourceRoot,
    excludedRelativePaths: ['me-pick'],
    datasetFingerprint: DATASET_FINGERPRINT,
    selectionHash: selectionHashFromReceiptItems({
      rubricVersion: RUBRIC_VERSION,
      datasetFingerprint: DATASET_FINGERPRINT,
      candidateScope: 'people_only',
      selectedIds: items.map(item => item.id),
    }),
    candidateScope: 'people_only',
    target: items.length,
    selectedItems: items,
    auditStatus: 'PASS',
    routeIdentity: 'fixture-provider\0fixture-model\0dsh-llm-tool-call-v1\0',
    rubricIdentity: RUBRIC_IDENTITY,
    promptIdentity: PROMPT_IDENTITY,
  }
}

async function writeOracle(root: string, contents: readonly string[]) {
  await mkdir(root)
  await Promise.all(contents.map((content, index) =>
    writeFile(join(root, `fixture-${index}.jpg`), content)))
}

function runOverlap(receipt: string, oracle: string, json?: string) {
  return spawnSync(process.execPath, [
    overlapScriptPath,
    '--receipt', receipt,
    '--oracle', oracle,
    ...(json ? ['--json', json] : []),
  ], { encoding: 'utf8' })
}

test('receipt creation binds exact-K anonymous IDs, content multiset, audit, route, rubric, prompts, and scan policy', async () => {
  const workdir = await mkdtemp(join(tmpdir(), 'photo-filter-receipt-schema-'))
  try {
    const sourceRoot = await realpath(workdir)
    const input = receiptInput(sourceRoot, ['one', 'same', 'same'])
    const receipt = createFrozenSelectionReceipt(input)
    const parsed = parseFrozenSelectionReceiptJson(serializeFrozenSelectionReceipt(receipt))

    assert.equal(parsed.target, 3)
    assert.deepEqual(parsed.selectedItems.map(item => item.id), ['p001', 'p002', 'p003'])
    assert.deepEqual(
      parsed.selectedItems.map(item => item.sha256),
      selectedItems(['one', 'same', 'same']).map(item => item.sha256),
    )
    assert.equal(parsed.selectedItems[1].sha256, parsed.selectedItems[2].sha256)
    assert.equal(parsed.auditStatus, 'PASS')
    assert.equal(
      parsed.scanPolicyIdentity,
      photoScanPolicyIdentity(parsed.excludedRelativePaths),
    )
  } finally {
    await rm(workdir, { recursive: true, force: true })
  }
})

test('receipt rejects malformed exact-K, duplicate IDs, mismatched selection/hash sets, non-PASS audit, and tampering', async () => {
  const workdir = await mkdtemp(join(tmpdir(), 'photo-filter-receipt-invalid-'))
  try {
    const sourceRoot = await realpath(workdir)
    const valid = createFrozenSelectionReceipt(receiptInput(sourceRoot, ['one', 'two']))

    assert.throws(
      () => createFrozenSelectionReceipt({ ...receiptInput(sourceRoot, ['one']), target: 2 }),
      /exactly target/u,
    )
    const duplicateId: any = structuredClone(receiptInput(sourceRoot, ['one', 'two']))
    duplicateId.selectedItems[1].id = duplicateId.selectedItems[0].id
    assert.throws(() => createFrozenSelectionReceipt(duplicateId), /IDs must be unique/u)

    const wrongSelectionHash = { ...receiptInput(sourceRoot, ['one']), selectionHash: sha256Hex('wrong') }
    assert.throws(() => createFrozenSelectionReceipt(wrongSelectionHash), /selectionHash/u)
    assert.throws(
      () => createFrozenSelectionReceipt({
        ...receiptInput(sourceRoot, ['one']), auditStatus: 'FAIL',
      } as unknown as FrozenSelectionReceiptInput),
      /auditStatus must be PASS/u,
    )

    const mismatchedContentList: any = structuredClone(valid)
    mismatchedContentList.selectedContentHashes[mismatchedContentList.selectedContentHashes.length - 1]
      = 'f'.repeat(64)
    assert.throws(() => validateFrozenSelectionReceipt(mismatchedContentList), /hash multiset/u)

    const badScanPolicy: any = structuredClone(valid)
    badScanPolicy.scanPolicyIdentity = sha256Hex('forged-policy')
    assert.throws(() => validateFrozenSelectionReceipt(badScanPolicy), /scanPolicyIdentity/u)

    const tamperedRoute: any = structuredClone(valid)
    tamperedRoute.routeIdentity = 'another-route'
    assert.throws(() => validateFrozenSelectionReceipt(tamperedRoute), /receiptHash/u)

    const unknownField = { ...valid, selectedDirectory: '/not-accepted' }
    assert.throws(() => validateFrozenSelectionReceipt(unknownField), /missing or unknown fields/u)
  } finally {
    await rm(workdir, { recursive: true, force: true })
  }
})

test('overlap CLI passes 18/20, fails 17/20, emits only path-free metrics, and never reads a selected directory', async () => {
  const workdir = await mkdtemp(join(tmpdir(), 'photo-filter-overlap-fixture-'))
  try {
    const sourceRoot = await realpath(workdir)
    const oracle = join(sourceRoot, 'me-pick')
    const shared = Array.from({ length: 18 }, (_, index) => `shared-${index}`)
    await writeOracle(oracle, [...shared, 'oracle-18', 'oracle-19'])

    const passReceipt = join(sourceRoot, 'pass-receipt.json')
    await writeFile(passReceipt, serializeFrozenSelectionReceipt(createFrozenSelectionReceipt(
      receiptInput(sourceRoot, [...shared, 'selected-18', 'selected-19']),
    )))
    const outputJson = join(sourceRoot, 'overlap.json')
    const pass = runOverlap(passReceipt, oracle, outputJson)
    assert.equal(pass.status, 0, pass.stderr)
    assert.equal(pass.stderr, '')
    assert.match(pass.stdout, /^selected_count=20$/mu)
    assert.match(pass.stdout, /^oracle_count=20$/mu)
    assert.match(pass.stdout, /^intersection_count=18$/mu)
    assert.match(pass.stdout, /^precision=0\.900000$/mu)
    assert.match(pass.stdout, /^recall=0\.900000$/mu)
    assert.match(pass.stdout, /^f1=0\.900000$/mu)
    assert.match(pass.stdout, /^jaccard=0\.818182$/mu)
    assert.match(pass.stdout, /^pass_90=true$/mu)
    assert.doesNotMatch(pass.stdout, new RegExp(sourceRoot.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
    assert.deepEqual(Object.keys(JSON.parse(await readFile(outputJson, 'utf8'))), [
      'selected_count', 'oracle_count', 'intersection_count',
      'precision', 'recall', 'f1', 'jaccard', 'pass_90',
    ])

    const failReceipt = join(sourceRoot, 'fail-receipt.json')
    await writeFile(failReceipt, serializeFrozenSelectionReceipt(createFrozenSelectionReceipt(
      receiptInput(sourceRoot, [...shared.slice(0, 17), 'selected-17', 'selected-18', 'selected-19']),
    )))
    const fail = runOverlap(failReceipt, oracle)
    assert.equal(fail.status, 0, fail.stderr)
    assert.match(fail.stdout, /^intersection_count=17$/mu)
    assert.match(fail.stdout, /^pass_90=false$/mu)
  } finally {
    await rm(workdir, { recursive: true, force: true })
  }
})

test('overlap CLI preserves multiset semantics when two anonymous IDs have identical content', async () => {
  const workdir = await mkdtemp(join(tmpdir(), 'photo-filter-overlap-multiset-'))
  try {
    const sourceRoot = await realpath(workdir)
    const oracle = join(sourceRoot, 'me-pick')
    await writeOracle(oracle, ['same-content'])
    const receiptPath = join(sourceRoot, 'receipt.json')
    await writeFile(receiptPath, serializeFrozenSelectionReceipt(createFrozenSelectionReceipt(
      receiptInput(sourceRoot, ['same-content', 'same-content']),
    )))

    const result = runOverlap(receiptPath, oracle)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /^intersection_count=1$/mu)
    assert.match(result.stdout, /^precision=0\.500000$/mu)
    assert.match(result.stdout, /^recall=1\.000000$/mu)
    assert.match(result.stdout, /^pass_90=false$/mu)
  } finally {
    await rm(workdir, { recursive: true, force: true })
  }
})

test('overlap CLI validates the complete receipt before touching oracle and authorizes only a declared excluded realpath', async () => {
  const workdir = await mkdtemp(join(tmpdir(), 'photo-filter-overlap-boundary-'))
  const outside = await mkdtemp(join(tmpdir(), 'photo-filter-overlap-outside-'))
  try {
    const sourceRoot = await realpath(workdir)
    const oracle = join(sourceRoot, 'me-pick')
    const undeclared = join(sourceRoot, 'other-pick')
    await Promise.all([writeOracle(oracle, ['one']), writeOracle(undeclared, ['one'])])
    const receipt = createFrozenSelectionReceipt(receiptInput(sourceRoot, ['one']))
    const receiptPath = join(sourceRoot, 'receipt.json')
    await writeFile(receiptPath, serializeFrozenSelectionReceipt(receipt))

    const wrongOracle = runOverlap(receiptPath, undeclared)
    assert.notEqual(wrongOracle.status, 0)
    assert.match(wrongOracle.stderr, /not an authorized excluded directory/u)
    assert.doesNotMatch(wrongOracle.stderr, new RegExp(sourceRoot.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))

    const tampered: any = structuredClone(receipt)
    tampered.routeIdentity = 'tampered'
    const tamperedPath = join(sourceRoot, 'tampered.json')
    await writeFile(tamperedPath, JSON.stringify(tampered))
    const invalidBeforeMissingOracle = runOverlap(tamperedPath, join(sourceRoot, 'does-not-exist'))
    assert.notEqual(invalidBeforeMissingOracle.status, 0)
    assert.match(invalidBeforeMissingOracle.stderr, /receiptHash does not match/u)
    assert.doesNotMatch(invalidBeforeMissingOracle.stderr, /Oracle directory/u)

    const outsideReal = await realpath(outside)
    await writeFile(join(outsideReal, 'fixture.jpg'), 'one')
    const linked = join(sourceRoot, 'linked-pick')
    await symlink(outsideReal, linked)
    const linkedReceiptInput = {
      ...receiptInput(sourceRoot, ['one']),
      excludedRelativePaths: ['linked-pick'],
    }
    const linkedReceipt = join(sourceRoot, 'linked-receipt.json')
    await writeFile(linkedReceipt, serializeFrozenSelectionReceipt(
      createFrozenSelectionReceipt(linkedReceiptInput),
    ))
    const escaped = runOverlap(linkedReceipt, linked)
    assert.notEqual(escaped.status, 0)
    assert.match(escaped.stderr, /not an authorized excluded directory/u)

    const legacy = spawnSync(process.execPath, [
      overlapScriptPath, '--selected', sourceRoot, '--oracle', oracle,
    ], { encoding: 'utf8' })
    assert.notEqual(legacy.status, 0)
    assert.match(legacy.stderr, /Unknown argument: --selected/u)
  } finally {
    await Promise.all([
      rm(workdir, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ])
  }
})
