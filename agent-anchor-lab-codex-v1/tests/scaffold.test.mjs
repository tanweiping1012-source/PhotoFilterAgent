import assert from 'node:assert/strict'
import { access, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const PACKAGE_NAME = '@photo-filter-agent/dsh-photo-anchor-lab-codex-v1'
const TECHNICAL_ID = 'photo-anchor-lab-codex-v1'
const TOOL_PREFIX = 'anchor_lab_codex_'
const urls = {
  package: new URL('../package.json', import.meta.url),
  entry: new URL('../src/index.ts', import.meta.url),
  plugin: new URL('../../agent/src/anchor-lab-codex-plugin.ts', import.meta.url),
  presetMetadata: new URL('../../presets/photo-anchor-lab-codex-v1/preset.yml', import.meta.url),
  presetComposition: new URL('../../presets/photo-anchor-lab-codex-v1/agent.cordis.yml', import.meta.url),
  renderer: new URL('../../scripts/render-anchor-lab-codex-preset.mjs', import.meta.url),
  snapshotter: new URL('../../scripts/snapshot-anchor-lab-codex-runtime.mjs', import.meta.url),
}

test('package and user preset use the isolated Codex identity', async () => {
  const [packageSource, entry, presetMetadata, presetComposition] = await Promise.all([
    urls.package, urls.entry, urls.presetMetadata, urls.presetComposition,
  ].map(url => readFile(url, 'utf8')))
  const packageJson = JSON.parse(packageSource)
  assert.equal(packageJson.name, PACKAGE_NAME)
  assert.equal(packageJson.main, 'src/index.ts')
  assert.equal(packageJson.dependencies['@deepseek-ai/schemastery'], '*')
  assert.match(entry, /anchor-lab-codex-plugin\.ts/u)
  assert.match(presetMetadata, /^name: Photo Curator Anchor Lab \(Codex\)$/mu)
  assert.match(presetComposition, new RegExp(`id: ${TECHNICAL_ID}`, 'u'))
  assert.match(presetComposition, new RegExp(`name: '${PACKAGE_NAME.replaceAll('/', '\\/')}'`, 'u'))
  assert.doesNotMatch(presetComposition, /@photo-filter-agent\/dsh-photo-filter-agent|photo-filter-v4/u)
})

test('there is no direct profile that could leak the plugin into other sessions', async () => {
  for (const path of [
    new URL('../../profiles/photo-anchor-lab-codex-v1-web/cordis.patch.yml', import.meta.url),
    new URL('../../profiles/photo-anchor-lab-codex-v1-headless/cordis.patch.yml', import.meta.url),
  ]) await assert.rejects(access(path), error => error?.code === 'ENOENT')
})

test('renderer emits a complete path-safe composition without a fixed model route', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anchor-lab-render-'))
  const output = join(root, 'preset with spaces', 'agent.cordis.yml')
  const args = [
    fileURLToPath(urls.renderer),
    '--template', fileURLToPath(urls.presetComposition),
    '--output', output,
    '--engine-binary', '/tmp/build #1/release/photofilter',
    '--dsh-home', '/tmp/dsh home',
    '--artifact-root', '/tmp/artifacts:codex',
    '--allowed-root', '/tmp/photos one',
    '--allowed-root', '/tmp/photos #two',
    '--excluded-relative-path', 'me-pick',
    '--anchor-pack-path', '/tmp/anchor pack.json',
    '--reference-sheet-path', '/tmp/reference #sheet.jpg',
    '--reference-sheet-receipt-path', '/tmp/reference receipt.json',
    '--anchor-overlap-receipt-path', '/tmp/overlap receipt.json',
  ]
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const rendered = await readFile(output, 'utf8')
  assert.doesNotMatch(rendered, /@@[A-Z0-9_]+@@/u)
  assert.match(rendered, /engineBinary: "\/tmp\/build #1\/release\/photofilter"/u)
  assert.match(rendered, /allowedRoots: \["\/tmp\/photos one","\/tmp\/photos #two"\]/u)
  assert.match(rendered, /excludedRelativePaths: \["me-pick"\]/u)
  assert.match(rendered, new RegExp(`id: ${TECHNICAL_ID}`, 'u'))
  assert.doesNotMatch(rendered, /MiniMax|volcengine|doubao|visionModel|api\.[a-z0-9.-]+/iu)
  assert.doesNotMatch(rendered, /allowedExportRoots|export_selection|anchor_lab_codex_export/iu)
})

test('runtime snapshot is content-addressed and does not point at the live worktree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anchor-lab-snapshot-'))
  const script = fileURLToPath(urls.snapshotter)
  const repo = fileURLToPath(new URL('../../', import.meta.url))
  const first = spawnSync(process.execPath, [
    script, '--repo-root', repo, '--snapshot-root', root,
  ], { encoding: 'utf8' })
  assert.equal(first.status, 0, first.stderr)
  const packageRoot = first.stdout.trim()
  assert.match(packageRoot, new RegExp(`^${root.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\/`))
  assert.notEqual(packageRoot, fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/u, ''))
  const manifest = JSON.parse(await readFile(join(packageRoot, '..', 'SNAPSHOT.json'), 'utf8'))
  assert.equal(manifest.schema, 'photo-anchor-lab-codex-runtime-snapshot/v1')
  assert.match(manifest.snapshotHash, /^[a-f0-9]{64}$/u)
  assert.ok(manifest.files.some(row => row.source === 'agent/src/anchor-lab-codex-plugin.ts'
    && row.destination === 'agent-anchor-lab-codex-v1/runtime/anchor-lab-codex-plugin.ts'))
  const frozenEntry = await readFile(join(packageRoot, 'src/index.ts'), 'utf8')
  assert.match(frozenEntry, /\.\.\/runtime\/anchor-lab-codex-plugin\.ts/u)
  assert.doesNotMatch(frozenEntry, /\.\.\/\.\.\/agent\/src/u)
  const second = spawnSync(process.execPath, [
    script, '--repo-root', repo, '--snapshot-root', root,
  ], { encoding: 'utf8' })
  assert.equal(second.status, 0, second.stderr)
  assert.equal(second.stdout, first.stdout)
})

test('model-visible tool roster is defined only by the dedicated plugin namespace', async () => {
  const source = await readFile(urls.plugin, 'utf8')
  const suffixes = [...source.matchAll(/^\s+(?:activate|analyze|evaluate|build|independent|audit|propose): `\$\{PHOTO_ANCHOR_LAB_CODEX_TOOL_PREFIX\}([a-z_]+)`,$/gmu)]
    .map(match => match[1])
  assert.deepEqual(suffixes.sort(), [
    'activate', 'analyze_folder', 'audit_selection', 'build_selection',
    'evaluate_pool', 'independent_evaluator', 'propose_selection',
  ].sort())
  assert.ok(suffixes.every(suffix => `${TOOL_PREFIX}${suffix}`.startsWith(TOOL_PREFIX)))
  assert.doesNotMatch(source, /anchor_lab_codex_export|export_selection|allowedExportRoots/u)
})

test('package entry really imports against DSH rc.8 when a harness root is supplied', {
  skip: !process.env.PHOTO_ANCHOR_LAB_CODEX_HARNESS_ROOT,
}, () => {
  const harness = process.env.PHOTO_ANCHOR_LAB_CODEX_HARNESS_ROOT
  const loader = join(harness, 'node_modules/tsx/dist/esm/index.mjs')
  const entry = fileURLToPath(urls.entry)
  const script = `const p=await import(${JSON.stringify(entry)});` +
    `if(p.name!==${JSON.stringify(TECHNICAL_ID)}||typeof p.apply!=='function'||!p.Config)` +
    `throw new Error('invalid exports')`
  const result = spawnSync(process.execPath, ['--import', loader, '--input-type=module', '-e', script], {
    cwd: harness,
    env: { ...process.env, TSX_TSCONFIG_PATH: join(harness, 'tsconfig.json') },
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
})
