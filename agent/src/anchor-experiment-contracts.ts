import { createHash } from 'node:crypto'
import {
  freezeAnchorAbcManifest,
  type AnchorAbcManifestInput,
  type AnchorArmContracts,
  type FrozenAnchorAbcManifest,
} from './anchor-experiment-manifest.ts'
import { createPortraitEvaluationProfile, type PortraitEvaluationProfile } from './evaluation-profile.ts'
import { LOCAL_PORTRAIT_GATE_VERSION } from './local-eligibility.ts'
import {
  portraitAnchorStageContractHash,
  type VisualAnchorRuntime,
} from './portrait-anchor-vision.ts'
import {
  PORTRAIT_AUDIT_BASELINE_PROMPT_HASH,
  PORTRAIT_AUDIT_PAIRWISE_PROMPT_HASH,
  PORTRAIT_SELECTOR_BASELINE_PROMPT_HASH,
} from './portrait-vision.ts'
import {
  PORTRAIT_ANCHOR_RUBRIC_CONTENT_HASH,
  PORTRAIT_ANCHOR_RUBRIC_VERSION,
} from './portrait-anchor-rubric.ts'
import {
  PORTRAIT_BASELINE_RUBRIC,
  PORTRAIT_BASELINE_RUBRIC_VERSION,
} from './rubric.ts'
import { PORTRAIT_RANKING_POLICY_VERSION } from './ranking.ts'
import {
  HIGH_REFINEMENT_PLAN_VERSION,
  PAIRWISE_PLAN_VERSION,
} from './selection-budget.ts'
import { PORTRAIT_AUDIT_PLAN_VERSION } from './audit-v3.ts'

export const ANCHOR_EXPERIMENT_SELECTION_POLICY_VERSION =
  'portrait-anchor-experiment-ranking/v1' as const
export const ANCHOR_EXPERIMENT_MANIFEST_BUILDER_VERSION =
  'photo-filter-anchor-manifest-builder/v1' as const

export interface CompiledAnchorProfiles {
  readonly A: PortraitEvaluationProfile
  readonly B: PortraitEvaluationProfile
  readonly C: PortraitEvaluationProfile
}

export type CompiledAnchorAbcManifestInput = Omit<
  AnchorAbcManifestInput,
  'arms' | 'algorithmIdentity'
> & Readonly<{
  visualRuntime: VisualAnchorRuntime
}>

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function legacyRubricContentHash(): string {
  return sha256(JSON.stringify(PORTRAIT_BASELINE_RUBRIC))
}

function legacyContractHash(input: Readonly<{
  profile: PortraitEvaluationProfile
  role: 'selector' | 'audit'
  stage: 'low' | 'high' | 'pairwise'
}>): string {
  const promptHash = input.stage === 'pairwise'
    ? PORTRAIT_AUDIT_PAIRWISE_PROMPT_HASH
    : input.role === 'selector'
      ? PORTRAIT_SELECTOR_BASELINE_PROMPT_HASH
      : PORTRAIT_AUDIT_BASELINE_PROMPT_HASH
  const imageProtocol = input.stage === 'low'
    ? 'legacy-jpeg-low/v1'
    : input.stage === 'high'
      ? 'legacy-jpeg-high/v1'
      : 'legacy-direct-two-candidate-jpegs/v1'
  return sha256([
    'photo-filter-legacy-stage-contract/v1',
    input.profile.protocol,
    input.profile.rubricVersion,
    input.profile.rubricContentHash,
    input.role,
    input.stage,
    promptHash,
    imageProtocol,
  ].join('\u0000'))
}

export function createCompiledAnchorProfiles(anchorPackHash: string): CompiledAnchorProfiles {
  return Object.freeze({
    A: createPortraitEvaluationProfile({
      arm: 'A',
      rubricVersion: PORTRAIT_BASELINE_RUBRIC_VERSION,
      rubricContentHash: legacyRubricContentHash(),
    }),
    B: createPortraitEvaluationProfile({
      arm: 'B',
      rubricVersion: PORTRAIT_ANCHOR_RUBRIC_VERSION,
      rubricContentHash: PORTRAIT_ANCHOR_RUBRIC_CONTENT_HASH,
    }),
    C: createPortraitEvaluationProfile({
      arm: 'C',
      rubricVersion: PORTRAIT_ANCHOR_RUBRIC_VERSION,
      rubricContentHash: PORTRAIT_ANCHOR_RUBRIC_CONTENT_HASH,
      visualAnchorPackHash: anchorPackHash,
    }),
  })
}

export function compiledAnchorArmContracts(input: Readonly<{
  profile: PortraitEvaluationProfile
  visualRuntime?: VisualAnchorRuntime
}>): AnchorArmContracts {
  const { profile } = input
  if (profile.arm === 'A') {
    if (input.visualRuntime) throw new TypeError('A compiled contracts cannot contain visualRuntime')
    return Object.freeze({
      profile,
      selectorLowContractHash: legacyContractHash({ profile, role: 'selector', stage: 'low' }),
      selectorHighContractHash: legacyContractHash({ profile, role: 'selector', stage: 'high' }),
      selectorPairwiseContractHash: legacyContractHash({ profile, role: 'selector', stage: 'pairwise' }),
      auditLowContractHash: legacyContractHash({ profile, role: 'audit', stage: 'low' }),
      auditHighContractHash: legacyContractHash({ profile, role: 'audit', stage: 'high' }),
      auditPairwiseContractHash: legacyContractHash({ profile, role: 'audit', stage: 'pairwise' }),
      visualStages: Object.freeze([]),
    })
  }
  if (profile.arm === 'B' && input.visualRuntime) {
    throw new TypeError('B compiled contracts cannot contain visualRuntime')
  }
  if (profile.arm === 'C' && !input.visualRuntime) {
    throw new TypeError('C compiled contracts require visualRuntime')
  }
  const contract = (role: 'selector' | 'audit', stage: 'low' | 'high' | 'pairwise') =>
    portraitAnchorStageContractHash({
      profile,
      role,
      stage,
      ...(profile.arm === 'C' && stage !== 'low'
        ? { visualRuntime: input.visualRuntime }
        : {}),
    })
  return Object.freeze({
    profile,
    selectorLowContractHash: contract('selector', 'low'),
    selectorHighContractHash: contract('selector', 'high'),
    selectorPairwiseContractHash: contract('selector', 'pairwise'),
    auditLowContractHash: contract('audit', 'low'),
    auditHighContractHash: contract('audit', 'high'),
    auditPairwiseContractHash: contract('audit', 'pairwise'),
    visualStages: profile.arm === 'C'
      ? Object.freeze([
        'selector_high', 'selector_pairwise', 'audit_high', 'audit_pairwise',
      ])
      : Object.freeze([]),
  })
}

/**
 * Only this builder should be used by the DSH experiment runtime. Callers may
 * choose dataset/route/budget inputs, but cannot supply prompt hashes, profiles
 * or algorithm versions.
 */
export function buildCompiledAnchorAbcManifest(
  input: CompiledAnchorAbcManifestInput,
): FrozenAnchorAbcManifest {
  const profiles = createCompiledAnchorProfiles(input.visualAnchorPack.packHash)
  if (input.visualAnchorPack.rubricContentHash !== PORTRAIT_ANCHOR_RUBRIC_CONTENT_HASH
    || input.visualRuntime.protocol.anchorSheetSha256 !== input.visualAnchorPack.anchorSheetSha256
    || input.visualRuntime.protocol.layoutProtocolHash !== input.visualAnchorPack.layoutProtocolHash
    || input.visualRuntime.protocol.qualityReceiptHash
      !== input.visualAnchorPack.referenceSheetQualityReceipt.receiptHash) {
    throw new TypeError('compiled manifest visual runtime does not match the frozen pack/rubric/receipt')
  }
  return freezeAnchorAbcManifest({
    experimentId: input.experimentId,
    mode: input.mode,
    sourceSnapshotHash: input.sourceSnapshotHash,
    dataset: input.dataset,
    route: input.route,
    algorithmIdentity: Object.freeze({
      manifestBuilderVersion: ANCHOR_EXPERIMENT_MANIFEST_BUILDER_VERSION,
      experimentRankingPolicyVersion: ANCHOR_EXPERIMENT_SELECTION_POLICY_VERSION,
      legacyRankingPolicyVersion: PORTRAIT_RANKING_POLICY_VERSION,
      highPlanVersion: HIGH_REFINEMENT_PLAN_VERSION,
      pairwisePlanVersion: PAIRWISE_PLAN_VERSION,
      auditPlanVersion: PORTRAIT_AUDIT_PLAN_VERSION,
      localGateVersion: LOCAL_PORTRAIT_GATE_VERSION,
    }),
    budget: input.budget,
    visualAnchorPack: input.visualAnchorPack,
    contentOverlapPreflight: input.contentOverlapPreflight,
    arms: {
      A: compiledAnchorArmContracts({ profile: profiles.A }),
      B: compiledAnchorArmContracts({ profile: profiles.B }),
      C: compiledAnchorArmContracts({ profile: profiles.C, visualRuntime: input.visualRuntime }),
    },
    oracle: input.oracle,
  })
}
