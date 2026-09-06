/**
 * Deterministic, offline portrait eligibility facts.
 *
 * These facts are intentionally separate from the visual-model rubric: they
 * can block ranking without rewriting a paid model response or its cache.
 */

import type { Candidate } from './engine.ts'

export const LOCAL_PORTRAIT_GATE_VERSION = 'local-portrait-gate-v1'

export type LocalPortraitFailureCode = 'LOCAL_EYES_CLOSED'

export interface LocalPortraitEligibility {
  eligible: boolean
  failureCodes: readonly LocalPortraitFailureCode[]
}

/** Baseline policy: a conservative local closed-eye fact is a technical reject. */
export function localPortraitEligibility(candidate: Candidate): LocalPortraitEligibility {
  const failureCodes: LocalPortraitFailureCode[] = []
  if (candidate.eyes_closed === true) failureCodes.push('LOCAL_EYES_CLOSED')
  return Object.freeze({
    eligible: failureCodes.length === 0,
    failureCodes: Object.freeze(failureCodes),
  })
}

export function localPortraitEligible(candidate: Candidate): boolean {
  return localPortraitEligibility(candidate).eligible
}
