'use strict'

/**
 * Every gate check must fail on a planted case in a throwaway repo and pass
 * on a clean one. The real repository is checked by `npm run gate` instead.
 */

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const { runChecks, CHECKS, ARCHIVE_NOTE } = require('../bin/gate')

let failures = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`) }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`) }
}

const [ ARCHIVE, IGNORED, GURMUKHI, FIXTURES, ATTRIBUTION, BODIES, SCHEMA, DAILY ] = CHECKS.map(c => c.name)
const DAILY_YML = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'daily.yml'), 'utf8')
// Assembled at runtime so this file never matches the attribution check itself.
const PLANTED_WORD = 'Cl' + 'aude'
const PLANTED_TRAILER = 'Co-' + 'Authored-By: someone <a@b.c>'

const README = [
  '# Test archive',
  'The ang label reads ਅੰਗ and a counter looks like ॥੧੪੭੨॥.',
  'A two-word example: `ਗੁਰਦੇਵ ਮਾਤਾ`.',
  '',
].join('\n')

const BASE = {
  'README.md': README,
  'validation/report.md': '# Validation report\n\nIds and numbers only.\n',
  'test/fixtures/day.json': '{"supported":true,"hukamnama":{"date":"2026-10-14","ang":"598","gheading1":"ਸੋਰਠਿ ਮਹਲਾ ੧ ॥"}}\n',
  'test/schema.test.js': 'process.exit(0)\n',
  '.github/workflows/daily.yml': DAILY_YML,
  'archive/.gitkeep': '',
}

function sh(cwd, args, env = {}) {
  return execFileSync('git', [ '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args ], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Tester', GIT_AUTHOR_EMAIL: 'tester@example.com',
      GIT_COMMITTER_NAME: 'Tester', GIT_COMMITTER_EMAIL: 'tester@example.com',
      ...env,
    },
  })
}

function write(root, files) {
  for (const [ rel, content ] of Object.entries(files)) {
    const file = path.join(root, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
}

/** A repo holding BASE in one commit with a body, plus a planted commit when a plant is given. */
function makeRepo(plant) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-test-'))
  sh(root, [ 'init', '-q', '-b', 'main' ])
  write(root, BASE)
  sh(root, [ 'add', '-A' ])
  sh(root, [ 'commit', '-q', '-m', 'chore: base', '-m', 'Clean starting point.' ])
  if (plant) {
    const { files = {}, subject = 'chore: plant', body = 'Planted for the gate test.', author } = plant
    write(root, files)
    sh(root, [ 'add', '-A' ])
    const msg = body ? [ '-m', subject, '-m', body ] : [ '-m', subject ]
    sh(root, [ 'commit', '-q', '--allow-empty', ...msg ], author ? { GIT_AUTHOR_NAME: author } : {})
  }
  return root
}

const resultsFor = root => Object.fromEntries(runChecks(root).map(r => [ r.name, r ]))

/** The named check fails and every other check still passes. */
function failsOnly(name, plant) {
  const results = resultsFor(makeRepo(plant))
  assert.strictEqual(results[name].ok, false, `${name} should fail`)
  for (const r of Object.values(results)) {
    if (r.name !== name) assert.ok(r.ok, `${r.name} should pass but said ${r.detail}`)
  }
  return results[name]
}

function allPass(plant) {
  for (const r of Object.values(resultsFor(makeRepo(plant)))) assert.ok(r.ok, `${r.name}: ${r.detail}`)
}

console.log('clean repo')
check('a clean repo passes every check', () => allPass())
check('a bot commit without a body passes', () => allPass({ subject: 'chore(archive): 2026-10-14', body: '', author: 'hukamnama-bot' }))
check('short Gurmukhi labels, counters and a two-word example pass in the README', () =>
  allPass({ files: { 'README.md': README + 'Five words: ਹਰਿ ਹਰਿ ਨਾਮੁ ਭਜਿਓ ਪੁਰਖੋਤਮੁ\n' } }))
check('a Latin run of exactly 40 chars passes', () =>
  allPass({ files: { 'test/fixtures/note.json': `{"note":"${'a'.repeat(40)}"}\n` } }))
check('dandas in a fixture pass', () =>
  allPass({ files: { 'test/fixtures/day.json': '{"bani":"ਸੋਰਠਿ ਮਹਲਾ ੧ ॥ ਰਹਾਉ । ॥੧॥"}\n' } }))
check('the allowlisted hukamnamasahib.com titles pass', () => allPass({ files: { 'test/fixtures/hns.html': [
  '<title>Amrit Vele Da Hukamnama Sri Darbar Sahib, Amritsar, Date 14-10-2026 Ang 598 | Hukamnama Sahib</title>',
  '<p>Sandhiya Vele Da Hukamnama Sri Darbar Sahib, Amritsar, Date 16-10-2026 Ang 643</p>',
  '<p>Sangrand Hukamnama Sri Darbar Sahib, Amritsar : Mahina Katak (October 2026)</p>',
  '',
].join('\n') } }))

console.log('\nplanted failures')
check('archive: a dated file fails with the first-push note', () => {
  const r = failsOnly(ARCHIVE, { files: { 'archive/2026/10/14.json': '{}\n' } })
  assert.ok(r.detail.includes(ARCHIVE_NOTE), r.detail)
})
check('archive: latest.json fails', () => failsOnly(ARCHIVE, { files: { 'archive/latest.json': '{}\n' } }))
check('archive: an untracked dated file still fails', () => {
  const root = makeRepo()
  write(root, { 'archive/2026/10/15.json': '{}\n' })
  assert.strictEqual(resultsFor(root)[ARCHIVE].ok, false)
})
check('ignored: a tracked cache file fails', () => failsOnly(IGNORED, { files: { 'cache/index.html': 'x\n' } }))
check('ignored: a tracked poll-log.txt fails', () => failsOnly(IGNORED, { files: { 'poll-log.txt': 'x\n' } }))
check('ignored: a tracked validation/results.jsonl fails', () =>
  failsOnly(IGNORED, { files: { 'validation/results.jsonl': '{}\n' } }))
check('gurmukhi: a single Gurmukhi word in the report fails', () =>
  failsOnly(GURMUKHI, { files: { 'validation/report.md': '# Report\n\nThe label ਅੰਗ\n' } }))
check('gurmukhi: a 6-word Gurmukhi line in the README fails', () =>
  failsOnly(GURMUKHI, { files: { 'README.md': README + 'ਹਰਿ ਹਰਿ ਨਾਮੁ ਭਜਿਓ ਪੁਰਖੋਤਮੁ ਸਭਿ\n' } }))
check('gurmukhi: six words split by a danda still fail', () =>
  failsOnly(GURMUKHI, { files: { 'README.md': README + 'ਹਰਿ ਹਰਿ ਨਾਮੁ ॥ ਭਜਿਓ ਪੁਰਖੋਤਮੁ ਸਭਿ\n' } }))
check('fixtures: an eheading key fails', () =>
  failsOnly(FIXTURES, { files: { 'test/fixtures/day.json': '{"eheading1":"x"}\n' } }))
check('fixtures: an efooter key fails', () =>
  failsOnly(FIXTURES, { files: { 'test/fixtures/day.json': '{"efooter2":"(Page: 1)"}\n' } }))
check('fixtures: an ehukamnama key fails', () =>
  failsOnly(FIXTURES, { files: { 'test/fixtures/day.json': '{"ehukamnama":"x"}\n' } }))
check('fixtures: a desc key fails', () =>
  failsOnly(FIXTURES, { files: { 'test/fixtures/day.json': '{"pdesc":"x"}\n' } }))
check('fixtures: an english key fails', () =>
  failsOnly(FIXTURES, { files: { 'test/fixtures.json': '{"English":"x"}\n' } }))
check('fixtures: a key inside embedded JSON in HTML fails', () =>
  failsOnly(FIXTURES, { files: { 'test/fixtures/index.html': '<script>{"date":"x","efooter1":"y"}</script>\n' } }))
check('fixtures: a Latin run of 41 chars fails', () =>
  failsOnly(FIXTURES, { files: { 'test/fixtures/note.json': `{"note":"${'a'.repeat(41)}"}\n` } }))
check('fixtures: an English sentence fails', () =>
  failsOnly(FIXTURES, { files: { 'test/fixtures/day.json': '{"x":"Listen, my mind, to the Name of the Lord and be at peace."}\n' } }))
check('fixtures: a Devanagari letter fails', () =>
  failsOnly(FIXTURES, { files: { 'test/fixtures/day.json': '{"bani":"ਸੋਰਠਿ सोरठि ॥"}\n' } }))
check('fixtures: a Devanagari digit fails', () =>
  failsOnly(FIXTURES, { files: { 'test/fixtures/day.json': '{"ang":"५९८"}\n' } }))
check('fixtures: the Punjabi explanation marker fails', () =>
  failsOnly(FIXTURES, { files: { 'test/fixtures/day.html': '<p>ਅਰਥ: ਹੇ ਮਨ</p>\n' } }))
check('fixtures: a long Latin run after an allowlisted title fails', () =>
  failsOnly(FIXTURES, { files: { 'test/fixtures/hns.html':
    '<p>Amrit Vele Da Hukamnama Sri Darbar Sahib, Amritsar, and then the Lord is merciful to all His servants</p>\n' } }))
check('fixtures: a title outside the allowlist fails', () =>
  failsOnly(FIXTURES, { files: { 'test/fixtures/hns.html': '<p>Evening Hukamnama Sri Darbar Sahib, Amritsar today</p>\n' } }))
check('attribution: a tracked file mentioning it fails', () =>
  failsOnly(ATTRIBUTION, { files: { 'NOTES.md': `written with ${PLANTED_WORD}\n` } }))
check('attribution: a commit subject mentioning it fails', () =>
  failsOnly(ATTRIBUTION, { subject: `chore: ${PLANTED_WORD.toLowerCase()} helped` }))
check('attribution: a trailer in the body fails', () =>
  failsOnly(ATTRIBUTION, { body: `Planted.\n\n${PLANTED_TRAILER}` }))
check('bodies: a human commit without a body fails', () => failsOnly(BODIES, { body: '' }))
check('schema: a failing schema test fails', () =>
  failsOnly(SCHEMA, { files: { 'test/schema.test.js': 'process.exit(1)\n' } }))
check('daily: a missing cron fails', () =>
  failsOnly(DAILY, { files: { '.github/workflows/daily.yml': DAILY_YML.replace("    - cron: '43 2 * * *'\n", '') } }))
check('daily: an extra cron fails', () =>
  failsOnly(DAILY, { files: { '.github/workflows/daily.yml':
    DAILY_YML.replace("    - cron: '7 11 * * *'\n", "    - cron: '7 11 * * *'\n    - cron: '7 14 * * *'\n") } }))
check('daily: FINAL_RUN naming another run fails', () =>
  failsOnly(DAILY, { files: { '.github/workflows/daily.yml':
    DAILY_YML.replace("schedule == '7 11 * * *'", "schedule == '13 5 * * *'") } }))
check('daily: FINAL_RUN naming the last run twice fails', () =>
  failsOnly(DAILY, { files: { '.github/workflows/daily.yml':
    DAILY_YML.replace("schedule == '7 11 * * *'", "schedule == '7 11 * * *' || github.event.schedule == '7 11 * * *'") } }))
check('daily: a missing FINAL_RUN fails', () =>
  failsOnly(DAILY, { files: { '.github/workflows/daily.yml': DAILY_YML.replace(/^.*FINAL_RUN:.*\n/m, '') } }))

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
