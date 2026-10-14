'use strict'

const assert = require('assert')
const { pack } = require('../lib/pack')

let failures = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`) }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`) }
}

const EXPECTED_KEYS = [
  'shabad_ids', 'line_ids', 'confidence', 'score', 'margin',
  'ang', 'ang_delta', 'counters',
].sort()

const SAMPLE_RESULT = {
  ok: true,
  shabad_ids: [ '0US' ],
  line_ids: [ 'ABCD', 'EFGH' ],
  confidence: 'high',
  score: 0.975,
  margin: 0.498,
  ang_scraped: 673,
  ang_delta: 0,
  counters: [ 1596, 1597 ],
}

console.log('pack() shape')
check('publishes exactly the archive contract fields', () => {
  assert.deepStrictEqual(Object.keys(pack(SAMPLE_RESULT)).sort(), EXPECTED_KEYS)
})
check('does not leak internal diagnostics', () => {
  const withDiagnostics = { ...SAMPLE_RESULT, counters_found: [ 1596 ], counter_agrees: true }
  const keys = Object.keys(pack(withDiagnostics))
  assert.ok(!keys.includes('counters_found'), 'counters_found must not be published')
  assert.ok(!keys.includes('counter_agrees'), 'counter_agrees must not be published')
})
check('null input packs to null', () => {
  assert.strictEqual(pack(null), null)
})
check('a failed resolution still reports confidence with empty shabad_ids/line_ids', () => {
  const r = pack({ ok: false, confidence: 'low', score: 0.2, margin: 0.01, ang_scraped: 100, ang_delta: 5, counters: [] })
  assert.deepStrictEqual(r.shabad_ids, [])
  assert.deepStrictEqual(r.line_ids, [])
  assert.strictEqual(r.confidence, 'low')
})

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
