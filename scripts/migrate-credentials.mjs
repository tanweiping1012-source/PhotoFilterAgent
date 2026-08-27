#!/usr/bin/env node

import { randomBytes } from 'node:crypto'
import { chmod, lstat, open, readFile, rename, unlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]*$/u

/**
 * Normalize the retired `{ version, refs }` document without ever logging a
 * credential value. Current Harness rc.8 expects one flat ref -> string map.
 */
export function normalizeCredentialObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('凭据文件必须是键值映射')
  }
  const root = value
  const keys = Object.keys(root)
  const legacy = Object.hasOwn(root, 'version')
    && Object.hasOwn(root, 'refs')
    && keys.every(key => key === 'version' || key === 'refs')
    && typeof root.refs === 'object'
    && root.refs !== null
    && !Array.isArray(root.refs)
  const entries = legacy ? root.refs : root
  for (const [key, secret] of Object.entries(entries)) {
    if (!CREDENTIAL_REF.test(key)) throw new TypeError('凭据引用名不符合 POSIX 标识符规则')
    if (typeof secret !== 'string' || secret.length === 0) {
      throw new TypeError(`凭据 ${key} 必须是非空字符串`)
    }
  }
  return { entries: { ...entries }, migrated: legacy }
}

export function renderFlatCredentials(entries) {
  return Object.keys(entries).sort().map(key => `${key}: ${JSON.stringify(entries[key])}\n`).join('')
}

async function loadYamlParser(harnessRoot) {
  const anchor = join(resolve(harnessRoot), 'packages/credentials/credentials-local/package.json')
  const require = createRequire(anchor)
  return require('yaml').parseDocument
}

async function migrateFile(filename, harnessRoot) {
  const stats = await lstat(filename)
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new TypeError('凭据路径必须是普通文件，不能是符号链接')
  }
  const parseDocument = await loadYamlParser(harnessRoot)
  const text = await readFile(filename, 'utf8')
  const document = parseDocument(text, { prettyErrors: false, uniqueKeys: true })
  if (document.errors.length > 0) throw new TypeError('凭据 YAML 无效')
  const normalized = normalizeCredentialObject(document.toJS() ?? {})
  if (!normalized.migrated) return 'valid-flat'

  const directory = dirname(filename)
  const temporary = join(
    directory,
    `.${basename(filename)}.migrate-${process.pid}-${randomBytes(6).toString('hex')}.tmp`,
  )
  let handle
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(renderFlatCredentials(normalized.entries), 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await chmod(temporary, 0o600)
    await rename(temporary, filename)
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
    throw error
  }
  return 'migrated-legacy'
}

async function main() {
  const [filename, harnessRoot] = process.argv.slice(2)
  if (!filename || !harnessRoot) {
    throw new TypeError('用法：migrate-credentials.mjs <credentials.yaml> <harness-root>')
  }
  process.stdout.write(`${await migrateFile(filename, harnessRoot)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : '凭据迁移失败'}\n`)
    process.exitCode = 1
  })
}
