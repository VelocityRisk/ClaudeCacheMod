// Offline logic check against a fake mods API. Proves our logic only, not real Claude Code behavior.
// node tests/mock-harness.mjs
import assert from 'node:assert/strict'

let seq = 0
const modUrl = new URL('../plugin/hooks/register.mjs', import.meta.url).href

async function boot(options = {}, usage = {}) {
  const { register } = await import(modUrl + '?run=' + ++seq)
  const env = { T: 1_000_000, cost: 1.0, pingCost: 0.02, forks: 0, plan: 10, costIsNumber: true, logs: [], timers: [], handlers: [] }
  const on = (ev, a, b) => env.handlers.push({ ev, m: b ? a : null, fn: b || a })
  const $ = {
    clock: { now: async () => env.T, every: (ms, fn) => { env.timers.push({ ms, fn }); return { cancel() {} } } },
    ui: {
      invalidate() {},
      log: (t, o) => env.logs.push((o && o.to === 'debug' ? '[debug] ' : '') + t),
      resolve: () => ({ Box: (pr) => ({ ...pr }), Text: (pr) => ({ ...pr }) }),
    },
    command: { register: async (o) => env.logs.push('cmd:' + o.name) },
    session: { usage: async () => ({ cost: env.costIsNumber ? { usd: env.cost } : undefined, rateLimits: [{ kind: 'x', percentUsed: env.plan }] }) },
    model: { fork: async () => { env.forks++; env.cost += env.pingCost; return { isAnswered: true } } },
  }
  Object.assign(env, usage)
  const find = (ev, key) => env.handlers.find((h) => h.ev === ev && (!key || (h.m && (h.m.component === key || h.m.command === key))))
  env.run = (ev, e = {}, key) => find(ev, key).fn($, e, async () => undefined)
  env.has = (ev, key) => Boolean(find(ev, key))
  env.text = (n) => (n ? n.children.map((r) => r.children.map((c) => c.children).join('')).join('\n') : '(nothing drawn)')
  env.draw = async (cols = 80, maxRows = 3) => env.text(await env.run('ui.render', { props: { bodyColumns: cols, maxRows } }, 'AbovePrompt'))
  env.step = async (usage, agentId) => {
    const it = find('turn.step').fn($, agentId ? { agentId } : {}, async function* () { return usage ? { usage } : undefined })
    let r
    do { r = await it.next() } while (!r.done)
  }
  env.advance = async (sec) => {
    for (let i = 0; i < sec; i++) {
      env.T += 1000
      for (const t of env.timers.filter((x) => x.ms === 1000)) await t.fn()
      if (i % 5 === 4) for (const t of env.timers.filter((x) => x.ms === 5000)) await t.fn()
    }
  }
  env.cmd = async (args) => (await env.run('command.run', { args }, 'keepwarm')).text
  register(on, options)
  await env.run('session.start')
  await env.step()
  return env
}

const MIN = 60
const KW = { keepwarmEnabled: true }
let n = 0
const ok = (name) => console.log('[ok] ' + name + ' (' + ++n + ')')

// 1. countdown and expiry
{
  const e = await boot()
  await e.advance(100)
  assert.match(await e.draw(), /expires in 3:20/)
  await e.advance(210)
  const gone = await e.draw()
  assert.match(gone, /5m passed \u00B7 may still be warm/)
  assert.doesNotMatch(gone, /expired/)
  const pinned = await boot({ cacheTtl: '5m' })
  await pinned.advance(310)
  assert.match(await pinned.draw(), /expired/)
  ok('countdown; unknown lifetime says "may still be warm", pinned 5m says expired')
}

// 2. keepwarm is OFF by default: no command, no pings, no mention
{
  const e = await boot()
  assert.ok(!e.logs.includes('cmd:keepwarm'))
  await e.advance(280)
  assert.ok(!(await e.draw()).includes('keepwarm'))
  assert.equal(e.forks, 0)
  assert.match(await e.cmd(''), /turned off/)
  ok('keepwarm off by default')
}

// 3. default 30 min: stops by time, about 6 pings at 4:30
{
  const e = await boot(KW)
  assert.match(await e.cmd(''), /armed for 30 min/)
  await e.advance(31 * MIN)
  assert.match(await e.draw(), /time limit reached/)
  assert.ok(e.forks >= 5 && e.forks <= 7, 'pings ' + e.forks)
  ok('default 30 min, pings=' + e.forks)
}

// 4. asking for more than the max is clamped (60), and absurd config is clamped (90)
{
  const e = await boot(KW)
  assert.match(await e.cmd('500'), /armed for 60 min \(limit applied\)/)
  const f = await boot({ ...KW, keepwarmMaxMinutes: 500, keepwarmDefaultMinutes: 500 })
  assert.match(await f.cmd('1000'), /armed for 90 min \(limit applied\)/)
  ok('time limits clamp at 60 and at the 90 ceiling')
}

// 5. ping cap
{
  const e = await boot({ ...KW, keepwarmMaxMinutes: 90, keepwarmMaxPings: 3 })
  await e.cmd('90')
  await e.advance(30 * MIN)
  assert.equal(e.forks, 3)
  assert.match(await e.draw(), /ping limit reached/)
  ok('ping cap')
}

// 6. spend cap
{
  const e = await boot(KW, { pingCost: 0.6 })
  await e.cmd('60')
  await e.advance(30 * MIN)
  assert.equal(e.forks, 2)
  assert.match(await e.draw(), /spend limit reached/)
  ok('spend cap stops after 2 pings at $0.60 each')
}

// 7. cost cannot be measured: fails closed after the first ping
{
  const e = await boot(KW, { costIsNumber: false })
  await e.cmd('60')
  await e.advance(10 * MIN)
  assert.equal(e.forks, 1)
  assert.match(await e.draw(), /cannot be measured/)
  ok('unmeasurable cost stops keepwarm')
}

// 8. plan limit
{
  const e = await boot(KW, { plan: 85 })
  await e.cmd('60')
  await e.advance(10 * MIN)
  assert.equal(e.forks, 0)
  assert.match(await e.draw(), /plan limit above 80%/)
  ok('plan limit stops before pinging')
}

// 9. session allowance (2x the max) blocks chained re-arming
{
  const e = await boot({ ...KW, keepwarmMaxMinutes: 10 })
  await e.cmd('10'); await e.advance(11 * MIN)
  await e.step(); await e.cmd('10'); await e.advance(11 * MIN)
  await e.step()
  assert.match(await e.cmd('10'), /used its keepwarm allowance/)
  ok('session allowance blocks a third run')
}

// 10. typing disarms; off disarms; nothing to keep warm before a prompt
{
  const e = await boot(KW)
  await e.cmd('30')
  await e.run('prompt.submit', { text: 'hello' })
  assert.equal(await e.cmd('status'), 'keepwarm is off. Up to 60 min per run, 12 pings, $1.00.')
  await e.cmd('30')
  assert.match(await e.cmd('off'), /stopped/)
  ok('typing and /keepwarm off disarm')
}

// 11. no pings while a turn is open
{
  const e = await boot(KW)
  await e.cmd('60')
  await e.run('turn.start')
  await e.advance(10 * MIN)
  assert.equal(e.forks, 0)
  ok('no pings while a turn is open')
}

// 12. band: 2 lines shows fuse + keepwarm status when armed
{
  const e = await boot(KW)
  await e.cmd('30')
  await e.advance(60)
  const band = await e.draw(80, 3)
  assert.equal(band.split('\n').length, 2)
  assert.match(band, /keepwarm on/)
  ok('2-line band while armed:\n' + band)
}

// 13. cache lifetime: unknown at first (assume 5m, marked "?"), then read from the write breakdown, then follows a plan change
{
  const e = await boot()
  assert.match(await e.draw(), /expires in 5:00 \u00B7 5m\?/)
  await e.advance(10)
  await e.step({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 90000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 90000 } })
  await e.advance(60)
  assert.match(await e.draw(), /expires in 59:00 \u00B7 1h(?![~?])/)
  await e.step({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90000, cache_creation_input_tokens: 800, cache_creation: { ephemeral_5m_input_tokens: 800, ephemeral_1h_input_tokens: 0 } })
  assert.match(await e.draw(), /expires in 5:00 \u00B7 5m(?![~?])/)
  ok('lifetime read from the write breakdown, and follows a mid-session switch to 5m')
}

// 14. no breakdown: a high hit ratio after a >5 minute gap proves the 1h cache (marked "~")
{
  const e = await boot()
  await e.advance(400)
  await e.step({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90000, cache_creation_input_tokens: 1000 })
  assert.match(await e.draw(), /\u00B7 1h~/)
  ok('1h inferred from a hit after a long gap')
}

// 15. a short gap, or a low hit ratio, proves nothing
{
  const e = await boot()
  await e.advance(200)
  await e.step({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90000, cache_creation_input_tokens: 1000 })
  await e.advance(400)
  await e.step({ input_tokens: 90000, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 1000 })
  assert.match(await e.draw(), /\u00B7 5m~/)
  assert.doesNotMatch(await e.draw(), /1h/)
  ok('no false 1h from a short gap; a miss after a long gap suggests 5m')
}

// 16. pinned: the setting wins over anything detected
{
  const e = await boot({ cacheTtl: '1h' })
  assert.match(await e.draw(), /expires in 1:00:00 \u00B7 1h(?![~?])/)
  await e.step({ cache_creation: { ephemeral_5m_input_tokens: 800, ephemeral_1h_input_tokens: 0 } })
  assert.match(await e.draw(), /\u00B7 1h(?![~?])/)
  const f = await boot({ cacheTtl: '5m' })
  await f.step({ cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 900 } })
  assert.match(await f.draw(), /expires in 5:00 \u00B7 5m(?![~?])/)
  ok('pinned lifetime ignores detection')
}

// 17. a subagent's request does not refresh the main conversation's countdown or teach it a lifetime
{
  const e = await boot()
  await e.advance(200)
  await e.step({ cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 5000 } }, 'agent-1')
  assert.match(await e.draw(), /expires in 1:40 \u00B7 5m\?/)
  ok('subagent requests are ignored')
}

// 18. keepwarm on a 1h cache: short breaks do not need it
{
  const e = await boot(KW)
  await e.step({ cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 90000 } })
  assert.match(await e.cmd('30'), /does not need keepwarm/)
  assert.equal(e.forks, 0)
  ok('keepwarm declines short breaks under a 1h cache')
}

// 19. keepwarm measures cost from cost.usd (the real shape), so its spend limit works
{
  const e = await boot(KW, { pingCost: 0.02 })
  await e.cmd('60')
  await e.advance(6 * MIN)
  assert.equal(e.forks, 1)
  assert.match(await e.draw(), /keepwarm on/)
  assert.match(e.logs.join('\n'), /first ping cost \$0\.0200/)
  ok('keepwarm reads cost.usd and keeps running')
}

console.log('ALL PASSED (' + n + ')')
