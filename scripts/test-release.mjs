import { spawnSync } from 'node:child_process'
for (const file of ['codes', 'anchors', 'ranker', 'pairEval', 'stage3', 'rankPhotos.wiring']) {
  const r = spawnSync(process.execPath, ['--experimental-transform-types', `agent-v4/src/${file}.test.ts`], { stdio: 'inherit' })
  if (r.status !== 0) process.exit(r.status ?? 1)
}
