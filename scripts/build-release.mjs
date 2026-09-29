import { build } from 'esbuild'
await build({
  entryPoints: { index: 'release/index.ts', tools: 'agent-v4/src/index.ts', setup: 'release/setup.mjs' },
  outdir: 'lib', bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node24',
})
