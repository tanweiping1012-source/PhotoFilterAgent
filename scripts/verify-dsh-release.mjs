// Usage: node scripts/verify-dsh-release.mjs /absolute/path/to/dsh/lib/bin.js /absolute/package.tgz
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
const [runtime, tarball] = process.argv.slice(2)
if (!runtime || !tarball) throw new Error('Pass the DSH bin.js and packed .tgz paths')
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const home=mkdtempSync(join(tmpdir(),'photofilter-release-'))
const photos=join(home,'photos'), exports=join(home,'exports')
const env={...process.env,PATH:join(root,'node_modules','.bin')+delimiter+(process.env.PATH||''),DSH_HOME:home,PHOTOFILTER_SMOKE_PHOTOS:photos,PHOTOFILTER_SMOKE_EXPORTS:exports}
function run(args, label) {
  const r=spawnSync(process.execPath,[resolve(runtime),...args],{env,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024})
  writeFileSync(join(home,label+'.log'),((r.stdout||'')+(r.stderr||'')).replace(/token=[A-Za-z0-9_-]+/g,'token=[redacted]'))
  if(r.status!==0) throw new Error(`${label} failed: ${r.error||r.stderr}; evidence ${home}`)
  return r.stdout
}
run(['--profile','acceptance','--from-default-profile','web','--dump-config'],'baseline')
run(['plugin','--profile','acceptance','add',resolve(tarball)],'install')
const config={allowedRoots:[photos],allowedExportRoots:[exports],rankerDir:join(root,'agent-v4/test-fixtures/fake-ranker'),python:process.env.PHOTOFILTER_TEST_PYTHON||'python3',engineBinary:'',workdir:join(home,'state'),cacheDir:join(home,'cache'),stage2Vlm:false,stage3Vlm:false}
const patch=join(home,'acceptance.patch.yml')
writeFileSync(patch,JSON.stringify([{id:'photofilter',config},{insert:[{id:'photofilter-smoke',name:join(root,'scripts/dsh-smoke-plugin.mjs')}]}]))
for(const label of ['first-start','restart']) {
  const output=run(['--profile','acceptance','--patch',patch,'--host','127.0.0.1','--port','0','--no-open'],label)
  if(!output.includes('PHOTOFILTER_SMOKE_PASS')) throw new Error(`No successful runtime receipt: ${home}`)
  console.log(output.split('\n').filter(line=>line.startsWith('PHOTOFILTER_SMOKE_PASS')).join('\n'))
}
console.log(`Evidence: ${home}`)
