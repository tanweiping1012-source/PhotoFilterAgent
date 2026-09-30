#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { parseDocument, isSeq, isMap } from 'yaml'

const { values } = parseArgs({ options: {
  help: { type: 'boolean' }, profile: { type: 'string' }, photos: { type: 'string', multiple: true },
  exports: { type: 'string', multiple: true }, 'install-deps': { type: 'boolean' },
  'download-models': { type: 'boolean' }, python: { type: 'string' },
} })
if (values.help || !Object.keys(values).length) {
  console.log(`PhotoFilter setup (macOS 14+, Node 24+, Python 3.10+, Swift 6)
  photofilter-setup --install-deps [--python python3]
  photofilter-setup --download-models
  photofilter-setup --profile desktop --photos /absolute/photos --exports /absolute/export
Install the bundle with DSH first. Dependency/model downloads are explicit and can be large.
Configuration preserves other plugin rows and saves a backup. No API keys are read or requested.`)
  process.exit(0)
}
if (process.platform !== 'darwin') throw new Error('PhotoFilter requires macOS 14+ (Apple Vision).')
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const data = join(home, 'photofilter')
const python = join(data, 'venv', 'bin', 'python')
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`)
}
if (values['install-deps']) {
  mkdirSync(data, { recursive: true })
  run(values.python || 'python3', ['-c', 'import sys; assert sys.version_info >= (3,10), "Python >=3.10 required"'])
  if (!existsSync(python)) run(values.python || 'python3', ['-m', 'venv', join(data, 'venv')])
  run(python, ['-m', 'pip', 'install', '-r', join(root, 'ranker', 'requirements.txt')])
  run('swift', ['build', '--package-path', join(root, 'engine'), '--scratch-path', join(data, 'engine'), '-c', 'release'])
}
if (values['download-models']) {
  run(python, ['-c', "import clip, pyiqa; clip.load('ViT-L/14', device='cpu'); pyiqa.create_metric('laion_aes', device='cpu'); pyiqa.create_metric('topiq_nr-face', device='cpu')"])
}
if (values.profile) {
  if (!/^[a-zA-Z0-9_-]+$/.test(values.profile)) throw new Error('Invalid profile name')
  if (!values.photos?.length) throw new Error('--photos is required to configure a profile')
  const directory = join(home, 'profiles', values.profile)
  if (!existsSync(join(directory, 'package.json'))) throw new Error('Install the plugin in this profile using dsh plugin first')
  const path = join(directory, 'cordis.patch.yml')
  const document = parseDocument(existsSync(path) ? readFileSync(path, 'utf8') : '[]', {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }],
  })
  if (document.errors.length) throw new Error('Profile YAML is invalid; no changes made')
  if (!document.contents) document.contents = document.createNode([])
  if (!isSeq(document.contents)) throw new Error('Profile patch is not a list; no changes made')
  const matches = document.contents.items.filter(row => isMap(row) && row.get('id') === 'photofilter')
  if (matches.length > 1) throw new Error('Duplicate photofilter rows; no changes made')
  let row = matches[0]
  if (!row) { row = document.createNode({ id: 'photofilter', config: {} }); document.contents.add(row) }
  if (!row.has('config')) row.set('config', document.createNode({}))
  const config = row.get('config', true)
  if (!isMap(config)) throw new Error('Plugin config must be a mapping; no changes made')
  config.set('allowedRoots', document.createNode(values.photos.map(p => resolve(p))))
  config.set('allowedExportRoots', document.createNode((values.exports || []).map(p => resolve(p))))
  config.set('stage2Vlm', false)
  config.set('stage3Vlm', false)
  if (existsSync(path)) copyFileSync(path, `${path}.backup-${Date.now()}`)
  const temp = `${path}.tmp-${process.pid}`
  writeFileSync(temp, document.toString(), { mode: 0o600 })
  renameSync(temp, path)
  console.log(`Configured ${path}. Select PhotoFilter in a new DSH chat. Visual review is OFF.`)
}
