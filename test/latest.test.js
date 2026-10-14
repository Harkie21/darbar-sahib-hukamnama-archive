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

// The real 2026-10-14 page; run() is given stubs so no request ever leaves.
const INDEX = fs.readFileSync(path.join(__dirname, 'fixtures', 'index-2026-10-14.html'), 'utf8')
const stubRun = (dir, today, env = {}, result = OK_RESULT) => run({
  fetchHtml: async () => Buffer.from(INDEX),
  today: () => today,
  env,
  archiveDir: dir,
  makeResolver: () => ({ resolve: () => result }),
  corpusVersion: '4.8.7',
  log: () => {},
})

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

check('a page showing today writes the day and latest.json', async () => {
  const dir = tmpArchiveDir()
  assert.strictEqual(await stubRun(dir, '2026-10-14'), 0)
  assert.deepStrictEqual(listFiles(dir).sort(), [ path.join('2026', '10', '14.json'), 'latest.json' ])
})
check('a stale page date writes nothing', async () => {
  const dir = tmpArchiveDir()
  await stubRun(dir, '2026-10-15')
  await stubRun(dir, '2026-10-15', { FINAL_RUN: '1' })
  assert.deepStrictEqual(listFiles(dir), [])
})
check('a stale page exits 0 unless FINAL_RUN=1', async () => {
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

;(async () => {
  for (const step of queue) await step()
  console.log(failures ? `\n${failures} FAILED` : '\nall passed')
  process.exit(failures ? 1 : 0)
})()
