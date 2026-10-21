// Approximate check of the validator rule that failed on v0.1: `$` may only be written
// $.noun.event(...), declared as a parameter, or passed to a function declared at the top
// level of the same file. This is NOT the real validator; always run `claude plugin validate`.
import { readFileSync } from 'node:fs'

let bad = 0
for (const file of process.argv.slice(2)) {
  const src = readFileSync(file, 'utf8')
  const code = src
    .replace(/\/\/.*$/gm, '')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
  const top = new Set()
  for (const m of code.matchAll(/^(?:async )?function\*? (\w+)/gm)) top.add(m[1])
  for (const m of code.matchAll(/^const (\w+) = (?:async )?\(/gm)) top.add(m[1])

  const problems = []
  for (const m of code.matchAll(/\$(?![\w$])/g)) {
    const before = code.slice(Math.max(0, m.index - 40), m.index)
    const after = code.slice(m.index + 1, m.index + 40)
    if (after.startsWith('.')) {
      if (!/^\.\w+\.\w+\(/.test(after)) problems.push('not $.noun.event(...): ' + (before + '$' + after).replace(/\n/g, ' '))
      continue
    }
    if (/(?:async |function\*? \w*)\($/.test(before) || /\(\s*$/.test(before) && /^(,|\))/.test(after) && /(?:async|on\([^)]*|function\*?\s*\w*)\s*\($/.test(before)) continue
    const call = before.match(/(\w+)\($/)
    if (call && /^[,)]/.test(after)) {
      if (/function\*?\s+$/.test(before.slice(0, before.length - call[0].length)) ) continue
      if (!top.has(call[1])) problems.push('$ passed to non-top-level "' + call[1] + '"')
      continue
    }
    problems.push('other use of $: ' + (before + '$' + after).replace(/\n/g, ' '))
  }
  console.log(file + ': ' + (problems.length ? problems.length + ' problem(s)' : 'ok') + ' (top-level fns: ' + [...top].join(', ') + ')')
  for (const pr of problems) console.log('  ' + pr)
  bad += problems.length
}
process.exit(bad ? 1 : 0)
