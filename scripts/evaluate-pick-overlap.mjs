#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { parseFrozenSelectionReceiptJson } from './selection-receipt.mjs'

const IMAGE_EXTENSIONS = new Set([
  '.avif', '.bmp', '.cr2', '.cr3', '.dng', '.gif', '.heic', '.heif',
  '.jpeg', '.jpg', '.nef', '.orf', '.png', '.raf', '.rw2', '.tif',
  '.tiff', '.webp', '.arw',
])

function usage() {
  return 'Usage: node scripts/evaluate-pick-overlap.mjs --receipt <json> --oracle <dir> [--json <path>]'
}

export function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (!['--receipt', '--oracle', '--json'].includes(flag)) {
      throw new Error(`Unknown argument: ${flag}`)
    }
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`)
    if (args[flag]) throw new Error(`Duplicate argument: ${flag}`)
    args[flag] = value
    index += 1
  }
  if (!args['--receipt'] || !args['--oracle']) {
    throw new Error('Both --receipt and --oracle are required')
  }
  return {
    receipt: resolve(args['--receipt']),
    oracle: resolve(args['--oracle']),
    json: args['--json'] ? resolve(args['--json']) : undefined,
  }
}

async function readValidatedReceipt(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch {
    throw new Error('Receipt file cannot be read')
  }
  return parseFrozenSelectionReceiptJson(text)
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

function isWithin(root, target) {
  const remainder = relative(root, target)
  return remainder === '' || (!remainder.startsWith('..') && !isAbsolute(remainder))
}

async function resolveAuthorizedOracle(receipt, requestedOracle) {
  let sourceRoot
  let oracle
  try {
    sourceRoot = await realpath(receipt.sourceRoot)
    oracle = await realpath(requestedOracle)
  } catch {
    throw new Error('Receipt source root or Oracle directory cannot be resolved')
  }
  if (sourceRoot !== receipt.sourceRoot || !isWithin(sourceRoot, oracle)) {
    throw new Error('Oracle directory is not an authorized excluded directory')
  }

  for (const excluded of receipt.excludedRelativePaths) {
    const declared = resolve(sourceRoot, excluded)
    if (!isWithin(sourceRoot, declared)) continue
    let declaredReal
    try {
      declaredReal = await realpath(declared)
    } catch {
      continue
    }
    if (declaredReal === oracle && isWithin(sourceRoot, declaredReal)) return oracle
  }
  throw new Error('Oracle directory is not an authorized excluded directory')
}

async function findOracleImages(root) {
  const images = []
  const pending = [root]
  try {
    while (pending.length > 0) {
      const current = pending.pop()
      const entries = await readdir(current, { withFileTypes: true })
      entries.sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of entries) {
        const path = resolve(current, entry.name)
        if (entry.isDirectory()) {
          pending.push(path)
        } else if (entry.isFile() && IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
          images.push(path)
        }
        // Symlinks and other special files are deliberately ignored.
      }
    }
  } catch {
    throw new Error('Oracle directory cannot be traversed')
  }
  return images.sort()
}

async function sha256File(path) {
  const hash = createHash('sha256')
  try {
    for await (const chunk of createReadStream(path)) hash.update(chunk)
  } catch {
    throw new Error('Oracle image cannot be read')
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

function ratio(numerator, denominator, otherCount) {
  if (denominator > 0) return numerator / denominator
  return otherCount === 0 ? 1 : 0
}

export function calculateOverlap(selectedContentHashes, oracleHashes) {
  const selectedHashes = new Map()
  for (const hash of selectedContentHashes) {
    selectedHashes.set(hash, (selectedHashes.get(hash) ?? 0) + 1)
  }
  const selectedCount = selectedContentHashes.length
  let oracleCount = 0
  let intersection = 0
  for (const count of oracleHashes.values()) oracleCount += count
  for (const [hash, count] of selectedHashes) {
    intersection += Math.min(count, oracleHashes.get(hash) ?? 0)
  }

  const precision = ratio(intersection, selectedCount, oracleCount)
  const recall = ratio(intersection, oracleCount, selectedCount)
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
  const unionCount = selectedCount + oracleCount - intersection
  const jaccard = unionCount === 0 ? 1 : intersection / unionCount
  return {
    selected_count: selectedCount,
    oracle_count: oracleCount,
    intersection_count: intersection,
    precision,
    recall,
    f1,
    jaccard,
    pass_90: precision >= 0.9 && recall >= 0.9,
  }
}

export function render(result) {
  return [
    `selected_count=${result.selected_count}`,
    `oracle_count=${result.oracle_count}`,
    `intersection_count=${result.intersection_count}`,
    `precision=${result.precision.toFixed(6)}`,
    `recall=${result.recall.toFixed(6)}`,
    `f1=${result.f1.toFixed(6)}`,
    `jaccard=${result.jaccard.toFixed(6)}`,
    `pass_90=${result.pass_90}`,
  ].join('\n')
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)

  // Oracle metadata and contents are deliberately untouched until the complete
  // plugin receipt, including its integrity hash, has passed validation.
  const receipt = await readValidatedReceipt(args.receipt)

  const oracle = await resolveAuthorizedOracle(receipt, args.oracle)
  await assertDirectory(oracle, 'Oracle')
  if (args.json) {
    let metadata
    try {
      metadata = await lstat(dirname(args.json))
    } catch {
      metadata = undefined
    }
    if (!metadata?.isDirectory()) throw new Error('JSON output parent directory must already exist')
  }

  const oracleFiles = await findOracleImages(oracle)
  const oracleHashes = await hashCounts(oracleFiles)
  const result = calculateOverlap(receipt.selectedItems.map(item => item.sha256), oracleHashes)

  process.stdout.write(`${render(result)}\n`)
  if (args.json) {
    try {
      await writeFile(args.json, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8' })
    } catch {
      throw new Error('JSON output cannot be written')
    }
  }
  return result
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n${usage()}\n`)
    process.exitCode = 1
  })
}
