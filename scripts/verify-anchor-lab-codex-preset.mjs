#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const EXPECTED_TOOLS = Object.freeze([
  'anchor_lab_codex_activate',
  'anchor_lab_codex_analyze_folder',
  'anchor_lab_codex_audit_selection',
  'anchor_lab_codex_build_selection',
  'anchor_lab_codex_evaluate_pool',
  'anchor_lab_codex_independent_evaluator',
  'anchor_lab_codex_propose_selection',
].sort())

function fail(message) {
  throw new Error(`verify-anchor-lab-codex-preset: ${message}`)
}

const [harnessRoot, dshHome, presetId = 'photo-anchor-lab-codex-v1'] = process.argv.slice(2)
if (!isAbsolute(harnessRoot ?? '') || !isAbsolute(dshHome ?? '')) {
  fail('usage: verify-anchor-lab-codex-preset.mjs <absolute harness> <absolute DSH_HOME> [preset-id]')
}
if (presetId !== 'photo-anchor-lab-codex-v1') fail(`unexpected preset id ${presetId}`)
process.env.DSH_HOME = dshHome

// Mount the real Web composition while disabling only browser/network surface
// glue. Agent Presets, tools, LLM metadata, attachments and in-process
// subagents remain the production rc.8 implementations being verified.
const patchPath = join(dshHome, 'verify-anchor-lab-codex-host.patch.yml')
await mkdir(dshHome, { recursive: true, mode: 0o700 })
await writeFile(patchPath, `
- id: webserver
  disabled: true
- id: web-runtime
  disabled: true
- id: session-telemetry-otel
  disabled: true
- id: modules
  disabled: true
- id: connection
  disabled: true
- id: client-hmr
  disabled: true
- id: directory-picker
  disabled: true
- insert:
    - id: directory-picker-browse
      name: '@deepseek-ai/dsh-host-directory-picker-browse'
    - id: ui-directory-picker-browse
      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'
`, { mode: 0o600 })

const [{ runProfile }, { loadLayeredEnv }, { SessionId }] = await Promise.all([
  import(pathToFileURL(join(harnessRoot, 'apps/cli/src/profile-boot.ts')).href),
  import(pathToFileURL(join(harnessRoot, 'packages/boot/app-boot/src/index.ts')).href),
  import(pathToFileURL(join(harnessRoot, 'packages/core/session/src/index.ts')).href),
])

let runtime
let handle
try {
  runtime = await runProfile({
    environment: loadLayeredEnv('dsh-anchor-lab-codex-verify', harnessRoot),
    profile: 'web',
    patchFiles: [patchPath],
    args: [],
  })
  const row = (await runtime.ctx.agentPresets.list()).find(candidate => candidate.id === presetId)
  if (!row) fail(`${presetId} is not discoverable`)
  if (row.broken) fail(`${presetId} failed shape validation: ${row.broken}`)
  await runtime.ctx.agentPresets.standingKeyFor(presetId)

  handle = await runtime.ctx.agents.create({
    sessionId: SessionId(`anchor-lab-codex-verify-${randomUUID()}`),
    setup: agentCtx => runtime.ctx.agentPresets.mount(agentCtx, presetId).then(() => undefined),
  })
  const actual = runtime.ctx.tools.schemas(handle.agent).map(schema => schema.name).sort()
  if (JSON.stringify(actual) !== JSON.stringify(EXPECTED_TOOLS)) {
    fail(`tool roster mismatch: ${JSON.stringify(actual)}`)
  }
  if (actual.some(name => !name.startsWith('anchor_lab_codex_') || name.includes('export'))) {
    fail('tool roster contains a foreign or export tool')
  }

  const renderedPreset = await readFile(row.path, 'utf8')
  if (/@@[A-Z0-9_]+@@/u.test(renderedPreset)) fail('rendered preset still contains placeholders')
  if (/MiniMax|volcengine|doubao|visionModel|fallback/iu.test(renderedPreset)) {
    fail('rendered preset contains a fixed provider/model/fallback route')
  }
  process.stdout.write(JSON.stringify({
    status: 'PASS',
    presetId,
    trust: row.trust,
    hostProfile: 'web',
    toolNames: actual,
    domainToolsInvoked: 0,
    capabilityPreflightInvoked: false,
    photoWorkflowInvoked: false,
  }) + '\n')
} finally {
  await handle?.dispose()
  await runtime?.shutdown.shutdown(0)
}
