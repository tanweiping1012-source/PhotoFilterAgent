import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  computeAnchorLabAudit,
} from '../src/anchor-experiment-audit-authority.ts'
import { createAnchorLabCandidateCatalog } from '../src/anchor-experiment-authority.ts'
import type {
  AnchorExperimentAuditEvidenceView,
  AnchorExperimentDraft,
  AnchorExperimentRunBinding,
  ExperimentAssessment,
  ExperimentPairwiseLegRecord,
  ExperimentProviderOperation,
} from '../src/anchor-experiment-state.ts'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')

function binding(): AnchorExperimentRunBinding {
  const routeIdentityHash = hash(['provider', 'model', 'protocol', ''].join('\u0000'))
  const base = {
    schemaVersion: 'photo-filter-anchor-experiment-binding/v1' as const,
    experimentId: 'photo-anchor-lab-codex-v1:audit-test',
    arm: 'B' as const,
    manifestHash: hash('manifest'),
    sourceSnapshotHash: hash('source'),
    datasetFingerprint: hash('dataset'),
    candidateScope: 'people_only' as const,
    targetK: 2,
    seed: 'seed',
    preferenceHash: hash('preference'),
    route: Object.freeze({ provider: 'provider', model: 'model', protocol: 'protocol' }),
    routeIdentityHash,
    profileProtocol: 'profile-v1',
    rubricVersion: 'anchor-v1',
    rubricContentHash: hash('rubric'),
    contracts: Object.freeze({
      selectorLow: hash('selector-low'), selectorHigh: hash('selector-high'),
      selectorPairwise: hash('selector-pair'), auditLow: hash('audit-low'),
      auditHigh: hash('audit-high'), auditPairwise: hash('audit-pair'),
    }),
    budget: Object.freeze({
      highCap: 6, pairwisePairCap: 4, auditCallCapPerTurn: 4,
      maxCompleteAuditRounds: 2,
    }),
  }
  return Object.freeze({
    ...base,
    stateNamespaceHash: hash([
      'photo-filter-anchor-experiment-binding/v1', base.experimentId, base.arm,
      base.manifestHash, base.routeIdentityHash, base.datasetFingerprint,
    ].join('\u0000')),
  })
}

function assessment(
  id: string,
  detail: 'low' | 'high',
  value: number | null,
  eligibility: ExperimentAssessment['eligibility'] = 'eligible',
): ExperimentAssessment {
  return Object.freeze({
    contract: 'portrait-anchor-rubric/v1',
    id,
    role: 'audit',
    detail,
    eligibility,
    score: value,
    scoreInterval: value === null ? null : Object.freeze([value - 1, value + 1]),
    scoreIntervalSource: 'local_confidence_radius',
    overallConfidence: 0.9,
    summary: `${id}-${detail}`,
    raw: Object.freeze({ id }),
  }) as ExperimentAssessment
}

function pairLeg(
  aId: string,
  bId: string,
  order: 'AB' | 'BA',
  result: 'left' | 'right' | 'tie' | 'reject_both' = 'tie',
): ExperimentPairwiseLegRecord {
  const margin = result === 'left' ? 4 : result === 'right' ? -4 : 0
  return Object.freeze({
    aId,
    bId,
    role: 'audit',
    order,
    decision: Object.freeze({
      contract: 'portrait-anchor-pairwise/v1',
      order,
      result,
      weightedMargin: margin,
      confidence: 0.9,
      reason: result,
      raw: Object.freeze({ leftTier: 'keep', rightTier: 'keep' }),
    }),
    cacheKey: hash(`audit-${aId}-${bId}-${order}-${result}`),
  })
}

function auditEvidence(
  active: AnchorExperimentRunBinding,
  ids: readonly string[],
  assessments: readonly ExperimentAssessment[],
  legs: readonly ExperimentPairwiseLegRecord[] = [],
  operations: readonly ExperimentProviderOperation[] = [],
): AnchorExperimentAuditEvidenceView {
  return Object.freeze({
    binding: active,
    candidateIds: Object.freeze([...ids]),
    auditScores: Object.freeze(assessments.map((row, index) => Object.freeze([
      `audit-score-${index}`,
      Object.freeze({ assessment: row, cacheKey: hash(`audit-score-${index}-${row.id}-${row.detail}`) }),
    ] as const))),
    auditPairwiseLegs: Object.freeze(legs.map(row => Object.freeze([row.cacheKey, row] as const))),
    providerOperations: Object.freeze(operations.map(row => Object.freeze([row.cacheKey, row] as const))),
  })
}

function setup() {
  const active = binding()
  const ids = ['s1', 's2', 'c1', 'c2', 'c3', 'c4']
  const catalog = createAnchorLabCandidateCatalog({
    binding: active,
    candidates: ids.map((id, index) => ({
      id,
      familyId: index % 2 ? 'f2' : 'f1',
      diversityTags: [`tag:${index}`],
      localEligibility: 'eligible' as const,
      preferenceAdjustment: 0,
    })),
  })
  const draft: AnchorExperimentDraft = Object.freeze({
    bindingHash: active.stateNamespaceHash,
    keep: Object.freeze(['s1', 's2']),
    scores: Object.freeze({ s1: 90, s2: 89 }),
    selectionHash: hash('selection'),
  })
  return { active, ids, catalog, draft }
}

function advanceToPairPlan() {
  const context = setup()
  const selectedHigh = [assessment('s1', 'high', 90), assessment('s2', 'high', 89)]
  const remainingLow = ['c1', 'c2', 'c3', 'c4']
    .map((id, index) => assessment(id, 'low', 85 - index))
  const beforePromotion = computeAnchorLabAudit({
    binding: context.active,
    catalog: context.catalog,
    draft: context.draft,
    evidence: auditEvidence(context.active, context.ids, [...selectedHigh, ...remainingLow]),
    auditRound: 1,
  })
  const promotionHigh = beforePromotion.promotionPlan!.promotionIds
    .map((id, index) => assessment(id, 'high', 85 - index))
  const assessments = [...selectedHigh, ...remainingLow, ...promotionHigh]
  const beforePairs = computeAnchorLabAudit({
    binding: context.active,
    catalog: context.catalog,
    draft: context.draft,
    evidence: auditEvidence(context.active, context.ids, assessments),
    auditRound: 1,
  })
  return { ...context, assessments, beforePromotion, beforePairs }
}

test('audit coverage advances in strict four-stage order', () => {
  const { active, ids, catalog, draft } = setup()
  const empty = computeAnchorLabAudit({
    binding: active, catalog, draft,
    evidence: auditEvidence(active, ids, []), auditRound: 1,
  })
  assert.equal(empty.coverage.stage, 'selected_high')
  assert.equal(empty.report.status, 'INCOMPLETE')

  const selected = [assessment('s1', 'high', 90), assessment('s2', 'high', 89)]
  const selectedOnly = computeAnchorLabAudit({
    binding: active, catalog, draft,
    evidence: auditEvidence(active, ids, selected), auditRound: 1,
  })
  assert.equal(selectedOnly.coverage.stage, 'remaining_low')

  const low = ['c1', 'c2', 'c3', 'c4'].map((id, index) => assessment(id, 'low', 85 - index))
  const lowComplete = computeAnchorLabAudit({
    binding: active, catalog, draft,
    evidence: auditEvidence(active, ids, [...selected, ...low]), auditRound: 1,
  })
  assert.equal(lowComplete.coverage.stage, 'promotion_high')
  assert.equal(lowComplete.coverage.promotionHigh.planFrozen, true)
  assert.deepEqual(
    [...lowComplete.coverage.promotionHigh.missingIds].sort(),
    [...lowComplete.universe.randomChallengerIds].sort(),
  )
})

test('one missing AB/BA leg and any reserved operation prevent PASS', () => {
  const { active, ids, catalog, draft, assessments, beforePairs } = advanceToPairPlan()
  assert.equal(beforePairs.coverage.stage, 'pairwise')
  const allLegs = beforePairs.pairPlan!.pairs.flatMap(pair => [
    pairLeg(pair.aId, pair.bId, 'AB'), pairLeg(pair.aId, pair.bId, 'BA'),
  ])
  const missingOne = computeAnchorLabAudit({
    binding: active, catalog, draft,
    evidence: auditEvidence(active, ids, assessments, allLegs.slice(0, -1)), auditRound: 1,
  })
  assert.equal(missingOne.report.status, 'INCOMPLETE')
  assert.equal(missingOne.coverage.pairwise.missingLegKeys.length, 1)

  const reservedKey = hash('reserved')
  const reserved: ExperimentProviderOperation = Object.freeze({
    cacheKey: reservedKey,
    role: 'audit',
    kind: 'score',
    detail: 'high',
    candidateId: 'c1',
    status: 'reserved',
    attempts: 1,
  })
  const blocked = computeAnchorLabAudit({
    binding: active, catalog, draft,
    evidence: auditEvidence(active, ids, assessments, allLegs, [reserved]), auditRound: 1,
  })
  assert.equal(blocked.report.status, 'INCOMPLETE')
  assert.deepEqual(blocked.coverage.unresolvedOperationKeys, [reservedKey])
})

test('complete exact coverage yields PASS and cannot be self-asserted early', () => {
  const { active, ids, catalog, draft, assessments, beforePairs } = advanceToPairPlan()
  const allLegs = beforePairs.pairPlan!.pairs.flatMap(pair => [
    pairLeg(pair.aId, pair.bId, 'AB'), pairLeg(pair.aId, pair.bId, 'BA'),
  ])
  const complete = computeAnchorLabAudit({
    binding: active, catalog, draft,
    evidence: auditEvidence(active, ids, assessments, allLegs), auditRound: 1,
  })
  assert.equal(complete.coverage.complete, true)
  assert.equal(complete.coverage.selectedHigh.completed, 2)
  assert.equal(complete.coverage.remainingLow.completed, 4)
  assert.equal(complete.coverage.promotionHigh.completed, complete.coverage.promotionHigh.planned)
  assert.equal(complete.coverage.pairwise.completedLegs, complete.coverage.pairwise.plannedLegs)
  assert.equal(complete.report.status, 'PASS')

  const forgedEarly = computeAnchorLabAudit({
    binding: active, catalog, draft,
    evidence: auditEvidence(active, ids, []), auditRound: 1,
  })
  assert.equal(forgedEarly.report.status, 'INCOMPLETE')
})

test('complete stronger challenger evidence yields terminal FAIL', () => {
  const context = setup()
  const selectedHigh = [assessment('s1', 'high', 90), assessment('s2', 'high', 80)]
  const remainingLow = [
    assessment('c1', 'low', 96), assessment('c2', 'low', 70),
    assessment('c3', 'low', 69), assessment('c4', 'low', 68),
  ]
  const first = computeAnchorLabAudit({
    binding: context.active, catalog: context.catalog, draft: context.draft,
    evidence: auditEvidence(context.active, context.ids, [...selectedHigh, ...remainingLow]),
    auditRound: 1,
  })
  const highs = first.promotionPlan!.promotionIds.map(id =>
    assessment(id, 'high', id === 'c1' ? 96 : 70))
  const second = computeAnchorLabAudit({
    binding: context.active, catalog: context.catalog, draft: context.draft,
    evidence: auditEvidence(context.active, context.ids, [...selectedHigh, ...remainingLow, ...highs]),
    auditRound: 1,
  })
  const legs = second.pairPlan!.pairs.flatMap(pair => [
    pairLeg(pair.aId, pair.bId, 'AB', 'tie'), pairLeg(pair.aId, pair.bId, 'BA', 'tie'),
  ])
  const result = computeAnchorLabAudit({
    binding: context.active, catalog: context.catalog, draft: context.draft,
    evidence: auditEvidence(context.active, context.ids, [...selectedHigh, ...remainingLow, ...highs], legs),
    auditRound: 1,
  })
  assert.equal(result.report.status, 'FAIL')
  assert.equal(result.report.strongerChallengerIds.includes('c1'), true)
})
