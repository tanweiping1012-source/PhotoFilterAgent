import { createHash } from 'node:crypto'
import type { PortraitEvaluationProfile } from './evaluation-profile.ts'
import {
  assertReferenceSheetQualityReceipt,
  type FrozenReferenceSheetQualityReceipt,
} from './reference-sheet-quality.ts'

export const ANCHOR_ABC_MANIFEST_SCHEMA = 'photo-filter-anchor-abc/v2' as const

type Hash = string

export interface AnchorArmContracts {
  profile: PortraitEvaluationProfile
  selectorLowContractHash: Hash
  selectorHighContractHash: Hash
  selectorPairwiseContractHash: Hash
  auditLowContractHash: Hash
  auditHighContractHash: Hash
  auditPairwiseContractHash: Hash
  visualStages: readonly string[]
}

export interface AnchorAbcManifestInput {
  experimentId: string
  mode: 'diagnostic' | 'acceptance'
  sourceSnapshotHash: Hash
  dataset: {
    fingerprint: Hash
    candidateScope: 'people_only'
    targetK: number
    seed: string
    preferenceHash: Hash
  }
  route: {
    provider: string
    model: string
    protocol: string
    reasoningEffort?: string
  }
  algorithmIdentity: Record<string, string>
  budget: {
    highCap: number
    pairwisePairCap: number
    auditCallCapPerTurn: number
    maxCompleteAuditRounds: number
  }
  visualAnchorPack: {
    packHash: Hash
    rubricContentHash: Hash
    orderedAssetContentMultisetHash: Hash
    anchorSheetSha256: Hash
    layoutProtocolHash: Hash
    referenceSheetQualityReceipt: FrozenReferenceSheetQualityReceipt
  }
  contentOverlapPreflight: {
    protocolVersion: 'anchor-candidate-overlap/v1'
    datasetFingerprint: Hash
    anchorPackHash: Hash
    overlapCount: number
    reportHash: Hash
  }
  arms: {
    A: AnchorArmContracts
    B: AnchorArmContracts
    C: AnchorArmContracts
  }
  oracle: {
    oracleLocked: true
    scanExclusionPolicyHash: Hash
    unlockPolicy: 'all_arms_exact_k_and_audit_terminal'
    unlockRequiresSeparateReceipt: true
  }
}

export interface FrozenAnchorAbcManifest extends AnchorAbcManifestInput {
  readonly schemaVersion: typeof ANCHOR_ABC_MANIFEST_SCHEMA
  readonly routeIdentityHash: Hash
  readonly acceptanceEligible: boolean
  readonly manifestHash: Hash
}

export class AnchorExperimentManifestError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'AnchorExperimentManifestError'
    this.code = code
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('\u0000')
}

function assertHash(value: unknown, field: string): asserts value is string {
  if (!nonEmpty(value) || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new AnchorExperimentManifestError('INVALID_HASH', `${field} 必须是 64 位小写 SHA-256。`)
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, canonical(child)]))
}

function canonicalHash(value: unknown): string {
  return sha256(JSON.stringify(canonical(value)))
}

function deepClone<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => deepClone(item)) as T
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, child]) => [key, deepClone(child)]),
  ) as T
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return Object.freeze(value)
}

function same(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
}

function validateContracts(arms: AnchorAbcManifestInput['arms']): void {
  const hashes: Array<[string, string]> = []
  for (const [arm, contracts] of Object.entries(arms)) {
    if (contracts.profile.arm !== arm) {
      throw new AnchorExperimentManifestError('ARM_PROFILE_MISMATCH', `${arm} 的 profile.arm 不匹配。`)
    }
    for (const [field, value] of Object.entries(contracts)) {
      if (field.endsWith('ContractHash')) hashes.push([`${arm}.${field}`, value as string])
    }
  }
  for (const [field, value] of hashes) assertHash(value, field)

  if (arms.B.selectorLowContractHash !== arms.C.selectorLowContractHash
    || arms.B.auditLowContractHash !== arms.C.auditLowContractHash
    || arms.B.profile.rubricVersion !== arms.C.profile.rubricVersion
    || arms.B.profile.rubricContentHash !== arms.C.profile.rubricContentHash) {
    throw new AnchorExperimentManifestError(
      'BC_LOW_CONTRACT_MISMATCH',
      'B/C 的 selector/audit low 必须使用完全相同的文本 Rubric 和合同。',
    )
  }
  if (arms.C.selectorHighContractHash === arms.B.selectorHighContractHash
    || arms.C.selectorPairwiseContractHash === arms.B.selectorPairwiseContractHash
    || arms.C.auditHighContractHash === arms.B.auditHighContractHash
    || arms.C.auditPairwiseContractHash === arms.B.auditPairwiseContractHash) {
    throw new AnchorExperimentManifestError(
      'C_VISUAL_CONTRACT_NOT_ISOLATED',
      'C 的 high/pairwise selector/audit 合同必须绑定视觉锚点并与 B 隔离。',
    )
  }
  const expectedVisual = [
    'selector_high',
    'selector_pairwise',
    'audit_high',
    'audit_pairwise',
  ]
  if (arms.A.visualStages.length > 0 || arms.B.visualStages.length > 0
    || !same(arms.C.visualStages, expectedVisual)
    || arms.C.visualStages.some(stage => stage.includes('low'))) {
    throw new AnchorExperimentManifestError(
      'INVALID_VISUAL_STAGES',
      '视觉锚点只能出现在 C 的 selector/audit high 与 pairwise。',
    )
  }
}

export function freezeAnchorAbcManifest(input: AnchorAbcManifestInput): FrozenAnchorAbcManifest {
  const snapshot = deepClone(input)
  if (!nonEmpty(snapshot.experimentId) || !nonEmpty(snapshot.dataset.seed)) {
    throw new AnchorExperimentManifestError('INVALID_EXPERIMENT_ID', 'experimentId 与 seed 不能为空。')
  }
  for (const [field, value] of [
    ['sourceSnapshotHash', snapshot.sourceSnapshotHash],
    ['dataset.fingerprint', snapshot.dataset.fingerprint],
    ['dataset.preferenceHash', snapshot.dataset.preferenceHash],
    ['visualAnchorPack.packHash', snapshot.visualAnchorPack.packHash],
    ['visualAnchorPack.rubricContentHash', snapshot.visualAnchorPack.rubricContentHash],
    ['visualAnchorPack.orderedAssetContentMultisetHash', snapshot.visualAnchorPack.orderedAssetContentMultisetHash],
    ['visualAnchorPack.anchorSheetSha256', snapshot.visualAnchorPack.anchorSheetSha256],
    ['visualAnchorPack.layoutProtocolHash', snapshot.visualAnchorPack.layoutProtocolHash],
    ['contentOverlapPreflight.reportHash', snapshot.contentOverlapPreflight.reportHash],
    ['oracle.scanExclusionPolicyHash', snapshot.oracle.scanExclusionPolicyHash],
  ] as const) assertHash(value, field)
  if (snapshot.dataset.targetK <= 0 || !Number.isInteger(snapshot.dataset.targetK)) {
    throw new AnchorExperimentManifestError('INVALID_TARGET_K', 'targetK 必须是正整数。')
  }
  if (!snapshot.oracle.oracleLocked || !snapshot.oracle.unlockRequiresSeparateReceipt) {
    throw new AnchorExperimentManifestError(
      'ORACLE_NOT_LOCKED',
      'oracle 必须在原 manifest 中保持锁定，并由独立 receipt 解锁。',
    )
  }
  if (snapshot.contentOverlapPreflight.datasetFingerprint !== snapshot.dataset.fingerprint
    || snapshot.contentOverlapPreflight.anchorPackHash !== snapshot.visualAnchorPack.packHash) {
    throw new AnchorExperimentManifestError(
      'OVERLAP_PREFLIGHT_IDENTITY_MISMATCH',
      '锚点候选重合预检没有绑定当前 dataset/pack。',
    )
  }
  if (!Number.isInteger(snapshot.contentOverlapPreflight.overlapCount)
    || snapshot.contentOverlapPreflight.overlapCount < 0) {
    throw new AnchorExperimentManifestError('INVALID_OVERLAP_COUNT', 'overlapCount 必须是非负整数。')
  }
  if (snapshot.mode === 'acceptance' && snapshot.contentOverlapPreflight.overlapCount !== 0) {
    throw new AnchorExperimentManifestError(
      'ANCHOR_CANDIDATE_LEAKAGE',
      '正式验收要求视觉锚点与候选池精确图片重合为 0；否则只能运行 diagnostic。',
    )
  }
  validateContracts(snapshot.arms)
  if (snapshot.arms.C.profile.visualAnchorPackHash !== snapshot.visualAnchorPack.packHash
    || snapshot.arms.B.profile.rubricContentHash !== snapshot.visualAnchorPack.rubricContentHash) {
    throw new AnchorExperimentManifestError(
      'PROFILE_PACK_IDENTITY_MISMATCH',
      'B/C profile 没有绑定冻结 Rubric/视觉包。',
    )
  }
  try {
    assertReferenceSheetQualityReceipt(snapshot.visualAnchorPack.referenceSheetQualityReceipt)
  } catch {
    throw new AnchorExperimentManifestError(
      'REFERENCE_SHEET_RECEIPT_INVALID',
      'visualAnchorPack 必须携带一个完整有效的 v2 参考图版 PASS 收据。',
    )
  }
  const qualityReceipt = snapshot.visualAnchorPack.referenceSheetQualityReceipt
  if (qualityReceipt.anchorPackHash !== snapshot.visualAnchorPack.packHash
    || qualityReceipt.anchorSheetSha256 !== snapshot.visualAnchorPack.anchorSheetSha256
    || qualityReceipt.layoutProtocolHash !== snapshot.visualAnchorPack.layoutProtocolHash
    || qualityReceipt.status !== 'PASS') {
    throw new AnchorExperimentManifestError(
      'REFERENCE_SHEET_RECEIPT_IDENTITY_MISMATCH',
      '参考图版收据的 pack、sheet、layout 或 PASS 状态与 manifest 不一致。',
    )
  }
  if (!nonEmpty(snapshot.route.provider) || !nonEmpty(snapshot.route.model)
    || !nonEmpty(snapshot.route.protocol)) {
    throw new AnchorExperimentManifestError('MODEL_ROUTE_UNRESOLVED', '冻结 route 缺少 provider/model/protocol。')
  }
  const routeIdentityHash = sha256([
    snapshot.route.provider,
    snapshot.route.model,
    snapshot.route.protocol,
    snapshot.route.reasoningEffort ?? '',
  ].join('\u0000'))
  const withoutHash = {
    schemaVersion: ANCHOR_ABC_MANIFEST_SCHEMA,
    ...snapshot,
    routeIdentityHash,
    acceptanceEligible: snapshot.mode === 'acceptance'
      && snapshot.contentOverlapPreflight.overlapCount === 0,
  }
  return deepFreeze({
    ...withoutHash,
    manifestHash: canonicalHash(withoutHash),
  }) as FrozenAnchorAbcManifest
}
