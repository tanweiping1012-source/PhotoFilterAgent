export interface FrozenSelectionReceiptItem {
  readonly id: string
  readonly sha256: string
}

export interface FrozenSelectionReceipt {
  readonly schemaVersion: 'photo-filter-selection-receipt/v2'
  readonly generator: '@photo-filter-agent/dsh-photo-filter-agent'
  readonly sourceRoot: string
  readonly excludedRelativePaths: readonly string[]
  readonly scanPolicyIdentity: string
  readonly datasetFingerprint: string
  readonly decisionIdentity: FrozenSelectionDecisionIdentity
  readonly selectionHash: string
  readonly candidateScope: 'auto' | 'people_only'
  readonly target: number
  readonly selectedItems: readonly FrozenSelectionReceiptItem[]
  readonly selectedOrder: readonly string[]
  readonly selectedContentHashes: readonly string[]
  readonly auditStatus: 'PASS'
  readonly routeIdentity: string
  readonly rubricIdentity: Readonly<{ version: string; hash: string }>
  readonly promptIdentity: Readonly<{
    selectorBaselineHash: string
    selectorPairwiseHash: string
    auditBaselineHash: string
    auditPairwiseHash: string
  }>
  readonly receiptHash: string
}

export interface FrozenSelectionDecisionIdentity {
  readonly highRefinementPlanVersion: string
  readonly localGateVersion: string
  readonly pairwisePlanVersion: string
  readonly preferenceHash: string
  readonly rankingPolicyVersion: string
  readonly selectorBaselineHash: string
  readonly selectorPairwiseHash: string
  readonly selectorRouteIdentity: string
}

export interface FrozenSelectionReceiptInput {
  readonly sourceRoot: string
  readonly excludedRelativePaths: readonly string[]
  readonly datasetFingerprint: string
  readonly decisionIdentity: FrozenSelectionDecisionIdentity
  readonly selectionHash: string
  readonly candidateScope: 'auto' | 'people_only'
  readonly target: number
  readonly selectedItems: readonly FrozenSelectionReceiptItem[]
  readonly selectedOrder: readonly string[]
  readonly auditStatus: 'PASS'
  readonly routeIdentity: string
  readonly rubricIdentity: Readonly<{ version: string; hash: string }>
  readonly promptIdentity: Readonly<{
    selectorBaselineHash: string
    selectorPairwiseHash: string
    auditBaselineHash: string
    auditPairwiseHash: string
  }>
}

export function createFrozenSelectionReceipt(
  input: FrozenSelectionReceiptInput,
): FrozenSelectionReceipt

export function serializeFrozenSelectionReceipt(receipt: FrozenSelectionReceipt): string
export function validateFrozenSelectionReceipt(value: unknown): FrozenSelectionReceipt
export function parseFrozenSelectionReceiptJson(text: string): FrozenSelectionReceipt
export function selectionReceiptHash(receipt: FrozenSelectionReceipt): string
export function photoScanPolicyIdentity(excludedRelativePaths: readonly string[]): string
export function sha256Hex(value: string | Uint8Array): string
export function selectionHashFromReceiptItems(input: {
  readonly rubricVersion: string
  readonly datasetFingerprint: string
  readonly candidateScope: 'auto' | 'people_only'
  readonly decisionIdentity: FrozenSelectionDecisionIdentity
  readonly selectedIds: readonly string[]
}): string
export const SELECTION_RECEIPT_SCHEMA_VERSION: 'photo-filter-selection-receipt/v2'
export const SELECTION_RECEIPT_GENERATOR: '@photo-filter-agent/dsh-photo-filter-agent'
export const PHOTO_SCAN_POLICY_VERSION: 'photo-scan-policy-v1'
