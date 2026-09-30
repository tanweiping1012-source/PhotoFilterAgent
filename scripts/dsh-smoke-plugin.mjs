import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
export const inject = ['agentPresets', 'tools', 'agents', 'webRuntime', 'connection', 'llm']
export function apply(ctx) {
  // Fail before dispatch if a future regression tries to use a model in this local-only test.
  let modelCalls = 0
  ctx.llm.prepareCall = async () => { modelCalls++; throw new Error('Model dispatch forbidden in release smoke') }
  const timer = setTimeout(async () => {
    try {
      const preset = (await ctx.agentPresets.list()).find(x => x.id === 'photo-filter-v4')
      assert.ok(preset, 'preset registered')
      assert.equal(preset.broken, undefined, JSON.stringify(preset))
      const photos = process.env.PHOTOFILTER_SMOKE_PHOTOS
      const output = process.env.PHOTOFILTER_SMOKE_EXPORTS
      mkdirSync(photos, { recursive: true }); mkdirSync(output, { recursive: true })
      for (let i=1;i<=12;i++) writeFileSync(join(photos, `P${String(i).padStart(2,'0')}.JPG`), `fixture-${i}`)
      const restarting = existsSync(join(process.env.DSH_HOME, 'pending-export.json'))
      const agent = async id => {
        const setup = async child => { await ctx.agentPresets.mount(child, 'photo-filter-v4') }
        return (await (restarting ? ctx.agents.resume({resumeSessionId:id,setup}) : ctx.agents.create({sessionId:id,setup}))).agent
      }
      const a = await agent('photofilter-smoke-a'), b = await agent('photofilter-smoke-b')
      const tools = ctx.tools.schemas(a).map(x => x.name)
      for (const n of ['scan_folder','rank_photos','export_selection']) assert.ok(tools.includes(n), n)
      assert.ok(!tools.includes('bash'), 'no shell in photo preset')
      const call = (owner, name, args, signal = new AbortController().signal) => ctx.tools.get(name, owner).execute(args, { agent: owner, signal })
      const receiptPath = join(process.env.DSH_HOME, 'pending-export.json')
      if (existsSync(receiptPath)) {
        const previous = JSON.parse(readFileSync(receiptPath, 'utf8'))
        await assert.rejects(call(a, 'export_selection', previous), /rank_photos/)
      }
      const scan = await call(a,'scan_folder',{folder:photos})
      assert.equal(scan.n_photos, 12)
      await assert.rejects(call(b,'rank_photos',{target:4}), /scan_folder/)
      await call(a,'rank_photos',{target:4})
      const dest = join(output, `selection-${Date.now()}`)
      const ticket = await call(a,'export_selection',{dest})
      const code = ticket.summary.match(/确认码 \*\*([A-F0-9]{6})\*\*/)?.[1]
      assert.ok(code, 'real export ticket')
      await assert.rejects(call(b,'export_selection',{dest,confirmation_code:code}), /rank_photos/)
      const exported = await call(a,'export_selection',{dest,confirmation_code:code})
      assert.ok(exported.copied >= 4)
      assert.equal(readFileSync(join(dest,'P01.JPG'),'utf8'), 'fixture-1')
      await assert.rejects(call(a,'export_selection',{dest,confirmation_code:code}), /没有待确认/)
      const pending = await call(a,'export_selection',{dest: join(output,'pending')})
      writeFileSync(receiptPath, JSON.stringify({dest:join(output,'pending'),confirmation_code:pending.summary.match(/确认码 \*\*([A-F0-9]{6})\*\*/)[1]}))
      const stopped = new AbortController(); stopped.abort()
      await assert.rejects(call(a,'scan_folder',{folder:photos},stopped.signal))
      assert.equal(modelCalls, 0, 'no attempted model dispatch')
      console.log('PHOTOFILTER_SMOKE_PASS ' + JSON.stringify({preset:preset.id, tools, scan:scan.n_photos, copied:exported.copied, sessionIsolation:true, cancel:true, modelCalls}))
      process.exit(0)
    } catch (error) { console.error('PHOTOFILTER_SMOKE_FAIL',error); process.exit(1) }
  },1500)
  ctx.on('dispose', () => clearTimeout(timer))
  setTimeout(() => { console.error('PHOTOFILTER_SMOKE_TIMEOUT'); process.exit(2) },45000).unref()
}
