# cache-timer

A Claude Code **mod** that shows when your prompt cache expires: a draining "fuse" above the prompt. It also has
an optional, tightly limited `/keepwarm` command that keeps the cache alive while you step away.

```
cache ━━━━━━━━━━━━━━━━━✦                    expires in 2:20
↻ keepwarm on · 24m left · 2/12 pings · ~$0.04 · /keepwarm off      (only while keepwarm is armed)
```

Why it matters: when the cache is warm, Claude Code re-reads your conversation at a fraction of the normal input
price and responds faster. Once it expires, the next prompt pays full price to rebuild it. Seeing the countdown
helps you decide when a pause is worth avoiding.

## Install

In Claude Code:

```
/plugin marketplace add VelocityRisk/ClaudeCacheMod
/plugin install cache-timer@cache-timer
```

Restart Claude Code if the
timer does not appear. To remove it: `/plugin uninstall cache-timer@cache-timer`.

## Options

Set these from the plugin's configuration in Claude Code.

| Option | Default | Description |
|---|---|---|
| `style` | `fuse` | `fuse` (draining bar), `rule` (colored line above the prompt), `ember` (glyph beside the spinner) |
| `maxLines` | 2 | Lines the timer may use above the prompt, 1 to 3 |
| `cacheTtl` | `auto` | `auto`, `5m`, or `1h`. See below |
| `debug` | false | Write diagnostic lines to the debug log (`claude --debug-file`) |
| `keepwarmEnabled` | false | Allow `/keepwarm` |
| `keepwarmDefaultMinutes` | 30 | Duration when `/keepwarm` is run with no number |
| `keepwarmMaxMinutes` | 60 | Longest single `/keepwarm` run |
| `keepwarmMaxPings` | 12 | Most pings one run may send |
| `keepwarmMaxSpendUsd` | 1 | Stops a run once its pings have cost this much |

## Cache lifetime (5 minutes or 1 hour)

Claude Code chooses the lifetime per request: **1 hour** for the main conversation on a Claude subscription within
plan usage, **5 minutes** on an API key, a cloud provider, or a subscription that has run past its plan usage and
moved onto usage credits. So it can differ per person and change mid-session. You can also pin it with the
`promptCacheTtl` Claude Code setting.

**What a mod can see.** The result of `turn.step` carries `input_tokens`, `output_tokens`, `cache_read_input_tokens`,
`cache_creation_input_tokens` and `model`. It does not carry the 5m/1h split of cache writes that the API and
`claude -p` report (open request: anthropics/claude-code#100766), and nothing tells a mod whether the account is on
usage credits. So the mod cannot read the lifetime. It infers it, or you pin it.

How the mod decides (`cacheTtl` option):

1. **Pinned** (`5m` or `1h`): used as given. Exact if it matches how Claude Code is configured.
2. **Auto** (default): starts unknown and **assumes 5 minutes, marked `5m?`**. At 5:00 it does not claim the cache
   is expired. It says `5m passed · may still be warm`, because it may be a 1-hour cache. Then it learns from the
   first request after a gap longer than about 5 minutes: a high cache-hit ratio means the 1-hour cache (`1h~`);
   a miss suggests 5 minutes (`5m~`). It keeps checking, so a mid-session switch is noticed on the next long gap.
   Learned values last for the session only.
3. **If Claude Code ever passes the write breakdown to mods**, the mod uses it automatically (label with no mark)
   and tracks switches on every request.

The label after the countdown: `5m` / `1h` pinned or read directly, `1h~` / `5m~` inferred, `5m?` not learned yet.
Only the main conversation counts. A subagent's requests have their own cache and are ignored.

Detection changes the display, not the cache. A 1-hour write costs more than a 5-minute one (2x vs 1.25x the input
price), so it pays off if you often pause for more than 5 minutes, not for steady bursts.

## What `/keepwarm` is allowed to do

Off unless `keepwarmEnabled` is true. Every limit has a ceiling in code that no setting can raise.

| Limit | Default | Ceiling | Notes |
|---|---|---|---|
| Minutes per run | 30 (default), 60 (max) | 90 | `/keepwarm 45` is clamped to the max |
| Session allowance | 2 x the max | 2 x 90 | blocks re-arming in a loop; restart Claude Code to reset |
| Pings per run | 12 | 20 | one ping about every 4:30 |
| Spend per run | $1.00 | $5.00 | measured from session cost; if cost cannot be measured, it stops after the first ping |
| Plan limit | stops at 80% | fixed | |

It also stops when you type a prompt, when two pings fail, when the cache is already cold, and at session end.
It never pings while a turn is running, and on a 1-hour cache it declines breaks under 50 minutes. Each ping asks
Claude one tiny question over the current conversation, so it spends tokens (mostly cheap cache reads).

## Development

```
plugin/                  the plugin: manifest, hooks.json, register.mjs (one self-contained file)
.claude-plugin/          marketplace.json, so the repo can be added as a marketplace
tools/dollar-lint.mjs    approximate check of the validator's `$` rule
tests/                   offline logic tests (no Claude Code needed)
```

```
npm test                                  # offline tests, no Claude Code needed
claude plugin validate plugin --strict    # needs the claude CLI
```

Rules for editing `register.mjs` (the Claude Code validator enforces these):

- Keep it one file. The validator reads only the file `hooks.json` names; imports are invisible to its audit.
- `$` may be written only as `$.noun.event(...)` or passed to a function declared at the top level of the file.
  No `fn($)` through a variable, no helper functions nested inside `register()`.
- `on` is always `on("<literal event>", hook)`. Register each event once per matcher.

## Status

Logic is tested offline. Behavior in real Claude Code, including WSL path handling, the cache-read cost of a ping,
and how plugin options are resolved across settings scopes, has had limited verification. Issues and pull
requests are welcome.

## License

MIT. See [LICENSE](LICENSE).
