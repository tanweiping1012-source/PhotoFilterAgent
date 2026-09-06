#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

function fail(message) {
  throw new TypeError(`snapshot-anchor-lab-codex-runtime: ${message}`)
}

function parseArgs(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const token = argv[index]
    const value = argv[index + 1]
    if (!token?.startsWith('--') || value === undefined) fail(`invalid argument near ${token ?? '<end>'}`)
    const key = token.slice(2)
    if (values.has(key)) fail(`duplicate --${key}`)
    values.set(key, value)
  }
  for (const key of ['repo-root', 'snapshot-root']) {
    if (!values.get(key)) fail(`missing --${key}`)
  }
  return values
}

function absolute(value, label) {
  if (!isAbsolute(value) || value.includes('\0')) fail(`${label} must be an absolute path`)
  return resolve(value)
}

async function collectFiles(root, relativeDirectory) {
  const directory = join(root, relativeDirectory)
  const rows = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = join(relativeDirectory, entry.name)
    if (entry.isDirectory()) rows.push(...await collectFiles(root, child))
    else if (entry.isFile() && entry.name.endsWith('.ts')) rows.push(child)
    else if (entry.isSymbolicLink()) fail(`runtime source cannot contain symlink: ${child}`)
  }
  return rows
}

const values = parseArgs(process.argv.slice(2))
const repoRoot = absolute(values.get('repo-root'), 'repo-root')
const snapshotRoot = absolute(values.get('snapshot-root'), 'snapshot-root')
const fixedFiles = ['agent-anchor-lab-codex-v1/package.json']
const sourceFiles = await collectFiles(repoRoot, 'agent/src')
const entrySourcePath = 'agent-anchor-lab-codex-v1/src/index.ts'
const relativeFiles = [...fixedFiles, entrySourcePath, ...sourceFiles].sort()
const rows = []
const hash = createHash('sha256')
for (const relativePath of relativeFiles) {
  const source = join(repoRoot, relativePath)
  const sourceStat = await stat(source)
  if (!sourceStat.isFile()) fail(`runtime source is not a regular file: ${relativePath}`)
  const sourceBytes = await readFile(source)
  let destinationPath = relativePath
  let bytes = sourceBytes
  if (relativePath === entrySourcePath) {
    const text = sourceBytes.toString('utf8')
    const rewritten = text.replace(
      '../../agent/src/anchor-lab-codex-plugin.ts',
      '../runtime/anchor-lab-codex-plugin.ts',
    )
    if (rewritten === text) fail('package entry does not contain the expected development import')
    bytes = Buffer.from(rewritten)
  } else if (relativePath.startsWith('agent/src/')) {
    destinationPath = join(
      'agent-anchor-lab-codex-v1/runtime',
      relativePath.slice('agent/src/'.length),
    )
  }
  rows.push({ sourcePath: relativePath, destinationPath, bytes })
  hash.update(relativePath).update('\0').update(bytes).update('\0')
}
const snapshotHash = hash.digest('hex')
const destination = join(snapshotRoot, snapshotHash)
const manifest = JSON.stringify({
  schema: 'photo-anchor-lab-codex-runtime-snapshot/v1',
  snapshotHash,
  files: rows.map(row => ({ source: row.sourcePath, destination: row.destinationPath })),
})

try {
  await access(destination)
  const existing = await readFile(join(destination, 'SNAPSHOT.json'), 'utf8')
  if (existing !== manifest) fail(`existing snapshot manifest mismatch: ${snapshotHash}`)
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
  await mkdir(snapshotRoot, { recursive: true, mode: 0o700 })
  const temporary = join(snapshotRoot, `.tmp-${process.pid}-${randomUUID()}`)
  try {
    for (const row of rows) {
      const target = join(temporary, row.destinationPath)
      if (relative(temporary, target).startsWith('..')) fail(`snapshot path escaped: ${row.destinationPath}`)
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      await writeFile(target, row.bytes, { flag: 'wx', mode: 0o600 })
    }
    await writeFile(join(temporary, 'SNAPSHOT.json'), manifest, { flag: 'wx', mode: 0o600 })
    await rename(temporary, destination)
  } catch (error) {
    await rm(temporary, { recursive: true, force: true })
    if (error?.code === 'EEXIST') {
      const existing = await readFile(join(destination, 'SNAPSHOT.json'), 'utf8')
      if (existing !== manifest) throw error
    } else {
      throw error
    }
  }
}

const packageRoot = join(destination, 'agent-anchor-lab-codex-v1')
if (basename(packageRoot) !== 'agent-anchor-lab-codex-v1') fail('invalid package root')
process.stdout.write(`${packageRoot}\n`)
