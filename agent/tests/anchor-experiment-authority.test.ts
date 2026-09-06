import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  AnchorExperimentAuthorityError,
  aggregateExperimentComparisons,
  createAnchorLabCandidateCatalog,
  createAnchorLabDerivedAuthority,
  createAnchorLabSelectorFeedback,
  createFrozenSelectorRound,
  type AnchorLabSelectionPolicy,
} from '../src/anchor-experiment-authority.ts'
import {
  computeAnchorLabAudit,
  createAnchorLabHistoricalAuditRecompute,
} from '../src/anchor-experiment-audit-authority.ts'
import type {
  AnchorExperimentAuditEvidenceView,
  AnchorExperimentEvidenceView,
  AnchorExperimentRunBinding,
  ExperimentAssessment,
  ExperimentPairwiseLegRecord,
} from '../src/anchor-experiment-state.ts'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')

function binding(overrides: Partial<AnchorExperimentRunBinding> = {}): AnchorExperimentRunBinding {
  const routeIdentityHash = hash(['provider', 'model', 'protocol', ''].join('\u0000'))
  const base = {
    schemaVersion: 'photo-filter-anchor-experiment-binding/v1' as const,
    experimentId: 'photo-anchor-lab-codex-v1:test-001',
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
      highCap: 4, pairwisePairCap: 2, auditCallCapPerTurn: 2,
      maxCompleteAuditRounds: 2,
    }),
  }
  const merged = { ...base, ...overrides }
  return Object.freeze({
    ...merged,
    stateNamespaceHash: overrides.stateNamespaceHash ?? hash([
      'photo-filter-anchor-experiment-binding/v1', merged.experimentId, merged.arm,
      merged.manifestHash, merged.routeIdentityHash, merged.datasetFingerprint,
    ].join('\u0000')),
  }) as AnchorExperimentRunBinding
}

function score(
  id: string,
  detail: 'low' | 'high',
  eligibility: ExperimentAssessment['eligibility'] = 'eligible',
  value: number | null = 80,
): ExperimentAssessment {
  return {
    contract: 'portrait-anchor-rubric/v1',
    id,
    role: 'selector',
    detail,
    eligibility,
    score: value,
    scoreInterval: value === null ? null : [value - 2, value + 2],
    scoreIntervalSource: 'local_confidence_radius',
    overallConfidence: 0.9,
    summary: `${id}-${detail}`,
    raw: {
      id,
      dimensionScores: {
        expression_eye_naturalness: value ?? 75,
        facial_features_shape: value ?? 75,
        pose_keepworthy_moment: value ?? 75,
        technical_completion: value ?? 75,
        environment_frame: value ?? 75,
      },
    },
  } as ExperimentAssessment
}

function evidence(
  active: AnchorExperimentRunBinding,
  ids: readonly string[],
  assessments: readonly ExperimentAssessment[],
  legs: readonly ExperimentPairwiseLegRecord[] = [],
): AnchorExperimentEvidenceView {
  return Object.freeze({
    binding: active,
    candidateIds: Object.freeze([...ids]),
    selectorScores: Object.freeze(assessments.map((assessment, index) => Object.freeze([
      `slot-${index}`,
      Object.freeze({ assessment, cacheKey: hash(`score-${index}-${assessment.id}-${assessment.detail}`) }),
    ] as const))),
    auditScores: Object.freeze([]),
    selectorPairwiseLegs: Object.freeze(legs.map(record => Object.freeze([
      record.cacheKey, record,
    ] as const))),
    auditPairwiseLegs: Object.freeze([]),
    providerOperations: Object.freeze([]),
  })
}

function leg(input: Readonly<{
  aId: string
  bId: string
  order: 'AB' | 'BA'
  result?: 'left' | 'right' | 'tie' | 'reject_both'
  margin?: number
  suffix?: string
}>): ExperimentPairwiseLegRecord {
  const result = input.result ?? 'left'
  const margin = input.margin ?? (result === 'right' ? -4 : result === 'left' ? 4 : 0)
  return Object.freeze({
    aId: input.aId,
    bId: input.bId,
    role: 'selector',
    order: input.order,
    decision: Object.freeze({
      contract: 'portrait-anchor-pairwise/v1',
      order: input.order,
      result,
      weightedMargin: margin,
      confidence: 0.9,
      reason: result,
      raw: Object.freeze({ leftTier: 'keep', rightTier: 'keep' }),
    }),
    cacheKey: hash(`${input.aId}-${input.bId}-${input.order}-${input.suffix ?? ''}`),
  })
}

function auditScore(
  id: string,
  detail: 'low' | 'high',
  value: number,
): ExperimentAssessment {
  return Object.freeze({
    ...score(id, detail, 'eligible', value),
    role: 'audit' as const,
  }) as ExperimentAssessment
}

function auditLeg(
  aId: string,
  bId: string,
  order: 'AB' | 'BA',
): ExperimentPairwiseLegRecord {
  return Object.freeze({
    aId,
    bId,
    role: 'audit' as const,
    order,
    decision: Object.freeze({
      contract: 'portrait-anchor-pairwise/v1',
      order,
      result: 'tie' as const,
      weightedMargin: 0,
      confidence: 0.9,
      reason: 'tie',
      raw: Object.freeze({ leftTier: 'keep', rightTier: 'keep' }),
    }),
    cacheKey: hash(`audit-${aId}-${bId}-${order}`),
  })
}

function isolatedAuditEvidence(
  active: AnchorExperimentRunBinding,
  ids: readonly string[],
  assessments: readonly ExperimentAssessment[],
  legs: readonly ExperimentPairwiseLegRecord[] = [],
): AnchorExperimentAuditEvidenceView {
  return Object.freeze({
    binding: active,
    candidateIds: Object.freeze([...ids]),
    auditScores: Object.freeze(assessments.map((assessment, index) => Object.freeze([
      `audit-slot-${index}`,
      Object.freeze({ assessment, cacheKey: hash(`audit-score-${index}-${assessment.id}-${assessment.detail}`) }),
    ] as const))),
    auditPairwiseLegs: Object.freeze(legs.map(record => Object.freeze([
      record.cacheKey, record,
    ] as const))),
    providerOperations: Object.freeze([]),
  })
}

function setup(ids = ['p1', 'p2', 'p3', 'p4']) {
  const active = binding()
  const catalog = createAnchorLabCandidateCatalog({
    binding: active,
    candidates: ids.map((id, index) => ({
      id,
      familyId: index < 2 ? 'f1' : `f${index}`,
      diversityTags: [`pose:${index}`],
      localEligibility: 'eligible' as const,
      preferenceAdjustment: 0,
    })),
  })
  const policy: AnchorLabSelectionPolicy = Object.freeze({
    preferenceHash: active.preferenceHash,
    diversityStrength: 0,
    familyCap: 'auto',
    diversityProtocol: 'disabled',
  })
  const round = createFrozenSelectorRound({
    binding: active, round: 1, existingComparisons: [],
  })
  return { active, catalog, policy, round }
}

test('selector round keeps pair plan stable as current-round AB/BA legs arrive', () => {
  const { active, catalog, policy, round } = setup()
  const assessments = catalog.candidates.flatMap((row, index) => [
    score(row.id, 'low', 'eligible', 90 - index),
    score(row.id, 'high', 'eligible', 91 - index),
  ])
  const authority = createAnchorLabDerivedAuthority({
    binding: active, candidateCatalog: catalog, selectionPolicy: policy,
    selectorRound: round, expectedPersistedPhase: 'pairwise',
  })
  const emptyEvidence = evidence(active, catalog.candidates.map(row => row.id), assessments)
  const refinement = authority.recomputeRefinementCheckpoint!(emptyEvidence)!
  const before = authority.recomputePairwiseCheckpoint!(emptyEvidence, refinement)!
  const pair = before.plan.pairs[0]
  const afterEvidence = evidence(active, catalog.candidates.map(row => row.id), assessments, [
    leg({ aId: pair.leftId, bId: pair.rightId, order: 'AB' }),
    leg({ aId: pair.leftId, bId: pair.rightId, order: 'BA' }),
  ])
  const after = authority.recomputePairwiseCheckpoint!(afterEvidence, refinement)!

  assert.deepEqual(after, before)
})

test('reversed caller orientation becomes one logical pair and inconsistent AB/BA is a tie', () => {
  const active = binding()
  const reversed = aggregateExperimentComparisons({ binding: active, legs: [
    leg({ aId: 'p2', bId: 'p1', order: 'BA', result: 'right', margin: -4 }),
    leg({ aId: 'p2', bId: 'p1', order: 'AB', result: 'right', margin: -4 }),
  ] })
  assert.equal(reversed.length, 1)
  assert.equal(reversed[0].aId, 'p1')
  assert.equal(reversed[0].bId, 'p2')
  assert.equal(reversed[0].result.leftOutcome, 1)

  const unstable = aggregateExperimentComparisons({ binding: active, legs: [
    leg({ aId: 'p1', bId: 'p2', order: 'AB', result: 'left', margin: 4 }),
    leg({ aId: 'p1', bId: 'p2', order: 'BA', result: 'right', margin: -4 }),
  ] })
  assert.equal(unstable[0].terminal, 'tie')
  assert.equal(unstable[0].result.leftOutcome, 0.5)
})

test('low uncertain is mandatory high and budget overflow fails closed', () => {
  const { active, catalog, policy, round } = setup(['p1', 'p2', 'p3'])
  const authority = createAnchorLabDerivedAuthority({
    binding: active, candidateCatalog: catalog, selectionPolicy: policy,
    selectorRound: round, expectedPersistedPhase: 'refinement',
  })
  const low = [
    score('p1', 'low', 'needs_review', null),
    score('p2', 'low', 'eligible', 80),
    score('p3', 'low', 'eligible', 79),
  ]
  const plan = authority.recomputeRefinementCheckpoint!(evidence(active, ['p1', 'p2', 'p3'], low))!
  assert.equal(plan.plan.candidateIds.includes('p1'), true)

  const tight = binding({
    targetK: 1,
    budget: Object.freeze({
      highCap: 1, pairwisePairCap: 1, auditCallCapPerTurn: 1,
      maxCompleteAuditRounds: 2,
    }),
  })
  const tightCatalog = createAnchorLabCandidateCatalog({
    binding: tight,
    candidates: ['p1', 'p2', 'p3'].map(id => ({
      id, diversityTags: ['portrait'], localEligibility: 'eligible' as const,
      preferenceAdjustment: 0,
    })),
  })
  const tightRound = createFrozenSelectorRound({ binding: tight, round: 1, existingComparisons: [] })
  const tightAuthority = createAnchorLabDerivedAuthority({
    binding: tight,
    candidateCatalog: tightCatalog,
    selectionPolicy: { ...policy, preferenceHash: tight.preferenceHash },
    selectorRound: tightRound,
    expectedPersistedPhase: 'refinement',
  })
  assert.throws(
    () => tightAuthority.recomputeRefinementCheckpoint!(evidence(tight, ['p1', 'p2', 'p3'], [
      score('p1', 'low', 'needs_review', null),
      score('p2', 'low', 'needs_review', null),
      score('p3', 'low', 'needs_review', null),
    ])),
    (error: unknown) => error instanceof AnchorExperimentAuthorityError
      && error.code === 'MANDATORY_HIGH_EXCEEDS_BUDGET',
  )
})

test('non-zero diversity cannot run without complete shared catalog tags', () => {
  const { active, policy, round } = setup(['p1', 'p2'])
  const catalog = createAnchorLabCandidateCatalog({
    binding: active,
    candidates: [
      { id: 'p1', diversityTags: ['close'], localEligibility: 'eligible', preferenceAdjustment: 0 },
      { id: 'p2', diversityTags: [], localEligibility: 'eligible', preferenceAdjustment: 0 },
    ],
  })
  assert.throws(
    () => createAnchorLabDerivedAuthority({
      binding: active,
      candidateCatalog: catalog,
      selectionPolicy: {
        ...policy, diversityStrength: 1, diversityProtocol: 'catalog-v1',
      },
      selectorRound: round,
      expectedPersistedPhase: 'baseline',
    }),
    (error: unknown) => error instanceof AnchorExperimentAuthorityError
      && error.code === 'DIVERSITY_CONTRACT_UNAVAILABLE',
  )
})

test('draft waits for every frozen AB/BA leg and then emits exact K', () => {
  const { active, catalog, policy, round } = setup()
  const assessments = catalog.candidates.flatMap((row, index) => [
    score(row.id, 'low', 'eligible', 90 - index),
    score(row.id, 'high', 'eligible', 92 - index),
  ])
  const authority = createAnchorLabDerivedAuthority({
    binding: active, candidateCatalog: catalog, selectionPolicy: policy,
    selectorRound: round, expectedPersistedPhase: 'selection',
  })
  const baseEvidence = evidence(active, catalog.candidates.map(row => row.id), assessments)
  const refinement = authority.recomputeRefinementCheckpoint!(baseEvidence)!
  const pairwise = authority.recomputePairwiseCheckpoint!(baseEvidence, refinement)!
  const allLegs = pairwise.plan.pairs.flatMap(pair => [
    leg({ aId: pair.leftId, bId: pair.rightId, order: 'AB', suffix: pair.source }),
    leg({ aId: pair.leftId, bId: pair.rightId, order: 'BA', suffix: pair.source }),
  ])
  const partial = evidence(active, catalog.candidates.map(row => row.id), assessments, allLegs.slice(0, -1))
  assert.equal(authority.recomputeDraft!(partial, refinement, pairwise), undefined)

  const complete = evidence(active, catalog.candidates.map(row => row.id), assessments, allLegs)
  const draft = authority.recomputeDraft!(complete, refinement, pairwise)!
  assert.equal(draft.keep.length, active.targetK)
  assert.equal(new Set(draft.keep).size, active.targetK)
  assert.equal(Object.keys(draft.scores).length, active.targetK)
})

test('round two is rebuilt from terminal FAIL while later high and pair evidence cannot rewrite round one', () => {
  const ids = ['p1', 'p2', 'p3', 'p4']
  const { active, catalog, policy, round: roundOne } = setup(ids)
  const selectorScores = ids.flatMap((id, index) => [
    score(id, 'low', 'eligible', 90 - index),
    // Deliberately include every high, including rows that were not in the
    // round-one refinement plan. Historical reconstruction must hide them.
    score(id, 'high', 'eligible', 92 - index),
  ])
  const roundOneAuthority = createAnchorLabDerivedAuthority({
    binding: active,
    candidateCatalog: catalog,
    selectionPolicy: policy,
    selectorRound: roundOne,
    expectedPersistedPhase: 'selection',
  })
  const beforePairwise = evidence(active, ids, selectorScores)
  const refinement = roundOneAuthority.recomputeRefinementCheckpoint!(beforePairwise)!
  const pairwise = roundOneAuthority.recomputePairwiseCheckpoint!(beforePairwise, refinement)!
  const plannedSelectorLegs = pairwise.plan.pairs.flatMap(pair => [
    leg({ aId: pair.leftId, bId: pair.rightId, order: 'AB', suffix: pair.source }),
    leg({ aId: pair.leftId, bId: pair.rightId, order: 'BA', suffix: pair.source }),
  ])
  const selectorRoundOneEvidence = evidence(active, ids, selectorScores, plannedSelectorLegs)
  const draft = roundOneAuthority.recomputeDraft!(selectorRoundOneEvidence, refinement, pairwise)!

  const selected = new Set(draft.keep)
  const remaining = ids.filter(id => !selected.has(id))
  const selectedAssessments = draft.keep.map((id, index) =>
    auditScore(id, 'high', index === draft.keep.length - 1 ? 80 : 90))
  const remainingAssessments = remaining.map((id, index) =>
    auditScore(id, 'low', index === 0 ? 99 : 60 - index))
  const auditBase = [...selectedAssessments, ...remainingAssessments]
  const afterLow = computeAnchorLabAudit({
    binding: active,
    catalog,
    draft,
    evidence: isolatedAuditEvidence(active, ids, auditBase),
    auditRound: 1,
  })
  const promoted = afterLow.promotionPlan!.promotionIds.map(id =>
    auditScore(id, 'high', id === remaining[0] ? 99 : 60))
  const auditScores = [...auditBase, ...promoted]
  const afterPromotion = computeAnchorLabAudit({
    binding: active,
    catalog,
    draft,
    evidence: isolatedAuditEvidence(active, ids, auditScores),
    auditRound: 1,
  })
  const plannedAuditLegs = afterPromotion.pairPlan!.pairs.flatMap(pair => [
    auditLeg(pair.aId, pair.bId, 'AB'),
    auditLeg(pair.aId, pair.bId, 'BA'),
  ])
  const auditComplete = computeAnchorLabAudit({
    binding: active,
    catalog,
    draft,
    evidence: isolatedAuditEvidence(active, ids, auditScores, plannedAuditLegs),
    auditRound: 1,
  })
  assert.equal(auditComplete.report.status, 'FAIL')

  const usedComparisons = aggregateExperimentComparisons({
    binding: active,
    legs: plannedSelectorLegs,
  })
  const feedback = createAnchorLabSelectorFeedback({
    binding: active,
    failedAuditRound: 1,
    failedSelectionHash: draft.selectionHash,
    strongerChallengerIds: auditComplete.report.strongerChallengerIds,
    disqualifiedSelectedIds: auditComplete.report.disqualifiedSelectedIds,
  })
  const roundTwo = createFrozenSelectorRound({
    binding: active,
    round: 2,
    existingComparisons: usedComparisons,
    priorSelectionHash: draft.selectionHash,
    feedback,
  })

  const plannedSelectorPairs = new Set(pairwise.plan.pairs
    .map(pair => [pair.leftId, pair.rightId].sort().join('\u0000')))
  const extraPair = ids.flatMap((left, index) => ids.slice(index + 1)
    .map(right => [left, right] as const))
    .find(([left, right]) => !plannedSelectorPairs.has([left, right].sort().join('\u0000')))!
  const futureSelectorLegs = [
    leg({ aId: extraPair[0], bId: extraPair[1], order: 'AB', suffix: 'future' }),
    leg({ aId: extraPair[0], bId: extraPair[1], order: 'BA', suffix: 'future' }),
  ]
  const plannedAuditPairs = new Set(afterPromotion.pairPlan!.pairs
    .map(pair => [pair.aId, pair.bId].sort().join('\u0000')))
  const extraAuditPair = ids.flatMap((left, index) => ids.slice(index + 1)
    .map(right => [left, right] as const))
    .find(([left, right]) => !plannedAuditPairs.has([left, right].sort().join('\u0000')))!
  const futureAuditLegs = [
    auditLeg(extraAuditPair[0], extraAuditPair[1], 'AB'),
    auditLeg(extraAuditPair[0], extraAuditPair[1], 'BA'),
  ]
  const fullSelectorEvidence = evidence(
    active, ids, selectorScores, [...plannedSelectorLegs, ...futureSelectorLegs],
  )
  const fullAuditEvidence = isolatedAuditEvidence(
    active, ids, auditScores, [...plannedAuditLegs, ...futureAuditLegs],
  )
  const roundTwoAuthority = createAnchorLabDerivedAuthority({
    binding: active,
    candidateCatalog: catalog,
    selectionPolicy: policy,
    selectorRound: roundTwo,
    expectedPersistedPhase: 'baseline',
    recomputeHistoricalAudit: createAnchorLabHistoricalAuditRecompute({ binding: active, catalog }),
  })
  assert.deepEqual(
    roundTwoAuthority.recomputeSelectorRound!(fullSelectorEvidence, fullAuditEvidence),
    roundTwo,
  )
})
