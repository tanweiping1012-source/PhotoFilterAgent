import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
const home = mkdtempSync(join(tmpdir(),'pf-setup-test-'))
try {
  const profile=join(home,'profiles','test');mkdirSync(profile,{recursive:true})
  writeFileSync(join(profile,'package.json'),'{}')
  const patch=join(profile,'cordis.patch.yml')
  writeFileSync(patch,'# preserve this\n- id: unrelated\n  config:\n    cwd: !!js process.cwd()\n- id: photofilter\n  config:\n    python: /custom/python\n')
  const r=spawnSync(process.execPath,['lib/setup.js','--profile','test','--photos','/tmp/photos','--exports','/tmp/out'],{env:{...process.env,DSH_HOME:home},encoding:'utf8'})
  assert.equal(r.status,0,r.stderr)
  const text=readFileSync(patch,'utf8')
  assert.ok(text.includes('!!js process.cwd()'))
  assert.ok(text.includes('# preserve this'))
  assert.ok(text.includes('/custom/python'))
  assert.ok(text.includes('stage2Vlm: false'))
  assert.equal(readdirSync(profile).filter(x=>x.includes('.backup-')).length,1)
  console.log('setup: preserves comments, expressions, unrelated rows and existing config')
} finally {rmSync(home,{recursive:true,force:true})}
