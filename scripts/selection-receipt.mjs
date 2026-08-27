import { createHash } from 'node:crypto'
import { isAbsolute, normalize } from 'node:path'

export const SELECTION_RECEIPT_SCHEMA_VERSION = 'photo-filter-selection-receipt/v1'
export const SELECTION_RECEIPT_GENERATOR = '@photo-filter-agent/dsh-photo-filter-agent'
export const PHOTO_SCAN_POLICY_VERSION = 'photo-scan-policy-v1'

const ROOT_KEYS = Object.freeze([
  'auditStatus',
  'candidateScope',
  'datasetFingerprint',
  'excludedRelativePaths',
  'generator',
  'promptIdentity',
  'receiptHash',
  'routeIdentity',
  'rubricIdentity',
  'scanPolicyIdentity',
  'schemaVersion',
  'selectedContentHashes',
  'selectedItems',
  'selectionHash',
  'sourceRoot',
  'target',
])
const RUBRIC_KEYS = Object.freeze(['hash', 'version'])
const SELECTED_ITEM_KEYS = Object.freeze(['id', 'sha256'])
const PROMPT_KEYS = Object.freeze([
  'auditBaselineHash',
  'auditPairwiseHash',
  'selectorBaselineHash',
])
const SHA256_PATTERN = /^[a-f0-9]{64}$/u

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function assertExactKeys(value, expected, label) {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`)
  const actual = Object.keys(value).sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has missing or unknown fields`)
  }
}

function assertNonEmptyString(value, label, maximum = 1024) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    throw new TypeError(`${label} must be a non-empty bounded string`)
  }
  return value
}

function assertSha256(value, label) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 hex digest`)
  }
  return value
}

function assertSourceRoot(value) {
  assertNonEmptyString(value, 'sourceRoot', 4096)
  if (!isAbsolute(value) || normalize(value) !== value || value === '/') {
    throw new TypeError('sourceRoot must be a normalized absolute non-root path')
  }
  return value
}

function assertExcludedRelativePath(value, index) {
  assertNonEmptyString(value, `excludedRelativePaths[${index}]`, 4096)
  if (value.includes('\0') || isAbsolute(value) || normalize(value) !== value
    || value === '.' || value === '..' || value.startsWith('../')) {
    throw new TypeError(`excludedRelativePaths[${index}] must stay below sourceRoot`)
  }
  return value
}

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('receipt cannot contain non-finite numbers')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  throw new TypeError('receipt contains an unsupported value')
}

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function photoScanPolicyIdentity(excludedRelativePaths) {
  if (!Array.isArray(excludedRelativePaths) || excludedRelativePaths.length === 0) {
    throw new TypeError('excludedRelativePaths must be a non-empty array')
  }
  const normalized = excludedRelativePaths.map(assertExcludedRelativePath).sort()
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError('excludedRelativePaths must be unique')
  }
  return sha256Hex([PHOTO_SCAN_POLICY_VERSION, ...normalized].join('\0'))
}

export function selectionHashFromReceiptItems({
  rubricVersion,
  datasetFingerprint,
  candidateScope,
  selectedIds,
}) {
  return sha256Hex(
    `${rubricVersion}\0${datasetFingerprint}\0${candidateScope}\0${[...selectedIds].sort().join('\0')}`,
  )
}

function unsignedReceipt(receipt) {
  return {
    schemaVersion: receipt.schemaVersion,
    generator: receipt.generator,
    sourceRoot: receipt.sourceRoot,
    excludedRelativePaths: [...receipt.excludedRelativePaths],
    scanPolicyIdentity: receipt.scanPolicyIdentity,
    datasetFingerprint: receipt.datasetFingerprint,
    selectionHash: receipt.selectionHash,
    candidateScope: receipt.candidateScope,
    target: receipt.target,
    selectedItems: receipt.selectedItems.map(item => ({ id: item.id, sha256: item.sha256 })),
    selectedContentHashes: [...receipt.selectedContentHashes],
    auditStatus: receipt.auditStatus,
    routeIdentity: receipt.routeIdentity,
    rubricIdentity: {
      version: receipt.rubricIdentity.version,
      hash: receipt.rubricIdentity.hash,
    },
    promptIdentity: {
      selectorBaselineHash: receipt.promptIdentity.selectorBaselineHash,
      auditBaselineHash: receipt.promptIdentity.auditBaselineHash,
      auditPairwiseHash: receipt.promptIdentity.auditPairwiseHash,
    },
  }
}

export function selectionReceiptHash(receipt) {
  return sha256Hex(canonicalJson(unsignedReceipt(receipt)))
}

/**
 * Build the only receipt shape accepted by the overlap evaluator.
 *
 * The caller must pass the frozen audit status from plugin state. This function
 * fails closed unless that status is PASS. Content hashes are sorted so receipt
 * identity is deterministic and does not disclose filenames or ranking order.
 */
export function createFrozenSelectionReceipt(input) {
  const receipt = {
    schemaVersion: SELECTION_RECEIPT_SCHEMA_VERSION,
    generator: SELECTION_RECEIPT_GENERATOR,
    sourceRoot: input.sourceRoot,
    excludedRelativePaths: Array.isArray(input.excludedRelativePaths)
      ? [...input.excludedRelativePaths].sort()
      : input.excludedRelativePaths,
    scanPolicyIdentity: Array.isArray(input.excludedRelativePaths)
      ? photoScanPolicyIdentity(input.excludedRelativePaths)
      : input.scanPolicyIdentity,
    datasetFingerprint: input.datasetFingerprint,
    selectionHash: input.selectionHash,
    candidateScope: input.candidateScope,
    target: input.target,
    selectedItems: Array.isArray(input.selectedItems)
      ? [...input.selectedItems]
        .map(item => ({ id: item.id, sha256: item.sha256 }))
        .sort((left, right) => left.id.localeCompare(right.id))
      : input.selectedItems,
    selectedContentHashes: Array.isArray(input.selectedItems)
      ? input.selectedItems.map(item => item.sha256).sort()
      : input.selectedContentHashes,
    auditStatus: input.auditStatus,
    routeIdentity: input.routeIdentity,
    rubricIdentity: input.rubricIdentity,
    promptIdentity: input.promptIdentity,
  }
  const validated = validateUnsignedReceipt(receipt)
  return Object.freeze({
    ...validated,
    receiptHash: selectionReceiptHash(validated),
  })
}

function validateUnsignedReceipt(value) {
  const expectedUnsignedKeys = ROOT_KEYS.filter(key => key !== 'receiptHash')
  assertExactKeys(value, expectedUnsignedKeys, 'receipt')
  if (value.schemaVersion !== SELECTION_RECEIPT_SCHEMA_VERSION) {
    throw new TypeError('unsupported receipt schemaVersion')
  }
  if (value.generator !== SELECTION_RECEIPT_GENERATOR) {
    throw new TypeError('receipt was not generated by the PhotoFilterAgent plugin')
  }
  const sourceRoot = assertSourceRoot(value.sourceRoot)
  if (!Array.isArray(value.excludedRelativePaths) || value.excludedRelativePaths.length === 0) {
    throw new TypeError('excludedRelativePaths must be a non-empty array')
  }
  const excludedRelativePaths = value.excludedRelativePaths.map(assertExcludedRelativePath)
  if (new Set(excludedRelativePaths).size !== excludedRelativePaths.length) {
    throw new TypeError('excludedRelativePaths must be unique')
  }
  if (excludedRelativePaths.some((path, index) => index > 0 && path < excludedRelativePaths[index - 1])) {
    throw new TypeError('excludedRelativePaths must be sorted')
  }
  const scanPolicyIdentity = assertSha256(value.scanPolicyIdentity, 'scanPolicyIdentity')
  if (scanPolicyIdentity !== photoScanPolicyIdentity(excludedRelativePaths)) {
    throw new TypeError('scanPolicyIdentity does not match excludedRelativePaths')
  }
  const datasetFingerprint = assertSha256(value.datasetFingerprint, 'datasetFingerprint')
  const selectionHash = assertSha256(value.selectionHash, 'selectionHash')
  if (value.candidateScope !== 'auto' && value.candidateScope !== 'people_only') {
    throw new TypeError('candidateScope must be auto or people_only')
  }
  if (!Number.isSafeInteger(value.target) || value.target <= 0) {
    throw new TypeError('target must be a positive safe integer')
  }
  if (!Array.isArray(value.selectedItems) || value.selectedItems.length !== value.target) {
    throw new TypeError('selectedItems must contain exactly target items')
  }
  const selectedItems = value.selectedItems.map((item, index) => {
    assertExactKeys(item, SELECTED_ITEM_KEYS, `selectedItems[${index}]`)
    if (typeof item.id !== 'string' || !/^p[0-9]+$/u.test(item.id)) {
      throw new TypeError(`selectedItems[${index}].id must be an anonymous photo ID`)
    }
    return { id: item.id, sha256: assertSha256(item.sha256, `selectedItems[${index}].sha256`) }
  })
  if (new Set(selectedItems.map(item => item.id)).size !== selectedItems.length) {
    throw new TypeError('selectedItems IDs must be unique')
  }
  if (selectedItems.some((item, index) => index > 0 && item.id < selectedItems[index - 1].id)) {
    throw new TypeError('selectedItems must be sorted by id')
  }
  if (!Array.isArray(value.selectedContentHashes)) {
    throw new TypeError('selectedContentHashes must be an array')
  }
  if (value.selectedContentHashes.length !== value.target) {
    throw new TypeError('selectedContentHashes must contain exactly target hashes')
  }
  const selectedContentHashes = value.selectedContentHashes.map((hash, index) =>
    assertSha256(hash, `selectedContentHashes[${index}]`))
  if (selectedContentHashes.some((hash, index) => index > 0 && hash < selectedContentHashes[index - 1])) {
    throw new TypeError('selectedContentHashes must be sorted')
  }
  const hashesFromItems = selectedItems.map(item => item.sha256).sort()
  if (selectedContentHashes.some((hash, index) => hash !== hashesFromItems[index])) {
    throw new TypeError('selectedContentHashes must match the selectedItems hash multiset')
  }
  if (value.auditStatus !== 'PASS') {
    throw new TypeError('auditStatus must be PASS')
  }
  const routeIdentity = assertNonEmptyString(value.routeIdentity, 'routeIdentity', 4096)

  assertExactKeys(value.rubricIdentity, RUBRIC_KEYS, 'rubricIdentity')
  const rubricIdentity = {
    version: assertNonEmptyString(value.rubricIdentity.version, 'rubricIdentity.version', 256),
    hash: assertSha256(value.rubricIdentity.hash, 'rubricIdentity.hash'),
  }
  const expectedSelectionHash = selectionHashFromReceiptItems({
    rubricVersion: rubricIdentity.version,
    datasetFingerprint,
    candidateScope: value.candidateScope,
    selectedIds: selectedItems.map(item => item.id),
  })
  if (selectionHash !== expectedSelectionHash) {
    throw new TypeError('selectionHash does not match selectedItems')
  }
  assertExactKeys(value.promptIdentity, PROMPT_KEYS, 'promptIdentity')
  const promptIdentity = {
    selectorBaselineHash: assertSha256(
      value.promptIdentity.selectorBaselineHash,
      'promptIdentity.selectorBaselineHash',
    ),
    auditBaselineHash: assertSha256(
      value.promptIdentity.auditBaselineHash,
      'promptIdentity.auditBaselineHash',
    ),
    auditPairwiseHash: assertSha256(
      value.promptIdentity.auditPairwiseHash,
      'promptIdentity.auditPairwiseHash',
    ),
  }

  return {
    schemaVersion: SELECTION_RECEIPT_SCHEMA_VERSION,
    generator: SELECTION_RECEIPT_GENERATOR,
    sourceRoot,
    excludedRelativePaths,
    scanPolicyIdentity,
    datasetFingerprint,
    selectionHash,
    candidateScope: value.candidateScope,
    target: value.target,
    selectedItems,
    selectedContentHashes,
    auditStatus: 'PASS',
    routeIdentity,
    rubricIdentity,
    promptIdentity,
  }
}

export function validateFrozenSelectionReceipt(value) {
  assertExactKeys(value, ROOT_KEYS, 'receipt')
  const unsigned = validateUnsignedReceipt(Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'receiptHash'),
  ))
  const receiptHash = assertSha256(value.receiptHash, 'receiptHash')
  const expected = selectionReceiptHash(unsigned)
  if (receiptHash !== expected) throw new TypeError('receiptHash does not match receipt contents')
  return Object.freeze({ ...unsigned, receiptHash })
}

export function parseFrozenSelectionReceiptJson(text) {
  if (typeof text !== 'string') throw new TypeError('receipt JSON must be a string')
  let value
  try {
    value = JSON.parse(text)
  } catch {
    throw new TypeError('receipt is not valid JSON')
  }
  return validateFrozenSelectionReceipt(value)
}

export function serializeFrozenSelectionReceipt(receipt) {
  return `${JSON.stringify(validateFrozenSelectionReceipt(receipt), null, 2)}\n`
}
