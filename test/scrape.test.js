'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const {
  parseLatest, parseArchive, parseArchiveForDate, parseTimestamp,
  LayoutChangedError, NoHukamnamaError, AngMismatchError, DateMismatchError,
} = require('../lib/scrape')

let failures = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`) }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`) }
}

// Real hs.sgpc.net/index.php from 2026-10-14 with the translation bodies removed.
const FIX = path.join(__dirname, 'fixtures')
const INDEX = fs.readFileSync(path.join(FIX, 'index-2026-10-14.html'), 'utf8')
const ARCHIVE = fs.readFileSync(path.join(FIX, 'archive-2026-10-14.json'), 'utf8')
const NODATA = fs.readFileSync(path.join(FIX, 'archive-2026-10-15-nodata.json'), 'utf8')

const G_ANG = '(ਅੰਗ : ੫੯੮)'
const E_ANG = '(Page: 598) '
// The archive fixtures carry no English fields, so tests that need the English footer add it here.
const withEnglishFooter = (raw, footer) => {
  const data = JSON.parse(raw)
  data.hukamnama.efooter2 = footer
  return JSON.stringify(data)
}
const sub = (html, from, to) => {
  assert.ok(html.includes(from), `fixture lacks ${JSON.stringify(from)}`)
  return html.split(from).join(to)
}
const throwsKind = (fn, Kind) => assert.throws(fn, e => e instanceof Kind, `expected ${Kind.name}`)

console.log('timestamp')
check('date with the time suffix and its double space', () => {
  assert.deepStrictEqual(parseTimestamp('14-10-2026  05:15 AM'), { date: '2026-10-14', time: '05:15' })
})
check('date without the time suffix', () => {
  assert.deepStrictEqual(parseTimestamp(' 14-10-2026 '), { date: '2026-10-14', time: null })
})
check('12-hour clock converts to 24-hour', () => {
  assert.strictEqual(parseTimestamp('14-10-2026 12:05 AM').time, '00:05')
  assert.strictEqual(parseTimestamp('14-10-2026 12:05 PM').time, '12:05')
  assert.strictEqual(parseTimestamp('14-10-2026 07:40 PM').time, '19:40')
})
check('Gurmukhi digits in the timestamp', () => {
  assert.strictEqual(parseTimestamp('੧੪-੧੦-੨੦੨੬').date, '2026-10-14')
})
check('an impossible calendar date is a layout change', () => {
  throwsKind(() => parseTimestamp('31-02-2026 05:15 AM'), LayoutChangedError)
})
check('the real page parses with its time', () => {
  const r = parseLatest(INDEX)
  assert.strictEqual(r.date, '2026-10-14')
  assert.strictEqual(r.time, '05:15')
})
check('the real page parses with the time suffix removed', () => {
  const r = parseLatest(INDEX.replace(/14-10-2026\s+05:15 AM/, '14-10-2026'))
  assert.strictEqual(r.date, '2026-10-14')
  assert.strictEqual(r.time, null)
})

console.log('\nang')
check('both footers agree', () => {
  const r = parseLatest(INDEX)
  assert.deepStrictEqual([ r.ang, r.ang_ascii, r.ang_gurmukhi, r.ang_field ], [ 598, 598, 598, 598 ])
})
check('Gurmukhi ang alone', () => {
  const r = parseLatest(sub(INDEX, E_ANG, ''))
  assert.deepStrictEqual([ r.ang, r.ang_ascii, r.ang_gurmukhi ], [ 598, null, 598 ])
})
check('Devanagari ang alone', () => {
  const r = parseLatest(sub(sub(INDEX, E_ANG, ''), G_ANG, '(ਅੰਗ : ५९८)'))
  assert.strictEqual(r.ang, 598)
  assert.strictEqual(r.devanagari_digits, 3)
})
check('ASCII ang alone', () => {
  const r = parseLatest(sub(INDEX, G_ANG, ''))
  assert.deepStrictEqual([ r.ang, r.ang_ascii, r.ang_gurmukhi ], [ 598, 598, null ])
})
check('English label may read Ang rather than Page', () => {
  assert.strictEqual(parseLatest(sub(INDEX, E_ANG, '(Ang: 598)')).ang_ascii, 598)
})
check('zero-width and spaces inside the digit run', () => {
  assert.strictEqual(parseLatest(sub(INDEX, G_ANG, '(ਅੰਗ : ੫੯​੮)')).ang_gurmukhi, 598)
  assert.strictEqual(parseLatest(sub(INDEX, E_ANG, '(Page: 59 8)')).ang_ascii, 598)
})
check('no label at all gives null', () => {
  const r = parseLatest(sub(sub(INDEX, E_ANG, ''), G_ANG, ''))
  assert.strictEqual(r.ang, null)
})
check('a label whose number does not parse refuses the day', () => {
  throwsKind(() => parseLatest(sub(INDEX, G_ANG, '(ਅੰਗ : )')), LayoutChangedError)
  throwsKind(() => parseLatest(sub(INDEX, E_ANG, '(Page: ?)')), LayoutChangedError)
})
check('footers that disagree throw AngMismatchError', () => {
  throwsKind(() => parseLatest(sub(INDEX, E_ANG, '(Page: 599)')), AngMismatchError)
})
check('the Gurmukhi ang is read from the Gurmukhi card only', () => {
  const moved = sub(sub(INDEX, G_ANG, ''), '<h4 class="hukamnama-title">ਪੰਜਾਬੀ ਵਿਆਖਿਆ</h4>',
    `<h4 class="hukamnama-title">ਪੰਜਾਬੀ ਵਿਆਖਿਆ</h4><p class="customDate">${G_ANG}</p>`)
  assert.strictEqual(parseLatest(moved).ang_gurmukhi, null)
})

console.log('\npage shape')
check('empty bani is NoHukamnamaError', () => {
  const empty = INDEX.replace(/(<p class="hukamnama-text">)[^<]*(<\/p>)/, '$1$2')
  throwsKind(() => parseLatest(empty), NoHukamnamaError)
})
check('a second Gurmukhi card is a layout change', () => {
  throwsKind(() => parseLatest(sub(INDEX, '<div class="hukamnama-card mt-4">',
    '<div class="hukamnama-card"></div><div class="hukamnama-card mt-4">')), LayoutChangedError)
})
check('no Gurmukhi card is a layout change', () => {
  throwsKind(() => parseLatest(sub(INDEX, 'class="hukamnama-card mt-4"', 'class="other"')), LayoutChangedError)
})
check('an unreadable timestamp is a layout change', () => {
  throwsKind(() => parseLatest(INDEX.replace(/14-10-2026\s+05:15 AM/, 'Wednesday')), LayoutChangedError)
})
check('embedded data that disagrees with the rendered page is a layout change', () => {
  throwsKind(() => parseLatest(INDEX.replace('"date":"2026-10-14"', '"date":"2026-10-13"')), LayoutChangedError)
})
check('several bani blocks join in page order', () => {
  const whole = parseLatest(INDEX).bani
  const cut = whole.indexOf('॥੧॥') + 3
  const split = INDEX.replace(/<p class="hukamnama-text">[^<]*<\/p>/,
    `<p class="hukamnama-text">${whole.slice(0, cut)}</p><p class="hukamnama-text">${whole.slice(cut)}</p>`)
  const r = parseLatest(split)
  assert.strictEqual(r.bani, whole)
})

console.log('\narchive')
check('archive record parses to the same fields, without a time', () => {
  const a = parseArchive(withEnglishFooter(ARCHIVE, E_ANG))
  const l = parseLatest(INDEX)
  assert.strictEqual(a.date, '2026-10-14')
  assert.strictEqual(a.time, null)
  assert.strictEqual(a.bani, l.bani)
  assert.strictEqual(a.heading, l.heading)
  assert.deepStrictEqual([ a.ang, a.ang_ascii, a.ang_gurmukhi, a.ang_field ], [ 598, 598, 598, 598 ])
})
check('the stored archive fixture falls back to the Gurmukhi footer ang', () => {
  const a = parseArchive(ARCHIVE)
  assert.deepStrictEqual([ a.ang, a.ang_ascii, a.ang_gurmukhi ], [ 598, null, 598 ])
})
check('supported=false is NoHukamnamaError', () => {
  throwsKind(() => parseArchiveForDate(NODATA, '2026-10-15'), NoHukamnamaError)
})
check('an archive answer for another date is DateMismatchError', () => {
  throwsKind(() => parseArchiveForDate(ARCHIVE, '2026-10-13'), DateMismatchError)
  throwsKind(() => parseArchiveForDate(NODATA, '2026-10-16'), DateMismatchError)
})
check('archive garbage is a layout change', () => {
  throwsKind(() => parseArchive('<html>'), LayoutChangedError)
  throwsKind(() => parseArchive('{"hukamnama":{}}'), LayoutChangedError)
  throwsKind(() => parseArchive(ARCHIVE.replace('"date":"2026-10-14"', '"date":"14-10-2026"')), LayoutChangedError)
})
check('archive footers that disagree throw AngMismatchError', () => {
  throwsKind(() => parseArchive(withEnglishFooter(ARCHIVE, '(Page: 597)')), AngMismatchError)
})

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
