import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  AnchorLabStateCoordinationError,
  AnchorLabStateCoordinator,
  claimAnchorLabStateOwner,
} from '../src/anchor-lab-codex-state-coordinator.ts'

const namespace = 'a'.repeat(64)

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'anchor-state-coordinator-'))
  return {
    directory,
    stateFile: join(directory, 'namespace', 'state.json'),
  }
}

test('state namespace owner is idempotent for one parent and rejects another', async () => {
  const { stateFile } = await fixture()
  const input = { stateFile, stateNamespaceHash: namespace, ownerSessionId: 'parent-1' }
  await claimAnchorLabStateOwner(input)
  await claimAnchorLabStateOwner(input)
  await assert.rejects(
    () => claimAnchorLabStateOwner({ ...input, ownerSessionId: 'parent-2' }),
    (error: unknown) => error instanceof AnchorLabStateCoordinationError
      && error.code === 'STATE_NAMESPACE_OWNED_BY_ANOTHER_SESSION',
  )
})

test('transaction serializes state and tracks the durable content version', async () => {
  const { stateFile } = await fixture()
  const coordinator = new AnchorLabStateCoordinator({
    stateFile, stateNamespaceHash: namespace, ownerSessionId: 'parent-1',
  })
  assert.equal(await coordinator.initialize(), null)
  await coordinator.transact(async () => {
    await writeFile(stateFile, '{"version":1}', { mode: 0o600 })
  })
  assert.match(coordinator.expectedHash ?? '', /^[a-f0-9]{64}$/u)
  await coordinator.transact(async () => {
    const previous = JSON.parse(await readFile(stateFile, 'utf8'))
    await writeFile(stateFile, JSON.stringify({ version: previous.version + 1 }), { mode: 0o600 })
  })
  assert.deepEqual(JSON.parse(await readFile(stateFile, 'utf8')), { version: 2 })
})

test('stale process is blocked by compare-and-swap before its callback runs', async () => {
  const { stateFile } = await fixture()
  const input = { stateFile, stateNamespaceHash: namespace, ownerSessionId: 'parent-1' }
  const first = new AnchorLabStateCoordinator(input)
  const stale = new AnchorLabStateCoordinator(input)
  await first.initialize()
  await stale.initialize()
  await first.transact(async () => {
    await writeFile(stateFile, '{"writer":"first"}', { mode: 0o600 })
  })
  let invoked = false
  await assert.rejects(
    () => stale.transact(async () => {
      invoked = true
    }),
    (error: unknown) => error instanceof AnchorLabStateCoordinationError
      && error.code === 'STATE_COMPARE_AND_SWAP_MISMATCH',
  )
  assert.equal(invoked, false)
  assert.deepEqual(JSON.parse(await readFile(stateFile, 'utf8')), { writer: 'first' })
})

test('existing lock is fail-closed and is never guessed stale', async () => {
  const { stateFile } = await fixture()
  const coordinator = new AnchorLabStateCoordinator({
    stateFile, stateNamespaceHash: namespace, ownerSessionId: 'parent-1',
  })
  await coordinator.initialize()
  await mkdir(coordinator.lockDirectory, { mode: 0o700 })
  let invoked = false
  await assert.rejects(
    () => coordinator.transact(async () => {
      invoked = true
    }),
    (error: unknown) => error instanceof AnchorLabStateCoordinationError
      && error.code === 'STATE_LOCK_HELD',
  )
  assert.equal(invoked, false)
})

test('corrupt owner record blocks resume instead of taking it over', async () => {
  const { stateFile } = await fixture()
  const input = { stateFile, stateNamespaceHash: namespace, ownerSessionId: 'parent-1' }
  await claimAnchorLabStateOwner(input)
  await writeFile(join(stateFile, '..', 'owner.json'), '{broken')
  await assert.rejects(
    () => claimAnchorLabStateOwner(input),
    (error: unknown) => error instanceof AnchorLabStateCoordinationError
      && error.code === 'STATE_OWNER_RECORD_CORRUPT',
  )
})

test('ownerless legacy checkpoint is never adopted by a new session', async () => {
  const { stateFile } = await fixture()
  await mkdir(join(stateFile, '..'), { recursive: true })
  await writeFile(stateFile, '{"unknown":"prior-owner"}', { mode: 0o600 })
  await assert.rejects(
    () => claimAnchorLabStateOwner({
      stateFile, stateNamespaceHash: namespace, ownerSessionId: 'parent-1',
    }),
    (error: unknown) => error instanceof AnchorLabStateCoordinationError
      && error.code === 'STATE_OWNER_MISSING_FOR_EXISTING_STATE',
  )
})

test('transaction revalidates owner after initialization before callback', async () => {
  const { stateFile } = await fixture()
  const coordinator = new AnchorLabStateCoordinator({
    stateFile, stateNamespaceHash: namespace, ownerSessionId: 'parent-1',
  })
  await coordinator.initialize()
  await writeFile(join(stateFile, '..', 'owner.json'), JSON.stringify({
    schemaVersion: 'photo-anchor-lab-codex-state-owner/v1',
    technicalId: 'photo-anchor-lab-codex-v1',
    stateNamespaceHash: namespace,
    ownerSessionId: 'parent-2',
  }))
  let invoked = false
  await assert.rejects(
    () => coordinator.transact(async () => {
      invoked = true
    }),
    (error: unknown) => error instanceof AnchorLabStateCoordinationError
      && error.code === 'STATE_NAMESPACE_OWNED_BY_ANOTHER_SESSION',
  )
  assert.equal(invoked, false)
})
