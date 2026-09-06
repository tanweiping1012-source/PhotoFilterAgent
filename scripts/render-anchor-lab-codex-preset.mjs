#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize } from 'node:path'

const PREFIX = 'PHOTO_ANCHOR_LAB_CODEX_'

function fail(message) {
  throw new TypeError(`render-anchor-lab-codex-preset: ${message}`)
}

function parseArgs(argv) {
  const scalar = new Map()
  const repeated = new Map([
    ['allowed-root', []],
    ['excluded-relative-path', []],
  ])
  for (let index = 0; index < argv.length; index += 2) {
    const token = argv[index]
    const value = argv[index + 1]
    if (!token?.startsWith('--') || value === undefined) fail(`invalid argument near ${token ?? '<end>'}`)
    const key = token.slice(2)
    if (repeated.has(key)) repeated.get(key).push(value)
    else if (scalar.has(key)) fail(`duplicate --${key}`)
    else scalar.set(key, value)
  }
  const required = [
    'template', 'output', 'engine-binary', 'dsh-home', 'artifact-root',
    'anchor-pack-path', 'reference-sheet-path', 'reference-sheet-receipt-path',
    'anchor-overlap-receipt-path',
  ]
  for (const key of required) if (!scalar.get(key)) fail(`missing --${key}`)
  if (repeated.get('allowed-root').length === 0) fail('at least one --allowed-root is required')
  return { scalar, repeated }
}

function absolute(value, label) {
  if (!isAbsolute(value) || value.includes('\0')) fail(`${label} must be an absolute path`)
  return normalize(value)
}

function relativePath(value) {
  if (!value || isAbsolute(value) || value.includes('\0')) fail('excluded path must be relative')
  if (value.split(/[\\/]/u).some(component => component === '..')) {
    fail(`excluded path contains ..: ${value}`)
  }
  const normalized = normalize(value)
  if (normalized === '.' || normalized === '..' || normalized.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    fail(`excluded path escapes the dataset: ${value}`)
  }
  return normalized
}

const { scalar, repeated } = parseArgs(process.argv.slice(2))
const templatePath = absolute(scalar.get('template'), 'template')
const outputPath = absolute(scalar.get('output'), 'output')
const dshHome = absolute(scalar.get('dsh-home'), 'dsh-home')
const values = new Map([
  [`${PREFIX}ENGINE_BINARY`, absolute(scalar.get('engine-binary'), 'engine-binary')],
  [`${PREFIX}WORKDIR`, absolute(join(dshHome, 'runs'), 'workdir')],
  [`${PREFIX}ARTIFACT_ROOT`, absolute(scalar.get('artifact-root'), 'artifact-root')],
  [`${PREFIX}ALLOWED_ROOTS`, repeated.get('allowed-root').map(value => absolute(value, 'allowed-root'))],
  [`${PREFIX}EXCLUDED_RELATIVE_PATHS`, repeated.get('excluded-relative-path').map(relativePath)],
  [`${PREFIX}ANCHOR_PACK_PATH`, absolute(scalar.get('anchor-pack-path'), 'anchor-pack-path')],
  [`${PREFIX}REFERENCE_SHEET_PATH`, absolute(scalar.get('reference-sheet-path'), 'reference-sheet-path')],
  [`${PREFIX}REFERENCE_SHEET_RECEIPT_PATH`, absolute(scalar.get('reference-sheet-receipt-path'), 'reference-sheet-receipt-path')],
  [`${PREFIX}ANCHOR_OVERLAP_RECEIPT_PATH`, absolute(scalar.get('anchor-overlap-receipt-path'), 'anchor-overlap-receipt-path')],
  [`${PREFIX}PRESET_SOURCE_PATH`, outputPath],
])

let output = await readFile(templatePath, 'utf8')
const placeholders = [...output.matchAll(/@@([A-Z0-9_]+)@@/gu)].map(match => match[1])
if (placeholders.length === 0) fail('template contains no placeholders')
for (const placeholder of new Set(placeholders)) {
  if (!placeholder.startsWith(PREFIX)) fail(`foreign placeholder @@${placeholder}@@`)
  if (!values.has(placeholder)) fail(`unknown placeholder @@${placeholder}@@`)
  output = output.replaceAll(`@@${placeholder}@@`, JSON.stringify(values.get(placeholder)))
}
const missing = [...values.keys()].filter(key => !placeholders.includes(key))
if (missing.length > 0) fail(`template is missing placeholders: ${missing.join(', ')}`)
if (/@@[A-Z0-9_]+@@/u.test(output)) fail('render left an unresolved placeholder')

await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 })
const temporary = `${outputPath}.tmp-${process.pid}-${randomUUID()}`
await writeFile(temporary, output, { flag: 'wx', mode: 0o600 })
await rename(temporary, outputPath)
process.stdout.write(`${outputPath}\n`)
