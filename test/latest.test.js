'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { writeDay, writeLatest } = require('../lib/write')
const { buildPayload, run } = require('../bin/fetch-today')

let failures = 0
// Queued and run in order, since run() is async and output must stay grouped.
const queue = []
const section = title => queue.push(() => console.log(title))
const check = (name, fn) => queue.push(async () => {
  try { await fn(); console.log(`  ok   ${name}`) }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`) }
})

function tmpArchiveDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'archive-latest-test-'))
}

const listFiles = dir => fs.readdirSync(dir, { recursive: true })
  .filter(f => fs.statSync(path.join(dir, f)).isFile())

const OK_RESULT = {
  ok: true, shabad_ids: [ 'DWV' ], line_ids: [ 'ABCD' ], confidence: 'high',
  score: 1.0, margin: 0.574, ang_scraped: 598, ang_delta: 0, counters: [ 1, 2, 3, 4 ],
}
const FAILED_RESULT = {
  ok: false, confidence: 'low', score: 0.2, margin: 0.05, ang_scraped: 598,
  ang_delta: 5, counters: [],
}

// Real hukamnamasahib.com pages (trimmed); run() is given stubs so no request ever leaves.
const fixture = f => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8')
const MORNING = fixture('hns-2026-10-14-morning.html')
const NOT_FOUND = fixture('hns-2026-10-18-notfound.html')
const SANGRAND = fixture('hns-2026-10-17-sangrand.html')
const ok = html => ({ status: 200, body: Buffer.from(html) })
// The site answers today's URL with the 10-14 page on 10-14 and its not-found page otherwise.
const SITE = async date => ok(date === '2026-10-14' ? MORNING : NOT_FOUND)

const stubRun = (dir, today, env = {}, result = OK_RESULT) => run({
  fetchPage: SITE,
  today: () => today,
  env,
  archiveDir: dir,
  makeResolver: () => ({ resolve: () => result }),
  makeSplitter: () => () => null,
  corpusVersion: '4.8.7',
  log: () => {},
  out: () => {},
})

const RUN_UTC = '2026-10-14T02:07:00.000Z'
const OTHER_RESULT = { ...OK_RESULT, shabad_ids: [ 'XYZ' ], line_ids: [ 'WXYZ' ], margin: 0.4 }
const PAGE = '"page_date":"2026-10-14","page_time":null,"page_created_utc":null,' +
  '"page_modified_utc":"2026-10-13T23:53:49.000Z","heading_split":false'
const NO_PAGE = '"page_date":null,"page_time":null,"page_created_utc":null,"page_modified_utc":null,"heading_split":null'

/** run() with stdout captured. Errors are returned, not thrown, so the line can be checked. */
async function capture(dir, today, { env = {}, result = OK_RESULT, fetchPage = SITE, splitTail = () => null } = {}) {
  const lines = []
  const asked = []
  let code = null
  let error = null
  try {
    code = await run({
      fetchPage: async date => { asked.push(date); return fetchPage(date) },
      today: () => today,
      env,
      archiveDir: dir,
      makeResolver: () => ({ resolve: () => result }),
      makeSplitter: () => splitTail,
      corpusVersion: '4.8.7',
      log: () => {},
      now: () => RUN_UTC,
      out: line => lines.push(line),
    })
  } catch (e) { error = e }
  return { code, error, lines, asked }
}

const read = (dir, ...p) => fs.readFileSync(path.join(dir, ...p), 'utf8')

section('archive/latest.json')

check('key set matches the dated file exactly', () => {
  const dir = tmpArchiveDir()
  const payload = buildPayload('2026-10-14', { sggs: OK_RESULT }, '4.8.7')
  writeDay(dir, payload)
  writeLatest(dir, payload)

  const dated = JSON.parse(fs.readFileSync(path.join(dir, '2026', '10', '14.json'), 'utf8'))
  const latest = JSON.parse(fs.readFileSync(path.join(dir, 'latest.json'), 'utf8'))

  assert.deepStrictEqual(Object.keys(latest).sort(), Object.keys(dated).sort())
  assert.deepStrictEqual(Object.keys(latest.sggs).sort(), Object.keys(dated.sggs).sort())
  assert.deepStrictEqual(latest, dated)
  assert.strictEqual(dated.source, 'darbar_sahib')
})

check('buildPayload throws on a failed SGGS resolution, before any write is reachable', () => {
  assert.throws(
    () => buildPayload('2026-10-15', { sggs: FAILED_RESULT }, '4.8.7'),
    /sggs_unresolved/
  )
})

check('a stale latest.json survives a failed run untouched', () => {
  const dir = tmpArchiveDir()
  const stale = buildPayload('2026-10-10', { sggs: OK_RESULT }, '4.8.7')
  writeLatest(dir, stale)
  const before = fs.readFileSync(path.join(dir, 'latest.json'), 'utf8')

  assert.throws(() => buildPayload('2026-10-15', { sggs: FAILED_RESULT }, '4.8.7'))

  const after = fs.readFileSync(path.join(dir, 'latest.json'), 'utf8')
  assert.strictEqual(after, before)
})

check('no field varies between two consecutive runs on the same day', () => {
  const dir = tmpArchiveDir()

  const run1 = buildPayload('2026-10-14', { sggs: OK_RESULT }, '4.8.7')
  writeDay(dir, run1)
  writeLatest(dir, run1)
  const day1 = fs.readFileSync(path.join(dir, '2026', '10', '14.json'), 'utf8')
  const latest1 = fs.readFileSync(path.join(dir, 'latest.json'), 'utf8')

  const run2 = buildPayload('2026-10-14', { sggs: OK_RESULT }, '4.8.7')
  writeDay(dir, run2)
  writeLatest(dir, run2)
  const day2 = fs.readFileSync(path.join(dir, '2026', '10', '14.json'), 'utf8')
  const latest2 = fs.readFileSync(path.join(dir, 'latest.json'), 'utf8')

  assert.strictEqual(day1, day2)
  assert.strictEqual(latest1, latest2)
  assert.strictEqual(day1, latest1)
})

section('\nIST date guard')

check('today\'s morning page writes the day and latest.json', async () => {
  const dir = tmpArchiveDir()
  assert.strictEqual(await stubRun(dir, '2026-10-14'), 0)
  assert.deepStrictEqual(listFiles(dir).sort(), [ path.join('2026', '10', '14.json'), 'latest.json' ])
})
check('the page asked for is today\'s IST date', async () => {
  const { asked } = await capture(tmpArchiveDir(), '2026-10-14')
  assert.deepStrictEqual(asked, [ '2026-10-14' ])
})
check('no page yet writes nothing', async () => {
  const dir = tmpArchiveDir()
  await stubRun(dir, '2026-10-15')
  await stubRun(dir, '2026-10-15', { FINAL_RUN: '1' })
  assert.deepStrictEqual(listFiles(dir), [])
})
check('no page yet exits 0 unless FINAL_RUN=1', async () => {
  const dir = tmpArchiveDir()
  assert.strictEqual(await stubRun(dir, '2026-10-15'), 0)
  assert.strictEqual(await stubRun(dir, '2026-10-15', { FINAL_RUN: '0' }), 0)
  assert.strictEqual(await stubRun(dir, '2026-10-15', { FINAL_RUN: '1' }), 1)
})
check('a low resolution on the right day throws and writes nothing', async () => {
  const dir = tmpArchiveDir()
  await assert.rejects(stubRun(dir, '2026-10-14', {}, FAILED_RESULT), /sggs_unresolved/)
  assert.deepStrictEqual(listFiles(dir), [])
})

section('\nrun log line')

check('written: exact line', async () => {
  const dir = tmpArchiveDir()
  const { code, lines } = await capture(dir, '2026-10-14')
  assert.strictEqual(code, 0)
  assert.deepStrictEqual(lines, [
    `{"run_utc":"2026-10-14T02:07:00.000Z",${PAGE},"outcome":"written","shabad_ids":["DWV"],"confidence":"high"}`,
  ])
})
check('page times reach the log line but never the archive files', async () => {
  const dir = tmpArchiveDir()
  await capture(dir, '2026-10-14')
  for (const f of [ read(dir, '2026', '10', '14.json'), read(dir, 'latest.json') ]) {
    assert.ok(!/page_|_utc|2026-10-13T/.test(f), f)
  }
})
check('heading_split: true when the split fired, and the archive bytes do not depend on it', async () => {
  const plainDir = tmpArchiveDir()
  await capture(plainDir, '2026-10-14')
  const dir = tmpArchiveDir()
  const { lines } = await capture(dir, '2026-10-14', { splitTail: tail => ({ head: '', body: tail }) })
  assert.deepStrictEqual(lines, [
    `{"run_utc":"2026-10-14T02:07:00.000Z",${PAGE.replace('"heading_split":false', '"heading_split":true')},"outcome":"written","shabad_ids":["DWV"],"confidence":"high"}`,
  ])
  assert.strictEqual(read(dir, '2026', '10', '14.json'), read(plainDir, '2026', '10', '14.json'))
  assert.ok(!read(dir, 'latest.json').includes('heading_split'))
})
check('unchanged: a re-run on the same input gives identical bytes', async () => {
  const dir = tmpArchiveDir()
  await capture(dir, '2026-10-14')
  const day1 = read(dir, '2026', '10', '14.json')
  const latest1 = read(dir, 'latest.json')
  const { code, lines } = await capture(dir, '2026-10-14')
  assert.strictEqual(code, 0)
  assert.deepStrictEqual(lines, [
    `{"run_utc":"2026-10-14T02:07:00.000Z",${PAGE},"outcome":"unchanged","shabad_ids":["DWV"],"confidence":"high"}`,
  ])
  assert.strictEqual(read(dir, '2026', '10', '14.json'), day1)
  assert.strictEqual(read(dir, 'latest.json'), latest1)
})
check('replaced: previous_ids reported and both files overwritten identically', async () => {
  const dir = tmpArchiveDir()
  await capture(dir, '2026-10-14')
  const before = read(dir, '2026', '10', '14.json')
  const { code, lines } = await capture(dir, '2026-10-14', { result: OTHER_RESULT })
  assert.strictEqual(code, 0)
  assert.deepStrictEqual(lines, [
    `{"run_utc":"2026-10-14T02:07:00.000Z",${PAGE},"outcome":"replaced","shabad_ids":["XYZ"],"confidence":"high","previous_ids":["DWV"]}`,
  ])
  const dated = read(dir, '2026', '10', '14.json')
  assert.notStrictEqual(dated, before)
  assert.deepStrictEqual(JSON.parse(dated).shabad_ids, [ 'XYZ' ])
  assert.strictEqual(read(dir, 'latest.json'), dated)
})
check('not_yet (no page yet): exact line, exit 0, and exit 1 on FINAL_RUN=1', async () => {
  const dir = tmpArchiveDir()
  const expected = `{"run_utc":"2026-10-14T02:07:00.000Z",${NO_PAGE},"outcome":"not_yet","shabad_ids":null,"confidence":null}`
  const a = await capture(dir, '2026-10-15')
  assert.strictEqual(a.code, 0)
  assert.deepStrictEqual(a.lines, [ expected ])
  const b = await capture(dir, '2026-10-15', { env: { FINAL_RUN: '1' } })
  assert.strictEqual(b.code, 1)
  assert.deepStrictEqual(b.lines, [ expected ])
  assert.deepStrictEqual(listFiles(dir), [])
})
check('not_yet on a real 404 too', async () => {
  const dir = tmpArchiveDir()
  const { code, lines } = await capture(dir, '2026-10-15', { fetchPage: async () => ({ status: 404, body: Buffer.from('') }) })
  assert.strictEqual(code, 0)
  assert.strictEqual(JSON.parse(lines[0]).outcome, 'not_yet')
  assert.deepStrictEqual(listFiles(dir), [])
})
check('refused (yesterday\'s page at today\'s URL): DateMismatchError, writes nothing', async () => {
  const dir = tmpArchiveDir()
  const { error, lines } = await capture(dir, '2026-10-15', { fetchPage: async () => ok(MORNING), env: { FINAL_RUN: '1' } })
  assert.strictEqual(error.name, 'DateMismatchError')
  assert.deepStrictEqual(lines, [
    `{"run_utc":"2026-10-14T02:07:00.000Z",${NO_PAGE},"outcome":"refused","shabad_ids":null,"confidence":null,` +
    '"reason":"date_mismatch: requested 2026-10-15, got 2026-10-14"}',
  ])
  assert.deepStrictEqual(listFiles(dir), [])
})
check('refused (wrong session): WrongSessionError, writes nothing', async () => {
  const dir = tmpArchiveDir()
  const { error, lines } = await capture(dir, '2026-10-17', { fetchPage: async () => ok(SANGRAND) })
  assert.strictEqual(error.name, 'WrongSessionError')
  const line = JSON.parse(lines[0])
  assert.strictEqual(line.outcome, 'refused')
  assert.match(line.reason, /^wrong_session: category sangrand/)
  assert.deepStrictEqual(listFiles(dir), [])
})
check('refused on a low resolution: exact line, rethrows, writes nothing', async () => {
  const dir = tmpArchiveDir()
  const { error, lines } = await capture(dir, '2026-10-14', { result: FAILED_RESULT })
  assert.match(error.message, /sggs_unresolved/)
  assert.deepStrictEqual(lines, [
    `{"run_utc":"2026-10-14T02:07:00.000Z",${PAGE},"outcome":"refused","shabad_ids":[],"confidence":"low","reason":"sggs_unresolved: low"}`,
  ])
  assert.deepStrictEqual(listFiles(dir), [])
})
check('refused on a layout change: exact line, rethrows, writes nothing', async () => {
  const dir = tmpArchiveDir()
  const { error, lines } = await capture(dir, '2026-10-14', { fetchPage: async () => ok('<html></html>') })
  assert.strictEqual(error.name, 'LayoutChangedError')
  assert.deepStrictEqual(lines, [
    `{"run_utc":"2026-10-14T02:07:00.000Z",${NO_PAGE},"outcome":"refused","shabad_ids":null,"confidence":null,"reason":"layout_changed: empty response"}`,
  ])
  assert.deepStrictEqual(listFiles(dir), [])
})
check('refused on HTTP 403: exact reason, writes nothing', async () => {
  const dir = tmpArchiveDir()
  const { error, lines } = await capture(dir, '2026-10-14', { fetchPage: async () => ({ status: 403, body: Buffer.from('') }) })
  assert.strictEqual(error.name, 'HttpError')
  assert.strictEqual(JSON.parse(lines[0]).reason, 'http_403: https://hukamnamasahib.com/hukamnama/2026-10-14-morning')
  assert.deepStrictEqual(listFiles(dir), [])
})
check('the same line is appended to GITHUB_STEP_SUMMARY when set', async () => {
  const dir = tmpArchiveDir()
  const summary = path.join(tmpArchiveDir(), 'summary.md')
  fs.writeFileSync(summary, '# earlier step\n')
  const a = await capture(dir, '2026-10-15', { env: { GITHUB_STEP_SUMMARY: summary } })
  const b = await capture(dir, '2026-10-14', { env: { GITHUB_STEP_SUMMARY: summary } })
  assert.strictEqual(read(summary), `# earlier step\n${a.lines[0]}\n${b.lines[0]}\n`)
  assert.ok(!listFiles(dir).some(f => f.includes('summary')))
})
check('no summary file is created when GITHUB_STEP_SUMMARY is unset', async () => {
  const dir = tmpArchiveDir()
  await capture(dir, '2026-10-14')
  assert.deepStrictEqual(listFiles(dir).sort(), [ path.join('2026', '10', '14.json'), 'latest.json' ])
})

;(async () => {
  for (const step of queue) await step()
  console.log(failures ? `\n${failures} FAILED` : '\nall passed')
  process.exit(failures ? 1 : 0)
})()
