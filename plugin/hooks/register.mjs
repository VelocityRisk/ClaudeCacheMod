// Claude cache timer mod. One self-contained hooks module.
// Claude Code's validator reads only this file. Rule: `$` may be written only as
// $.noun.event(...) or passed to a function declared at the top level of this file.

const DEFAULTS = {
  cacheTtl: 'auto', // auto (detect it) | 5m | 1h (pin it)
  style: 'fuse', // fuse | rule | ember
  maxLines: 2, // 1 to 3
  debug: false,
  keepwarmEnabled: false,
  keepwarmDefaultMinutes: 30,
  keepwarmMaxMinutes: 60,
  keepwarmMaxPings: 12,
  keepwarmMaxSpendUsd: 1,
}

// Ceilings no setting can raise. plugin.json enforces the same numbers as `max`.
const HARD_MAX_MINUTES = 90
const HARD_MAX_PINGS = 20
const HARD_MAX_SPEND_USD = 5
const STOP_AT_PLAN_PERCENT = 80

let cfg = { ...DEFAULTS }

const state = {
  lastHit: null, // ms timestamp of the latest main-conversation request sent to the model
  ttlSec: null, // detected cache lifetime in seconds (300 or 3600), null until learned
  ttlSource: 'default', // breakdown | inferred | default
  now: 0, // refreshed by a 1s timer so ui.render stays synchronous
  working: false,
  kw: { available: false, armed: false, armedAt: 0, endsAt: 0, usedMs: 0, pings: 0, spent: 0, hasCost: false, note: '' },
}
const kw = state.kw

const p = (text, color, dim) => ({ text, color, dim })
const fmt = (s) => {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return (h > 0 ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(sec).padStart(2, '0')
}

function num(v, dflt, lo, hi) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt
}

function dbg($, msg) {
  if (cfg.debug) $.ui.log('cache-timer: ' + msg, { to: 'debug' })
}
let dbgLastRender = ''

function ttlOf() {
  if (cfg.cacheTtl === '5m') return 300
  if (cfg.cacheTtl === '1h') return 3600
  return state.ttlSec === null ? 300 : state.ttlSec // until learned, assume the shorter lifetime
}
// Shown next to the countdown. No mark: pinned or read from the API's write breakdown.
// "~": inferred from a hit after a long gap. "?": not learned yet, assuming 5m.
function ttlLabel() {
  const name = ttlOf() >= 3600 ? '1h' : '5m'
  if (cfg.cacheTtl === '5m' || cfg.cacheTtl === '1h') return name
  if (state.ttlSec === null) return name + '?'
  return state.ttlSource === 'inferred' ? name + '~' : name
}

function ttlUnknown() {
  return cfg.cacheTtl !== '5m' && cfg.cacheTtl !== '1h' && state.ttlSec === null
}

function setTtl($, sec, source, why) {
  if (state.ttlSec !== sec) dbg($, 'cache lifetime now ' + (sec >= 3600 ? '1h' : '5m') + ' (' + source + ': ' + why + ')')
  state.ttlSec = sec
  state.ttlSource = source
}

// Learn the lifetime from what the API reported for one main-conversation request.
// Claude Code picks 1h on a subscription within plan usage and 5m otherwise, and can switch mid-session
// (for example when plan usage runs out), so this runs on every request.
function learnTtl($, usage, gapSec) {
  if (!usage || cfg.cacheTtl === '5m' || cfg.cacheTtl === '1h') return
  // Best signal: the API's per-lifetime breakdown of what this request wrote, if Claude Code passes it through.
  const cc = usage.cache_creation
  if (cc && typeof cc === 'object') {
    const h = Number(cc.ephemeral_1h_input_tokens) || 0
    const m = Number(cc.ephemeral_5m_input_tokens) || 0
    if (h > 0 || m > 0) {
      setTtl($, h >= m ? 3600 : 300, 'breakdown', '1h=' + h + ' 5m=' + m)
      return
    }
  }
  // Fallback: only a gap longer than 5 minutes tells the two lifetimes apart.
  if (state.ttlSource === 'breakdown' || gapSec === null || gapSec <= 330 || gapSec >= 3300) return
  const read = Number(usage.cache_read_input_tokens) || 0
  const wrote = Number(usage.cache_creation_input_tokens) || 0
  const fresh = Number(usage.input_tokens) || 0
  const total = read + wrote + fresh
  if (total === 0) return
  if (read / total >= 0.8) setTtl($, 3600, 'inferred', 'cache hit after ' + Math.round(gapSec) + 's')
  else if (read / total < 0.2 && (state.ttlSec === null || (state.ttlSec === 3600 && state.ttlSource === 'inferred'))) setTtl($, 300, 'inferred', 'miss after ' + Math.round(gapSec) + 's')
}
function kwMaxMinutes() {
  return num(cfg.keepwarmMaxMinutes, DEFAULTS.keepwarmMaxMinutes, 1, HARD_MAX_MINUTES)
}
function kwDefaultMinutes() {
  return Math.min(num(cfg.keepwarmDefaultMinutes, DEFAULTS.keepwarmDefaultMinutes, 1, HARD_MAX_MINUTES), kwMaxMinutes())
}
function kwMaxPings() {
  return num(cfg.keepwarmMaxPings, DEFAULTS.keepwarmMaxPings, 1, HARD_MAX_PINGS)
}
function kwMaxSpend() {
  return num(cfg.keepwarmMaxSpendUsd, DEFAULTS.keepwarmMaxSpendUsd, 0.1, HARD_MAX_SPEND_USD)
}
function kwIntervalSec() {
  return Math.max(60, Math.floor(ttlOf() * 0.9))
}
function kwBudgetMs() {
  return kwMaxMinutes() * 2 * 60000 // total armed time one session may use
}

function secondsLeft() {
  if (state.lastHit === null) return null
  return Math.max(0, ttlOf() - Math.floor((state.now - state.lastHit) / 1000))
}

function tone(left) {
  const ttl = ttlOf()
  if (left <= 0) return 'red'
  if (left > ttl * 0.4) return 'green'
  return left > ttl * 0.1 ? 'yellow' : 'red'
}

function stateText(left) {
  const ttl = ttlOf()
  if (left <= 0 && ttlUnknown()) return 'Past 5 minutes. If your next reply is quick, you have the 1-hour cache.'
  if (left <= 0) return 'Cold. Next turn re-reads your whole context at full price.'
  if (left <= ttl * 0.1) return 'Expiring. Next turn may re-read your whole context at full price.'
  if (left <= ttl * 0.4) return 'Cooling. Send a prompt before it expires.'
  return 'Warm. Replies reuse your cached context at a fraction of the price.'
}

function keepwarmRow() {
  if (kw.armed) {
    const mins = Math.max(1, Math.ceil((kw.endsAt - state.now) / 60000))
    const cost = kw.hasCost ? ' \u00B7 ~$' + kw.spent.toFixed(2) : ''
    return [p('\u21BB keepwarm on', 'cyan'), p(' \u00B7 ' + mins + 'm left \u00B7 ' + kw.pings + '/' + kwMaxPings() + ' pings' + cost + ' \u00B7 ', null, true), p('/keepwarm off', null, true)]
  }
  if (kw.note) return [p(kw.note, null, true)]
  return [p('/keepwarm', 'cyan'), p('  keep the cache alive for up to ' + kwDefaultMinutes() + ' min', null, true)]
}

function buildRows(cols, maxRows) {
  const ttl = ttlOf()
  const left = secondsLeft()
  if (left === null && !kw.armed) return []
  const cand = [] // pri: lower wins a scarce line. order: top-to-bottom position.

  if (left !== null) {
    const c = left <= 0 && ttlUnknown() ? 'yellow' : tone(left)
    const barW = Math.max(8, Math.min(36, cols - 34))
    if (cfg.style === 'fuse') {
      if (left > 0) {
        const filled = Math.round((left / ttl) * barW)
        const spark = Math.floor(state.now / 500) % 2 ? '\u2727' : '\u2726'
        cand.push({ pri: 0, order: 0, parts: [p('cache ', null, true), p('\u2501'.repeat(filled) + spark, c), p(' '.repeat(barW - filled) + ' expires in ' + fmt(left), c), p(' \u00B7 ' + ttlLabel(), null, true)] })
      } else {
        const gone = ttlUnknown() ? '5m passed \u00B7 may still be warm' : 'fuse burned out \u00B7 expired'
        cand.push({ pri: 0, order: 0, parts: [p('cache ', null, true), p(gone, c), p(' \u00B7 ' + ttlLabel(), null, true)] })
      }
    } else if (cfg.style === 'rule') {
      cand.push({ pri: 0, order: 0, parts: [p('cache ', null, true), p(left > 0 ? 'expires in ' + fmt(left) : (ttlUnknown() ? '5m passed \u00B7 may still be warm' : 'expired'), c), p(' \u00B7 ' + ttlLabel(), null, true)] })
      const blink = left > 0 && left <= 30 && Math.floor(state.now / 500) % 2
      cand.push({ pri: 1.2, order: 99, parts: [p('\u2500'.repeat(Math.max(8, cols - 2)), c, Boolean(blink))] })
    }
    if (left <= ttl * 0.4 || kw.armed) cand.push({ pri: 3, order: 1, parts: [p(stateText(left), null, true)] })
  }

  if (kw.available) {
    if (kw.armed || kw.note) cand.push({ pri: 1, order: 2, parts: keepwarmRow() })
    else if (left !== null && left > 0 && left <= ttl * 0.1) cand.push({ pri: 2, order: 2, parts: keepwarmRow() })
  }

  return cand.sort((a, b) => a.pri - b.pri).slice(0, Math.max(0, maxRows)).sort((a, b) => a.order - b.order).map((c) => c.parts)
}

// ---- keepwarm ----------------------------------------------------------------

let kwPinging = false
let kwFailures = 0

// Every way keepwarm ends goes through here, so armed time is always counted.
function kwDisarm() {
  if (kw.armed) kw.usedMs += Math.max(0, state.now - kw.armedAt)
  kw.armed = false
}

function kwStop($, why) {
  kwDisarm()
  kw.note = 'keepwarm stopped \u00B7 ' + why + ' \u00B7 ' + kw.pings + ' pings' + (kw.hasCost ? ' \u00B7 ~$' + kw.spent.toFixed(2) : '')
  $.ui.log(kw.note)
  $.ui.invalidate('ui.render')
}

// $.session.usage().cost is an object with a usd field. A plain number is accepted too.
function costOf(u) {
  const c = u ? u.cost : null
  if (typeof c === 'number') return c
  return c && typeof c.usd === 'number' ? c.usd : null
}

async function kwUsage($) {
  try {
    return await $.session.usage()
  } catch {
    return null
  }
}

async function kwPing($) {
  kwPinging = true
  try {
    const before = await kwUsage($)
    if (before && Array.isArray(before.rateLimits) && before.rateLimits.some((l) => l.percentUsed >= STOP_AT_PLAN_PERCENT)) {
      kwStop($, 'plan limit above ' + STOP_AT_PLAN_PERCENT + '%')
      return
    }
    // fork asks one question over the current conversation, so the API should serve
    // it from the same prompt cache entry and refresh that entry's timer
    const r = await $.model.fork({ prompt: 'Reply with a single period.', maxTokens: 16, timeoutMs: 30000 })
    if (!r.isAnswered) {
      kwFailures += 1
      kw.note = 'ping failed: ' + (r.reason || 'unknown')
      if (kwFailures >= 2) kwStop($, 'two pings failed')
      return
    }
    kwFailures = 0
    kw.note = ''
    kw.pings += 1
    state.lastHit = await $.clock.now()

    const after = await kwUsage($)
    const costBefore = costOf(before)
    const costAfter = costOf(after)
    if (costBefore !== null && costAfter !== null) {
      const delta = costAfter - costBefore
      kw.spent += delta
      kw.hasCost = true
      if (kw.pings === 1) $.ui.log('keepwarm: first ping cost $' + delta.toFixed(4) + '. A cache read should be about a tenth of your input price; a write would be 1.25x.')
    }
    // Fail closed: the spend limit is only real if the cost can be measured.
    if (!kw.hasCost) {
      kwStop($, 'ping cost cannot be measured')
      return
    }
    if (kw.spent >= kwMaxSpend()) kwStop($, 'spend limit reached')
  } catch (err) {
    kwFailures += 1
    kw.note = 'ping error: ' + err.message
    if (kwFailures >= 2) kwStop($, 'two pings failed')
  } finally {
    kwPinging = false
    $.ui.invalidate('ui.render')
  }
}

async function kwTick($) {
  if (!kw.armed || kwPinging || state.working) return
  if (!kw.available) {
    kwDisarm()
    return
  }
  if (state.now >= kw.endsAt) {
    kwStop($, 'time limit reached')
    return
  }
  if (kw.pings >= kwMaxPings()) {
    kwStop($, 'ping limit reached')
    return
  }
  if (state.lastHit === null) return
  const age = (state.now - state.lastHit) / 1000
  if (age > ttlOf()) {
    kwStop($, 'cache already cold')
    return
  }
  if (age >= kwIntervalSec()) await kwPing($)
}

// ---- hooks -------------------------------------------------------------------

export function register(on, options) {
  cfg = { ...DEFAULTS, ...(options || {}) }
  const maxLines = Math.max(1, Math.min(3, Number(cfg.maxLines) || DEFAULTS.maxLines))
  kw.available = cfg.keepwarmEnabled === true || cfg.keepwarmEnabled === 'true'

  on('session.start', async ($, e, next) => {
    state.now = await $.clock.now()
    dbg($, 'session.start ran (style=' + cfg.style + ', maxLines=' + maxLines + ', ttl=' + ttlOf() + ', keepwarm=' + kw.available + ')')
    $.clock.every(1000, async () => {
      state.now = await $.clock.now()
      if (state.lastHit !== null || kw.armed) $.ui.invalidate('ui.render')
    })
    if (kw.available) {
      $.clock.every(5000, () => kwTick($))
      try {
        await $.command.register({
          name: 'keepwarm',
          description: 'Keep the prompt cache warm while you are away (spends tokens)',
          argumentHint: '[minutes|off|status]',
          immediate: true,
        })
      } catch (err) {
        $.ui.log('keepwarm: command not registered: ' + err.message)
      }
    }
    return next(e)
  })

  // Every main-conversation request refreshes the cache, so restart the countdown. A subagent's request has its
  // own prefix and its own cache, so it is ignored. The result carries the API's usage, which tells us the lifetime.
  on('turn.step', async function* ($, e, next) {
    const startedAt = await $.clock.now()
    const main = !e.agentId
    const gapSec = main && state.lastHit !== null ? (startedAt - state.lastHit) / 1000 : null
    if (main) state.lastHit = startedAt
    dbg($, 'turn.step fired' + (main ? '' : ' (subagent, ignored)'))
    const result = yield* next(e)
    if (main && result) learnTtl($, result.usage, gapSec)
    return result
  })
  on('turn.start', async ($, e, next) => {
    state.working = true
    dbg($, 'turn.start')
    return next(e)
  })
  on('turn.complete', async ($, e, next) => {
    state.working = false
    dbg($, 'turn.complete')
    return next(e)
  })

  // A new or compacted conversation has a new prefix, so the old cache is gone.
  on('session.compact', async ($, e, next) => {
    state.lastHit = null
    return next(e)
  })
  on('session.end', async ($, e, next) => {
    state.lastHit = null
    kwDisarm()
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const down = await next(e)
    const props = e.props || {}
    const rows = buildRows(props.bodyColumns || 80, Math.min(props.maxRows || 3, maxLines))
    const msg = 'AbovePrompt rows=' + rows.length + ' maxRows=' + props.maxRows + ' cols=' + props.bodyColumns + ' survey=' + props.hasSurvey + ' down=' + (down ? 'node' : 'none') + ' lastHit=' + (state.lastHit === null ? 'null' : 'set')
    if (msg !== dbgLastRender) {
      dbgLastRender = msg
      dbg($, msg)
    }
    if (props.hasSurvey || rows.length === 0) return down
    const { Box, Text } = $.ui.resolve(e)
    const mine = Box({
      flexDirection: 'column',
      paddingX: 1,
      children: rows.map((parts) =>
        Box({ children: parts.map((x) => Text({ color: x.color || undefined, dimColor: Boolean(x.dim), children: x.text })) }),
      ),
    })
    return down ? Box({ flexDirection: 'column', children: [mine, down] }) : mine
  })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (cfg.style !== 'ember') return next(e)
    const left = secondsLeft()
    if (left === null) return next(e)
    const glyphs = '\u2801\u2803\u2807\u2847\u28C7\u28E7\u28F7\u28FF'
    const g = glyphs[Math.max(0, Math.min(7, Math.ceil((left / ttlOf()) * 8) - 1))]
    const tag = ' \u00B7 ' + g + ' cache ' + (left > 0 ? fmt(left) : 'cold')
    return next({ ...e, props: { ...e.props, suffix: (e.props.suffix || '') + tag } })
  })

  on('command.run', { command: 'keepwarm' }, async ($, e) => {
    if (!kw.available) return { text: 'keepwarm is turned off by your organization.' }
    const arg = String(e.args || '').trim().toLowerCase()
    const sum = kw.pings + '/' + kwMaxPings() + ' pings' + (kw.hasCost ? ' \u00B7 ~$' + kw.spent.toFixed(2) : '')
    if (arg === 'off' || arg === 'stop') {
      if (!kw.armed) return { text: 'keepwarm is already off' }
      kwDisarm()
      kw.note = ''
      $.ui.invalidate('ui.render')
      return { text: 'keepwarm stopped \u00B7 ' + sum }
    }
    if (arg === 'status') {
      if (!kw.armed) return { text: 'keepwarm is off. Up to ' + kwMaxMinutes() + ' min per run, ' + kwMaxPings() + ' pings, $' + kwMaxSpend().toFixed(2) + '.' }
      return { text: 'keepwarm on \u00B7 ' + Math.max(1, Math.ceil((kw.endsAt - state.now) / 60000)) + 'm left \u00B7 ' + sum }
    }
    if (kw.armed) return { text: 'keepwarm is already on. /keepwarm off to stop it.' }
    if (state.lastHit === null) return { text: 'Nothing to keep warm yet. Send a prompt first.' }
    const asked = arg === '' ? kwDefaultMinutes() : Number(arg)
    if (!Number.isFinite(asked) || asked <= 0) return { text: 'Usage: /keepwarm [minutes|off|status]. Up to ' + kwMaxMinutes() + ' min.' }
    const budgetLeft = Math.floor((kwBudgetMs() - kw.usedMs) / 60000)
    const minutes = Math.min(asked, kwMaxMinutes(), budgetLeft)
    if (minutes < 1) return { text: 'This session has used its keepwarm allowance. Restart Claude Code to reset it.' }
    if (ttlOf() >= 3000 && minutes <= 50) return { text: 'Your cache lasts about an hour, so a break under 50 minutes does not need keepwarm.' }
    const now = await $.clock.now()
    kw.armed = true
    kw.armedAt = now
    kw.endsAt = now + minutes * 60000
    kw.pings = 0
    kw.spent = 0
    kw.hasCost = false
    kw.note = ''
    kwFailures = 0
    $.ui.invalidate('ui.render')
    return {
      text:
        'keepwarm armed for ' + minutes + ' min' + (minutes < asked ? ' (limit applied)' : '') +
        ' \u00B7 ping every ' + fmt(kwIntervalSec()) + ' \u00B7 stops at ' + kwMaxPings() + ' pings, $' + kwMaxSpend().toFixed(2) + ', or when you type',
    }
  })

  // Typing a prompt means you are back, and a real turn keeps the cache warm.
  on('prompt.submit', async ($, e, next) => {
    if (kw.available && !String(e.text || '').startsWith('/keepwarm')) {
      if (kw.armed) {
        kwDisarm()
        $.ui.log('keepwarm stopped \u00B7 welcome back \u00B7 ' + kw.pings + ' pings')
      }
      kw.note = ''
    }
    return next(e)
  })
}
