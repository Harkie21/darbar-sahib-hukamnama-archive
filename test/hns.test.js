'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { Resolver, SOURCE_SGGS, canon, dice } = require('../lib/resolve')
const { parseArchiveForDate } = require('../lib/scrape')
const {
  parseMorning, parseMorningForDate, parseMorningResponse, headingSplitter,
  WrongSessionError, AngMismatchError, LayoutChangedError, NoHukamnamaError, DateMismatchError, HttpError,
} = require('../lib/hns')

let failures = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`) }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`) }
}
const throwsKind = (fn, Kind) => assert.throws(fn, e => e instanceof Kind, `expected ${Kind.name}`)

// Real hukamnamasahib.com pages cut down by bin/trim-hns-fixture.js: page data,
// the main reading's bani and one bani line per related post.
const FIX = path.join(__dirname, 'fixtures')
const read = f => fs.readFileSync(path.join(FIX, f), 'utf8')
const P1014 = read('hns-2026-10-14-morning.html')
const P1007 = read('hns-2026-10-07-morning.html')
const P0623 = read('hns-2026-06-23-morning.html')
const P0803 = read('hns-2026-08-03-morning.html')
const SANGRAND = read('hns-2026-10-17-sangrand.html')
const NOT_FOUND = read('hns-2026-10-18-notfound.html')
const sgpc = date => parseArchiveForDate(read(`archive-${date}.json`), date)

/** The single flight chunk of a fixture, and a way to put an edited one back. */
const PUSH = /<script>self\.__next_f\.push\(([\s\S]*?)\)<\/script>/
const flightOf = html => JSON.parse(html.match(PUSH)[1])[1]
const withFlight = (html, flight) =>
  html.replace(PUSH, () => `<script>self.__next_f.push(${JSON.stringify([ 1, flight ]).replace(/</g, '\\u003c')})</script>`)
const textRow = (id, text) => `${id}:T${Buffer.byteLength(text, 'utf8').toString(16)},${text}`
const CONTAINER = /(<div class="hukamnama-html-content">\n)([\s\S]*?)(\n<\/div><\/div>)/
const mainHtmlOf = html => html.match(CONTAINER)[2]

/** Replaces the main reading in both the page data row and the rendered container. */
function withMain(html, mainHtml, { dom = mainHtml } = {}) {
  const flight = flightOf(html)
  const old = mainHtmlOf(html)
  const next = flight.replace(textRow('a1', old), textRow('a1', mainHtml))
  if (mainHtml !== old) assert.notStrictEqual(next, flight, 'main row not found in fixture')
  return withFlight(html, next).replace(CONTAINER, (_, a, __, c) => `${a}${dom}${c}`)
}
const sub = (s, from, to) => {
  assert.ok(s.includes(from), `fixture lacks ${JSON.stringify(from)}`)
  return s.split(from).join(to)
}
const subFlight = (html, from, to) => withFlight(html, sub(flightOf(html), from, to))

console.log('main reading')
check('10-14: heading and bani each equal SGPC canonically', () => {
  const r = parseMorningForDate(P1014, '2026-10-14')
  const s = sgpc('2026-10-14')
  assert.strictEqual(canon(r.heading), canon(s.heading))
  assert.strictEqual(canon(r.bani), canon(s.bani))
  assert.deepStrictEqual([ r.date, r.time, r.session, r.ang ], [ '2026-10-14', null, 'morning', 598 ])
  assert.strictEqual(r.raw_marker, 'Amrit Vele Da Hukamnama')
  assert.ok(Object.values(r.ang_sources).every(v => v === 598), JSON.stringify(r.ang_sources))
})
check('10-07: heading equal; bani differs only by two vowel signs in swapped order', () => {
  const r = parseMorningForDate(P1007, '2026-10-07')
  const s = sgpc('2026-10-07')
  assert.strictEqual(canon(r.heading), canon(s.heading))
  const a = canon(r.bani), b = canon(s.bani)
  assert.strictEqual(a.length, b.length)
  const diff = [ ...a ].map((ch, i) => (ch === b[i] ? null : i)).filter(i => i !== null)
  assert.strictEqual(diff.length, 2)
  assert.strictEqual(diff[1], diff[0] + 1)
  assert.strictEqual(a[diff[0]], b[diff[1]])
  assert.strictEqual(a[diff[1]], b[diff[0]])
  assert.ok(dice(a, b) > 0.97)
})
check('page times come from the page data', () => {
  const r = parseMorning(P1014)
  assert.strictEqual(r.page_modified_utc, '2026-10-13T23:53:49.000Z')
  assert.strictEqual(r.page_created_utc, null)
})
check('"More Hukamnamas" lines never reach the bani', () => {
  const r = parseMorning(P1014)
  const related = [ ...P1014.matchAll(/<li><a href="\/hukamnama\/([^"]+)"><span>([^<]*)<\/span>/g) ]
  assert.strictEqual(related.length, 4)
  for (const [ , slug, line ] of related) {
    assert.ok(!canon(r.bani).includes(canon(line)), `related ${slug} leaked into the bani`)
  }
})
check('a related post shaped like the main reading makes the page ambiguous', () => {
  throwsKind(() => parseMorning(subFlight(P1014, '"payload":{"contentHtml":"$b1"', '"data":{"contentHtml":"$b1"},"relatedPosts":[],"slug":"x","payload":{"contentHtml":"$b1"')),
    LayoutChangedError)
})
check('explanation, Devanagari, English and footer blocks are excluded', () => {
  const main = mainHtmlOf(P1014)
  const extra = [
    '<p>ਸੋਰਠਿ ਮਹਲਾ ੧ ॥ ਹੇ ਮਨ! ਟਿਕਿਆ ਰਹੁ।੧।</p>',
    '<p>ਅਰਥ: ਹੇ ਮੇਰੇ ਮਨ ਟਿਕਿਆ ਰਹੁ</p>',
    '<p>सोरठि महला १ ॥</p>',
    '<p>SORATH, FIRST MEHL:</p>',
    '<p style="text-align:center">www.facebook.com/x<br />ਵਾਹਿਗੁਰੂ ਜੀ ਕਾ ਖਾਲਸਾ !!</p>',
  ].join('\n')
  const r = parseMorning(withMain(P1014, `${main}\n${extra}`))
  assert.strictEqual(canon(r.bani), canon(parseMorning(P1014).bani))
})
check('consecutive bani blocks are joined in order', () => {
  const r0 = parseMorning(P1014)
  const k = r0.bani.indexOf('॥੧॥') + 3
  const two = `<p>${r0.heading} ${r0.bani.slice(0, k)}</p>\n<p>${r0.bani.slice(k)}</p>`
  assert.strictEqual(canon(parseMorning(withMain(P1014, two)).bani), canon(r0.bani))
})
check('a leading <strong> is the heading', () => {
  const r0 = parseMorning(P1014)
  const r = parseMorning(withMain(P1014, `<p><strong>${r0.heading}</strong> ${r0.bani}</p>`))
  assert.strictEqual(canon(r.heading), canon(r0.heading))
  assert.strictEqual(canon(r.bani), canon(r0.bani))
})
check('a <strong> around the whole block is not a heading', () => {
  const r0 = parseMorning(P1014)
  const r = parseMorning(withMain(P1014, `<p><strong>${r0.heading} ${r0.bani}</strong></p>`))
  assert.strictEqual(canon(r.heading), canon(r0.heading))
  assert.strictEqual(canon(r.bani), canon(r0.bani))
})
check('older posts: a Latin title preamble is skipped and its ang and date are checked', () => {
  const main = mainHtmlOf(P1014)
  const pre = '<hr>\n<h4>Amrit Vele da Hukamnama Sri Darbar Sahib Amritsar</h4>\n<h4>Date 14-10-2026 Ang-598</h4>\n<hr>\n'
  const r = parseMorning(withMain(P1014, pre + main))
  assert.strictEqual(r.ang_sources.content_title, 598)
  assert.strictEqual(canon(r.bani), canon(parseMorning(P1014).bani))
  throwsKind(() => parseMorning(withMain(P1014, pre.replace('Ang-598', 'Ang-597') + main)), AngMismatchError)
  throwsKind(() => parseMorning(withMain(P1014, pre.replace('14-10-2026', '13-10-2026') + main)), LayoutChangedError)
})
check('an ang range agrees when it contains the cited ang', () => {
  const main = mainHtmlOf(P1014)
  const r = parseMorning(withMain(P1014, `<h4>ANG 597-598 , 14-10-2026</h4>\n${main}`))
  assert.strictEqual(r.ang, 598)
  assert.strictEqual(r.ang_sources.content_title, '597-598')
  throwsKind(() => parseMorning(withMain(P1014, `<h4>ANG 599-600</h4>\n${main}`)), AngMismatchError)
})
check('a Devanagari anusvara typed for the Gurmukhi bindi stays in the bani block', () => {
  const main = mainHtmlOf(P1014)
  const k = main.indexOf('ਅੰ')
  assert.ok(k > 0)
  const typo = main.slice(0, k + 1) + '\u0902' + main.slice(k + 2)
  const r = parseMorning(withMain(P1014, typo))
  assert.ok(r.bani.includes('\u0902'))
  assert.strictEqual(canon(r.bani).length, canon(parseMorning(P1014).bani).length)
})

console.log('\nheading split')
const DB_PATH = process.env.SHABADOS_DB || 'node_modules/@shabados/database/build/database.sqlite'
const R = new Resolver(DB_PATH)
const splitTail = headingSplitter(R)
const lineIds = page => R.resolve(page.heading, page.bani, SOURCE_SGGS, { ang: page.ang }).line_ids
// SGPC's resolution of the same days, from validation/hns-crosscheck.md.
const SGPC_0623 = [ 'V6LP', 'T6LA', '5Y9J', 'A9QN', 'U9UP', 'NKWM', 'Q9SQ', 'CH18', 'KQX2', 'ELVM', '8A4E', 'MVLM',
  '1VZS', 'WPSX', 'UVR4', 'GVMZ', '40A5', 'DJ1N' ]
const SGPC_0803 = [ 'TZ03', 'VXWY', 'KVQ5', '03YK', 'DSR5', 'CWLR', 'BMZ5', 'T5V1', 'R987', 'PZN5', 'DS9F', 'F1SX',
  '7RV9', '9PT2', 'A717', 'PFLT', '7WNG', 'MAU0', 'F7VY', 'JRPM' ]
check('06-23: a mangal alone does not end the heading; the title line after it joins it', () => {
  const r = parseMorningForDate(P0623, '2026-06-23', { splitTail })
  assert.strictEqual(r.heading.split('॥').filter(s => s.trim()).length, 2)
  assert.ok(r.heading.startsWith('ੴ'))
  assert.strictEqual(canon(r.heading).length, 23)
  assert.strictEqual(r.heading_split, false)
  assert.deepStrictEqual(lineIds(r), SGPC_0623)
})
check('a mangal put in front of any danda heading joins that heading', () => {
  const r0 = parseMorning(P1014)
  const r = parseMorning(withMain(P1014, `<p>ੴ ਸਤਿਗੁਰ ਪ੍ਰਸਾਦਿ ॥ ${r0.heading} ${r0.bani}</p>`))
  assert.strictEqual(canon(r.heading), canon(r0.heading))
  assert.strictEqual(r.bani, r0.bani)
})
check('08-03: a heading run into the first line without a danda is split back off', () => {
  const r = parseMorningForDate(P0803, '2026-08-03', { splitTail })
  assert.strictEqual(r.heading_split, true)
  assert.strictEqual(canon(r.heading), canon('ਸਲੋਕੁ ਮਃ'))
  const ids = lineIds(r)
  assert.deepStrictEqual(ids, SGPC_0803.slice(0, ids.length))
  assert.strictEqual(ids[0], 'TZ03')
})
check('08-03 without the split loses the opening line', () => {
  const r = parseMorningForDate(P0803, '2026-08-03')
  assert.strictEqual(r.heading_split, false)
  assert.strictEqual(lineIds(r)[0], SGPC_0803[1])
})
check('the split never fires on a real heading', () => {
  for (const [ page, date ] of [ [ P1014, '2026-10-14' ], [ P1007, '2026-10-07' ], [ P0623, '2026-06-23' ] ]) {
    const plain = parseMorningForDate(page, date)
    const r = parseMorningForDate(page, date, { splitTail })
    assert.strictEqual(r.heading_split, false, date)
    assert.deepStrictEqual([ r.heading, r.bani ], [ plain.heading, plain.bani ], date)
  }
})

console.log('\nsession and date')
check('the sangrand page is WrongSessionError', () => throwsKind(() => parseMorning(SANGRAND), WrongSessionError))
check('a morning slug with an evening category is WrongSessionError', () =>
  throwsKind(() => parseMorning(subFlight(P1014, '"category":"morning","slug":"2026-10-14-morning"', '"category":"evening","slug":"2026-10-14-morning"')), WrongSessionError))
check('a morning page with a non-morning title is WrongSessionError', () =>
  throwsKind(() => parseMorning(subFlight(P1014, '"title":"Amrit Vele Da Hukamnama Sri Darbar Sahib, Amritsar, Date 14-10-2026', '"title":"Sandhiya Vele Da Hukamnama Sri Darbar Sahib, Amritsar, Date 14-10-2026')), WrongSessionError))
check('a page for another date is DateMismatchError', () =>
  throwsKind(() => parseMorningForDate(P1014, '2026-10-15'), DateMismatchError))
check('page dates that disagree are a layout change', () =>
  throwsKind(() => parseMorning(subFlight(P1014, '"date":"Wednesday, 14 October 2026"', '"date":"Tuesday, 13 October 2026"')), LayoutChangedError))

console.log('\nang')
check('payload ang disagreeing with the title is AngMismatchError', () =>
  throwsKind(() => parseMorning(subFlight(P1014, '"ang":598', '"ang":599')), AngMismatchError))
check('an h1 ang disagreeing is AngMismatchError', () =>
  throwsKind(() => parseMorning(sub(P1014, '<h1>Amrit Vele Da Hukamnama Sri Darbar Sahib, Amritsar, Date 14-10-2026 Ang 598</h1>',
    '<h1>Amrit Vele Da Hukamnama Sri Darbar Sahib, Amritsar, Date 14-10-2026 Ang 597</h1>')), AngMismatchError))
check('an ang label without a number is a layout change', () =>
  throwsKind(() => parseMorning(sub(P1014, '<h1>Amrit Vele Da Hukamnama Sri Darbar Sahib, Amritsar, Date 14-10-2026 Ang 598</h1>',
    '<h1>Amrit Vele Da Hukamnama Sri Darbar Sahib, Amritsar, Date 14-10-2026 Ang ?</h1>')), LayoutChangedError))

console.log('\nno page')
check('the site\'s not-found page is NoHukamnamaError', () => throwsKind(() => parseMorning(NOT_FOUND), NoHukamnamaError))
check('a real 404 is NoHukamnamaError', () =>
  throwsKind(() => parseMorningResponse({ status: 404, body: Buffer.from('') }, '2026-10-18'), NoHukamnamaError))
check('any other non-200 is HttpError', () => {
  throwsKind(() => parseMorningResponse({ status: 403, body: Buffer.from('') }, '2026-10-18'), HttpError)
  throwsKind(() => parseMorningResponse({ status: 500, body: Buffer.from('') }, '2026-10-18'), HttpError)
})
check('a 200 not-found body through parseMorningResponse is NoHukamnamaError', () =>
  throwsKind(() => parseMorningResponse({ status: 200, body: Buffer.from(NOT_FOUND) }, '2026-10-18'), NoHukamnamaError))
check('a post with no reading text yet is NoHukamnamaError, or DateMismatchError for another date', () => {
  const textless = subFlight(P1014, '"contentHtml":"$a1",', '').replace(CONTAINER, (_, a, __, c) => `${a}being updated${c}`)
  throwsKind(() => parseMorningForDate(textless, '2026-10-14'), NoHukamnamaError)
  throwsKind(() => parseMorningForDate(textless, '2026-10-15'), DateMismatchError)
})

console.log('\nlayout changes')
check('no content container is a layout change', () =>
  throwsKind(() => parseMorning(sub(P1014, 'class="hukamnama-html-content"', 'class="other"')), LayoutChangedError))
check('two content containers are a layout change', () =>
  throwsKind(() => parseMorning(sub(P1014, '<aside>', '<div class="hukamnama-html-content"></div><aside>')), LayoutChangedError))
check('rendered reading differing from the page data is a layout change', () => {
  const main = mainHtmlOf(P1014)
  throwsKind(() => parseMorning(withMain(P1014, main, { dom: main.replace('॥', '॥ ਵਾਧੂ') })), LayoutChangedError)
})
check('no main reading in the page data is a layout change', () =>
  throwsKind(() => parseMorning(subFlight(P1014, '"relatedPosts":', '"otherPosts":')), LayoutChangedError))
check('no Gurmukhi block in the content is a layout change', () =>
  throwsKind(() => parseMorning(withMain(P1014, '<p>SORATH, FIRST MEHL:</p>')), LayoutChangedError))
check('an empty response is a layout change', () => throwsKind(() => parseMorning(''), LayoutChangedError))

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
