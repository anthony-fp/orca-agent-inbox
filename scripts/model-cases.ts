// Runs the inbox model on the exchanges in src/fixtures/model-cases.json, as the worker does, and counts the runs
// whose CLOSED lines close every id in `close` and none in `open`. See docs/model-compare.md, "Model cases".
// Usage: bun scripts/model-cases.ts [claude|codex <codex home>] [runs] [case name]
import { readFileSync } from 'node:fs'
import { runInboxModel } from '../src/model'
import { buildPrompt } from '../src/core/model-text'

type Case = { name: string; ledger: any; exchange: any; close: string[]; open: string[] }
const [host = 'claude', ...rest] = process.argv.slice(2)
const codexHome = host === 'codex' ? rest.shift() : undefined
const runs = Number(rest[0] ?? 10)
const cases: Case[] = JSON.parse(readFileSync(new URL('../src/fixtures/model-cases.json', import.meta.url), 'utf8'))

for (const c of cases.filter(c => !rest[1] || c.name === rest[1])) {
  const prompt = buildPrompt(c.ledger, c.exchange)
  const source = [c.exchange.reply, ...c.exchange.activity].join('\n')
  const results = await Promise.all(
    Array.from({ length: runs }, () => runInboxModel(prompt, { source, ...(codexHome ? { codexHome } : {}) })),
  )
  let passed = 0
  for (const r of results) {
    if (!r.ok) { console.log(`  ${c.name}: ${r.reason}`); continue }
    const closed = r.update.closed.map(x => x.id)
    const ok = c.close.every(id => closed.includes(id)) && !c.open.some(id => closed.includes(id))
    if (ok) passed++
    else console.log(`  ${c.name} failed: CLOSED ${JSON.stringify(r.update.closed)} card ${JSON.stringify(r.update.card)}`)
  }
  console.log(`${c.name}: ${passed}/${runs} passed`)
}
