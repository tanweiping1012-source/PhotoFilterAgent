import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PHOTO_ANCHOR_LAB_CODEX_IDENTITY,
  PhotoAnchorLabCodexIdentityError,
  assertPhotoAnchorLabCodexExperimentId,
  photoAnchorLabCodexArtifactDirectory,
  photoAnchorLabCodexStateDirectory,
} from '../src/anchor-lab-codex-identity.ts'

const namespaceHash = 'a'.repeat(64)

test('Codex anchor lab identity cannot collide with existing product routes', () => {
  const reserved = new Set([
    'photo-curator',
    'photo-filter-v4',
    'photo-v4',
    'photo-anchor-abc',
    '@photo-filter-agent/dsh-photo-filter-agent',
    '@photo-filter-agent/dsh-photo-filter-v4',
  ])
  for (const value of [
    PHOTO_ANCHOR_LAB_CODEX_IDENTITY.technicalId,
    PHOTO_ANCHOR_LAB_CODEX_IDENTITY.presetId,
    PHOTO_ANCHOR_LAB_CODEX_IDENTITY.packageName,
  ]) assert.equal(reserved.has(value), false)
  assert.equal(PHOTO_ANCHOR_LAB_CODEX_IDENTITY.hostProfileId, 'web')
  assert.equal(Object.isFrozen(PHOTO_ANCHOR_LAB_CODEX_IDENTITY), true)
  assert.equal(PHOTO_ANCHOR_LAB_CODEX_IDENTITY.toolPrefix, 'anchor_lab_codex_')
})

test('experiment and durable paths remain inside the Codex namespace', () => {
  assert.doesNotThrow(() => assertPhotoAnchorLabCodexExperimentId(
    'photo-anchor-lab-codex-v1:acceptance-001',
  ))
  assert.equal(
    photoAnchorLabCodexStateDirectory('/private/work', namespaceHash),
    `/private/work/photo-anchor-lab-codex-v1/state/${namespaceHash}`,
  )
  assert.equal(
    photoAnchorLabCodexArtifactDirectory('/private/work', namespaceHash),
    `/private/work/photo-anchor-lab-codex-v1/artifacts/${namespaceHash}`,
  )
})

test('foreign experiment IDs and malformed namespace hashes fail closed', () => {
  assert.throws(
    () => assertPhotoAnchorLabCodexExperimentId('photo-anchor-abc:acceptance-001'),
    (error: unknown) => error instanceof PhotoAnchorLabCodexIdentityError
      && error.code === 'CODEX_ANCHOR_LAB_EXPERIMENT_ID_MISMATCH',
  )
  assert.throws(
    () => photoAnchorLabCodexStateDirectory('/private/work', '../shared'),
    (error: unknown) => error instanceof PhotoAnchorLabCodexIdentityError
      && error.code === 'CODEX_ANCHOR_LAB_NAMESPACE_HASH_INVALID',
  )
})
