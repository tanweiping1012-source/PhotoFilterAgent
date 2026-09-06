import { join } from 'node:path'

/**
 * Private identity for the Codex anchor experiment route.
 *
 * This is intentionally not named `photo-curator`, `photo-v4` or the generic
 * `photo-anchor-abc`: those names may be owned by the product route or another
 * experimental implementation. Every installed/runtime surface must use this
 * identity so two implementations can coexist without sharing state or tools.
 */
export const PHOTO_ANCHOR_LAB_CODEX_ID = 'photo-anchor-lab-codex-v1' as const
export const PHOTO_ANCHOR_LAB_CODEX_NAME = 'Photo Curator Anchor Lab (Codex)' as const
export const PHOTO_ANCHOR_LAB_CODEX_PACKAGE =
  '@photo-filter-agent/dsh-photo-anchor-lab-codex-v1' as const
export const PHOTO_ANCHOR_LAB_CODEX_PRESET_ID = PHOTO_ANCHOR_LAB_CODEX_ID
/** The lab is a user preset hosted by the stock DSH Web profile, not a global custom profile. */
export const PHOTO_ANCHOR_LAB_CODEX_HOST_PROFILE_ID = 'web' as const
export const PHOTO_ANCHOR_LAB_CODEX_TOOL_PREFIX = 'anchor_lab_codex_' as const
export const PHOTO_ANCHOR_LAB_CODEX_STATE_SCHEMA =
  'photo-anchor-lab-codex-v1/state/v1' as const
export const PHOTO_ANCHOR_LAB_CODEX_ARTIFACT_SCHEMA =
  'photo-anchor-lab-codex-v1/artifacts/v1' as const
export const PHOTO_ANCHOR_LAB_CODEX_SELECTOR_ROUND_SCHEMA =
  'photo-anchor-lab-codex-selector-round/v1' as const

const HASH_PATTERN = /^[a-f0-9]{64}$/u
const EXPERIMENT_ID_PATTERN =
  /^photo-anchor-lab-codex-v1(?:[-:][A-Za-z0-9][A-Za-z0-9._:-]{0,127})?$/u

export class PhotoAnchorLabCodexIdentityError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'PhotoAnchorLabCodexIdentityError'
    this.code = code
  }
}

/** Require every manifest run to carry this route's own namespace. */
export function assertPhotoAnchorLabCodexExperimentId(experimentId: string): void {
  if (!EXPERIMENT_ID_PATTERN.test(experimentId)) {
    throw new PhotoAnchorLabCodexIdentityError(
      'CODEX_ANCHOR_LAB_EXPERIMENT_ID_MISMATCH',
      `experimentId 必须属于 ${PHOTO_ANCHOR_LAB_CODEX_ID} 命名空间。`,
    )
  }
}

function assertNamespaceHash(stateNamespaceHash: string): void {
  if (!HASH_PATTERN.test(stateNamespaceHash)) {
    throw new PhotoAnchorLabCodexIdentityError(
      'CODEX_ANCHOR_LAB_NAMESPACE_HASH_INVALID',
      'stateNamespaceHash 必须是 64 位小写 SHA-256。',
    )
  }
}

/**
 * State and artifacts are separated even when another Agent uses the same
 * parent work directory. No caller may flatten these paths back into the
 * legacy Photo Curator directory.
 */
export function photoAnchorLabCodexStateDirectory(
  workdir: string,
  stateNamespaceHash: string,
): string {
  assertNamespaceHash(stateNamespaceHash)
  return join(workdir, PHOTO_ANCHOR_LAB_CODEX_ID, 'state', stateNamespaceHash)
}

export function photoAnchorLabCodexArtifactDirectory(
  workdir: string,
  stateNamespaceHash: string,
): string {
  assertNamespaceHash(stateNamespaceHash)
  return join(workdir, PHOTO_ANCHOR_LAB_CODEX_ID, 'artifacts', stateNamespaceHash)
}

export const PHOTO_ANCHOR_LAB_CODEX_IDENTITY = Object.freeze({
  productName: PHOTO_ANCHOR_LAB_CODEX_NAME,
  technicalId: PHOTO_ANCHOR_LAB_CODEX_ID,
  packageName: PHOTO_ANCHOR_LAB_CODEX_PACKAGE,
  presetId: PHOTO_ANCHOR_LAB_CODEX_PRESET_ID,
  hostProfileId: PHOTO_ANCHOR_LAB_CODEX_HOST_PROFILE_ID,
  toolPrefix: PHOTO_ANCHOR_LAB_CODEX_TOOL_PREFIX,
  stateSchema: PHOTO_ANCHOR_LAB_CODEX_STATE_SCHEMA,
  artifactSchema: PHOTO_ANCHOR_LAB_CODEX_ARTIFACT_SCHEMA,
  selectorRoundSchema: PHOTO_ANCHOR_LAB_CODEX_SELECTOR_ROUND_SCHEMA,
})
