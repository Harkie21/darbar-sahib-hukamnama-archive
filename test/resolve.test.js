'use strict'

const assert = require('assert')
const Database = require('better-sqlite3')
const { toUnicode } = require('gurmukhi-utils')
const {
  Resolver, canon, splitLines, extractAng, extractCounters, THRESHOLDS,
} = require('../lib/resolve')
// Each fixture day resolved high here and agreed with gurbaninow in validation/report.md.
const fixtures = require('./fixtures.json')

const DB_PATH = process.env.SHABADOS_DB
  || 'node_modules/@shabados/database/build/database.sqlite'

let failures = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`) }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`) }
}

console.log('extraction')
check('gurmukhi ang', () => assert.strictEqual(extractAng('… ॥੨॥੧॥ ਅੰਗ-੭੧੧'), 711))
check('ascii ang', () => assert.strictEqual(extractAng('… ਅੰਗ-711'), 711))
check('no ang', () => assert.strictEqual(extractAng('ਸੰਤਨ ਅਵਰ ਨ ਕਾਹੂ ਜਾਨੀ ॥'), null))
check('all counters', () => assert.deepStrictEqual(
  extractCounters('… ॥੧੫੯੬॥ … ॥੧੫੯੭॥'), [ 1596, 1597 ]))
check('dsg counter', () => assert.deepStrictEqual(extractCounters('… ॥੧੪੭੨॥'), [ 1472 ]))

console.log('\ncanon')
check('mangal dropped', () => assert.strictEqual(canon('ੴ ਸਤਿਗੁਰ ਪ੍ਰਸਾਦਿ ॥'), ''))
check('vishraam-insensitive', () => assert.strictEqual(
  canon('ਹਰਿ ਕੈ; ਜਾ ਕੋ'), canon('ਹਰਿ ਕੈ  ਜਾ ਕੋ')))
check('counter-insensitive', () => assert.strictEqual(
  canon('ਮਨੁ ਮਾਨੀ ॥੨॥੧॥'), canon('ਮਨੁ ਮਾਨੀ ॥')))

console.log('\nsplitLines')
check('short headings fold into neighbours', () => {
  const l = splitLines('ਦੋਹਰਾ ॥ ਦੇਖਿ ਜੁਧਿਸਟਰਿ ਓਰਿ ਪ੍ਰਭੁ ਅਪਨੋ ਭਗਤਿ ਬਿਚਾਰਿ ॥ ਰਹਾਉ ॥')
  assert.ok(l.length >= 1, 'expected at least one usable line')
  assert.ok(l.every(x => canon(x).length >= 8), 'no stub lines may survive')
})

console.log('\nreal SGPC days (agreed with gurbaninow at high in validation/report.md)')
const R = new Resolver(DB_PATH)
const resolveCase = c => R.resolve(c.heading, c.bani, 1, { ang: c.ang })

for (const c of fixtures.cases) {
  check(`${c.date} SGGS: ${c.why}`, () => {
    const r = resolveCase(c)
    assert.ok(r.ok, `refused: ${JSON.stringify(r)}`)
    assert.strictEqual(r.confidence, 'high', JSON.stringify(r))
    assert.deepStrictEqual(r.shabad_ids, c.expect, JSON.stringify(r))
    assert.strictEqual(r.coverage, 1, `incomplete coverage: ${JSON.stringify(r)}`)
    assert.ok(r.line_ids.length > 0, 'line_ids must be populated')
  })
}

console.log('\ninvariants')
check('a nonzero ang_delta never vetoes a strong text match', () => {
  const r = resolveCase(fixtures.cases.find(x => x.date === '2026-01-29'))
  assert.notStrictEqual(r.ang_delta, 0, 'this fixture is chosen because ang disagrees')
  assert.ok(r.ok)
})
check('a reading cited before its last ang is not vetoed', () => {
  const r = resolveCase(fixtures.cases.find(x => x.date === '2026-06-19'))
  assert.ok(r.ang_scraped < r.ang_corpus_end, JSON.stringify(r))
  assert.ok(r.ok)
})
check('multi-shabad readings return every shabad, in order', () => {
  const multi = fixtures.cases.filter(x => x.expect.length > 1)
  assert.ok(multi.length >= 2, 'need at least two multi-shabad fixtures')
  for (const c of multi) assert.deepStrictEqual(resolveCase(c).shabad_ids, c.expect)
})
check('withholding the cited ang changes which tied line wins', () => {
  const c = fixtures.cases.find(x => x.date === '2026-07-05')
  const withAng = resolveCase(c)
  const without = R.resolve(c.heading, c.bani, 1, { ang: null })
  assert.notDeepStrictEqual(without.line_ids, withAng.line_ids, 'this fixture is chosen because an exact tie occurs')
})
check('garbage refuses rather than guessing', () => {
  const r = R.resolve('', 'ਕ ਖ ਗ ਘ ਙ ਚ ਛ ਜ ਝ ਞ ਟ ਠ ਡ ਢ ਣ ਤ ਥ ਦ ਧ ਨ ਪ ਫ ਬ ਭ ਮ', 1)
  assert.ok(!r.ok, `should not resolve: ${JSON.stringify(r)}`)
  assert.strictEqual(r.confidence, 'low')
})

console.log('\nduplicate passages (bench.js caught YLS resolving to K26)')
// ਗੁਰਦੇਵ ਮਾਤਾ appears twice in Guru Granth Sahib: YLS opens Bavan Akhri at ang
// 262 and K26 closes it at ang 250. The two saloks differ by three characters
// out of ~390, so text alone is a perfect tie and cannot choose between them.
// The bad resolution scored 1.000 with margin 0.000 and ang_delta +12, and was
// graded high because counter 1 — which sits on 6,043 Guru Granth lines —
// counted as agreement and waved it past the margin gate.
const db = new Database(DB_PATH, { readonly: true })
const linesFor = db.prepare(
  'SELECT gurmukhi, source_page FROM lines WHERE shabad_id = ? ORDER BY order_id'
)
const GURMUKHI = '੦੧੨੩੪੫੬੭੮੯'
const gurmukhiNum = n => String(n).split('').map(d => GURMUKHI[+d]).join('')

/** Page-style input rebuilt from the corpus, so no Gurbani text is committed. */
function fromCorpus(shabadId, ang) {
  const rows = linesFor.all(shabadId)
  assert.ok(rows.length, `${shabadId} missing from the corpus`)
  const bani = rows.map(r => toUnicode(r.gurmukhi)).join(' ').replace(/[;,]/g, '  ')
  return `${bani} ਅੰਗ-${gurmukhiNum(ang ?? rows[0].source_page)}`
}

for (const [ id, twin ] of [ [ 'YLS', 'K26' ], [ 'K26', 'YLS' ] ]) {
  check(`${id} never resolves confidently to its duplicate ${twin}`, () => {
    const r = R.resolve('', fromCorpus(id), 1)
    assert.ok(!r.shabad_ids.includes(twin),
      `picked the duplicate: ${JSON.stringify(r)}`)
    assert.ok(!r.ok || r.shabad_ids.includes(id),
      `confident but wrong: ${JSON.stringify(r)}`)
  })
}
check('an exact tie is broken towards the ang that was cited', () => {
  const r = R.resolve('', fromCorpus('YLS'), 1)
  assert.deepStrictEqual(r.shabad_ids, [ 'YLS' ], JSON.stringify(r))
  assert.strictEqual(r.ang_delta, 0, JSON.stringify(r))
})
check('a Guru Granth counter of 1 cannot stand in for margin', () => {
  const r = R.resolve('', fromCorpus('YLS'), 1)
  assert.ok(r.counter_agrees, 'counter 1 is present and found')
  assert.ok(r.counter_lines > 1000, `expected a worthless counter, got ${r.counter_lines}`)
  assert.strictEqual(r.counter_discriminates, false, JSON.stringify(r))
})
check('SGGS vetoes a reading cited well past the shabad it matched', () => {
  // PLN sits wholly on ang 711. +12 was the delta the bad YLS/K26 resolution
  // reported, and is well inside the +/-50 bound both granths share.
  const r = R.resolve('', fromCorpus('PLN', 723), 1)
  assert.deepStrictEqual(r.shabad_ids, [ 'PLN' ], JSON.stringify(r))
  assert.ok(!r.ok, `should be vetoed: ${JSON.stringify(r)}`)
  assert.strictEqual(r.reason, 'ang_impossible', JSON.stringify(r))
})
check('the SGGS bound is measured against the reading\'s last ang', () => {
  // A Guru Granth shabad may span several angs and the hukamnama may be cited
  // from any of them, so the bound cannot be a flat delta from the start.
  const wide = db.prepare(`
    SELECT l.shabad_id id, MIN(l.source_page) a, MAX(l.source_page) b
    FROM lines l JOIN shabads s ON s.id = l.shabad_id
    WHERE s.source_id = 1 GROUP BY l.shabad_id
    HAVING b - a >= 2 ORDER BY b - a DESC LIMIT 1
  `).get()
  const r = R.resolve('', fromCorpus(wide.id, wide.b), 1)
  assert.ok(r.ang_delta > THRESHOLDS.maxAngPastEndSggs,
    `fixture must exercise a delta past the flat bound, got ${r.ang_delta}`)
  assert.notStrictEqual(r.reason, 'ang_impossible', JSON.stringify(r))
})

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
