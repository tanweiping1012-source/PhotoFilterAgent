#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const IMAGE_EXTENSIONS = new Set([
  '.avif', '.bmp', '.cr2', '.cr3', '.dng', '.gif', '.heic', '.heif',
  '.jpeg', '.jpg', '.nef', '.orf', '.png', '.raf', '.rw2', '.tif',
  '.tiff', '.webp', '.arw',
])

function usage() {
  return [
    'Usage: node scripts/validate-acceptance-dataset.mjs',
    '  --source-root <dir> --oracle <dir> --exclude-relative <path> --target <K>',
  ].join(' ')
}

export function parseArgs(argv) {
  const accepted = new Set(['--source-root', '--oracle', '--exclude-relative', '--target'])
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (!accepted.has(flag)) throw new Error(`Unknown argument: ${flag}`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`)
    if (args[flag]) throw new Error(`Duplicate argument: ${flag}`)
    args[flag] = value
    index += 1
  }

  for (const flag of accepted) {
    if (!args[flag]) throw new Error(`${flag} is required`)
  }
  if (isAbsolute(args['--exclude-relative'])) {
    throw new Error('--exclude-relative must be a relative path')
  }
  const target = Number(args['--target'])
  if (!Number.isSafeInteger(target) || target <= 0) {
    throw new Error('--target must be a positive integer')
  }

  return {
    sourceRoot: resolve(args['--source-root']),
    oracle: resolve(args['--oracle']),
    excludeRelative: args['--exclude-relative'],
    target,
  }
}

function isWithin(root, target) {
  const remainder = relative(root, target)
  return remainder === '' || (!remainder.startsWith('..') && !isAbsolute(remainder))
}

function assertSafeRelativePath(path) {
  if (path.includes('\0')) throw new Error('--exclude-relative contains an invalid character')
  const resolved = resolve('/', path)
  if (resolved === '/' || !isWithin('/', resolved)) {
    throw new Error('--exclude-relative must name a child path')
  }
  const normalized = relative('/', resolved)
  if (normalized !== path.replaceAll('\\', '/').replace(/^\.\//u, '')) {
    throw new Error('--exclude-relative must be a normalized child path')
  }
}

async function assertDirectory(path, label) {
  let metadata
  try {
    metadata = await stat(path)
  } catch {
    throw new Error(`${label} directory does not exist`)
  }
  if (!metadata.isDirectory()) throw new Error(`${label} must be a directory`)
}

async function resolveAuthorizedRoots(args) {
  assertSafeRelativePath(args.excludeRelative)
  let sourceRoot
  let oracle
  try {
    sourceRoot = await realpath(args.sourceRoot)
    oracle = await realpath(args.oracle)
  } catch {
    throw new Error('Source root or Oracle directory cannot be resolved')
  }
  await assertDirectory(sourceRoot, 'Source root')
  await assertDirectory(oracle, 'Oracle')

  const declared = resolve(sourceRoot, args.excludeRelative)
  let declaredReal
  try {
    declaredReal = await realpath(declared)
  } catch {
    throw new Error('Declared excluded directory cannot be resolved')
  }
  if (!isWithin(sourceRoot, oracle) || oracle !== declaredReal || oracle === sourceRoot) {
    throw new Error('Oracle is not the declared excluded child directory')
  }
  return { sourceRoot, oracle }
}

async function findImages(root, excludedRoot) {
  const images = []
  const pending = [root]
  while (pending.length > 0) {
    const current = pending.pop()
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      throw new Error('Acceptance dataset cannot be traversed')
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const path = resolve(current, entry.name)
      if (entry.isDirectory()) {
        if (path !== excludedRoot) pending.push(path)
      } else if (entry.isFile() && IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        images.push(path)
      }
      // Symlinks and other special files are deliberately ignored.
    }
  }
  return images.sort()
}

async function sha256File(path) {
  const hash = createHash('sha256')
  try {
    for await (const chunk of createReadStream(path)) hash.update(chunk)
  } catch {
    throw new Error('Acceptance image cannot be read')
  }
  return hash.digest('hex')
}

async function hashCounts(paths) {
  const counts = new Map()
  for (const path of paths) {
    const hash = await sha256File(path)
    counts.set(hash, (counts.get(hash) ?? 0) + 1)
  }
  return counts
}

function countValues(counts) {
  let count = 0
  for (const value of counts.values()) count += value
  return count
}

export function calculateValidity(candidateHashes, oracleHashes, target) {
  const candidateCount = countValues(candidateHashes)
  const oracleCount = countValues(oracleHashes)
  let present = 0
  for (const [hash, count] of oracleHashes) {
    present += Math.min(count, candidateHashes.get(hash) ?? 0)
  }
  const coverage = oracleCount === 0 ? 0 : present / oracleCount
  const exactTargetAlignment = oracleCount === target
  const candidateCapacity = candidateCount >= target
  return {
    candidate_count: candidateCount,
    oracle_count: oracleCount,
    oracle_content_present_count: present,
    target,
    candidate_oracle_coverage: coverage,
    exact_target_alignment: exactTargetAlignment,
    candidate_capacity: candidateCapacity,
    valid: candidateCapacity && exactTargetAlignment && present === oracleCount,
  }
}

export function render(result) {
  return [
    `candidate_count=${result.candidate_count}`,
    `oracle_count=${result.oracle_count}`,
    `oracle_content_present_count=${result.oracle_content_present_count}`,
    `target=${result.target}`,
    `candidate_oracle_coverage=${result.candidate_oracle_coverage.toFixed(6)}`,
    `exact_target_alignment=${result.exact_target_alignment}`,
    `candidate_capacity=${result.candidate_capacity}`,
    `valid=${result.valid}`,
  ].join('\n')
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const { sourceRoot, oracle } = await resolveAuthorizedRoots(args)
  const [candidateFiles, oracleFiles] = await Promise.all([
    findImages(sourceRoot, oracle),
    findImages(oracle),
  ])
  const [candidateHashes, oracleHashes] = await Promise.all([
    hashCounts(candidateFiles),
    hashCounts(oracleFiles),
  ])
  const result = calculateValidity(candidateHashes, oracleHashes, args.target)
  process.stdout.write(`${render(result)}\n`)
  if (!result.valid) process.exitCode = 2
  return result
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n${usage()}\n`)
    process.exitCode = 1
  })
}
