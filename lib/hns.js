'use strict'

/**
 * hukamnamasahib.com morning page: /hukamnama/YYYY-MM-DD-morning.
 * The site is Next.js; the main reading is read from the embedded page data and
 * cross-checked against the rendered content container, never from the
 * "More Hukamnamas" list, which carries other days' full text.
 */

const cheerio = require('cheerio')
const { parseNumeral, canon, bigrams, dicePre, THRESHOLDS, SOURCE_SGGS } = require('./resolve')
const {
  LayoutChangedError, NoHukamnamaError, DateMismatchError, HttpError, USER_AGENT,
} = require('./scrape')

const BASE_URL = 'https://hukamnamasahib.com'
const MIN_DELAY_MS = 3000
const NOT_FOUND_DIGEST = 'NEXT_HTTP_ERROR_FALLBACK;404'
const MORNING_TITLE = /^Amrit Vel[ae] Da Hukamnama\b/
const MONTHS = [ 'january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december' ]

/** The page is a real hukamnama, but not the morning one. */
class WrongSessionError extends Error {
  constructor(detail) {
    super(`wrong_session: ${detail}`)
    this.name = 'WrongSessionError'
  }
}

/** Two places on the page cite different angs. Neither can be trusted. */
class AngMismatchError extends Error {
  constructor(sources) {
    super(`ang_mismatch: ${Object.entries(sources).map(([ k, v ]) => `${k} ${v}`).join(' vs ')}`)
    this.name = 'AngMismatchError'
    this.sources = sources
  }
}

const norm = s => String(s ?? '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim()
const GURMUKHI_LETTER = /[\u0A01-\u0A65\u0A70-\u0A7F]/
// SGPC's bani holds only Gurmukhi and the double danda while the Punjabi explanation carries prose punctuation.
const BANI_CHARS = /^[\u0A00-\u0A7F\u0965\s:]+$/
// A Devanagari anusvara typed in place of the Gurmukhi bindi still belongs to the Gurmukhi word.
const STRAY_SIGN = /(?<=[\u0A00-\u0A7F])[\u0900-\u0903]/g

/** The Next.js flight string: every self.__next_f.push([1, "..."]) chunk in order. */
function flightOf($) {
  let flight = ''
  $('script:not([src])').each((_, el) => {
    const m = $(el).text().match(/^\s*self\.__next_f\.push\(([\s\S]*)\)\s*;?\s*$/)
    if (!m) return
    let chunk
    try { chunk = JSON.parse(m[1]) } catch (e) { return }
    if (Array.isArray(chunk) && chunk[0] === 1 && typeof chunk[1] === 'string') flight += chunk[1]
  })
  return flight
}

/**
 * Flight rows keyed by id. A text row is "id:T<hex byte length>,<text>" and
 * may contain newlines, so rows are cut by byte count, not by line.
 */
function rowsOf(flight) {
  const buf = Buffer.from(flight, 'utf8')
  const rows = new Map()
  let i = 0
  while (i < buf.length) {
    const colon = buf.indexOf(0x3a, i)
    if (colon < 0) break
    const id = buf.subarray(i, colon).toString()
    if (buf[colon + 1] === 0x54) {
      const comma = buf.indexOf(0x2c, colon)
      const len = parseInt(buf.subarray(colon + 2, comma).toString(), 16)
      if (!/^[0-9a-f]+$/.test(id) || comma < 0 || !(len >= 0)) throw new LayoutChangedError(`unreadable text row at byte ${i}`)
      rows.set(id, { text: buf.subarray(comma + 1, comma + 1 + len).toString('utf8') })
      i = comma + 1 + len
    } else {
      const nl = buf.indexOf(0x0a, colon)
      const end = nl < 0 ? buf.length : nl
      rows.set(id, { json: buf.subarray(colon + 1, end).toString('utf8') })
      i = end + 1
    }
  }
  return rows
}

/** Every object in the page data that carries its own `data` payload next to `relatedPosts`. */
function findMainProps(rows) {
  const found = []
  const walk = v => {
    if (Array.isArray(v)) { v.forEach(walk); return }
    if (!v || typeof v !== 'object') return
    if (v.data && typeof v.data === 'object' && !Array.isArray(v.data) && 'relatedPosts' in v && 'slug' in v) found.push(v)
    for (const k of Object.keys(v)) walk(v[k])
  }
  for (const row of rows.values()) {
    if (row.json == null) continue
    let parsed
    try { parsed = JSON.parse(row.json) } catch (e) { continue }
    walk(parsed)
  }
  return found
}

/** Resolves a flight string value: "$1e" names a row, "$$x" is a literal "$x". */
function flightString(value, rows, what) {
  if (typeof value !== 'string') throw new LayoutChangedError(`${what} is not a string`)
  if (value.startsWith('$$')) return value.slice(1)
  if (/^\$[0-9a-f]+$/.test(value)) {
    const row = rows.get(value.slice(1))
    if (!row || row.text == null) throw new LayoutChangedError(`${what} points at missing row ${value}`)
    return row.text
  }
  if (value.startsWith('$')) throw new LayoutChangedError(`${what} is an unexpected reference ${value}`)
  return value
}

const blockText = ($, el) => {
  const $el = $(el).clone()
  $el.find('br').replaceWith(' ')
  return norm($el.text())
}

/**
 * The reading's blocks: the leading blocks made only of Gurmukhi and double
 * dandas. The Punjabi explanation, Devanagari and English all end the run.
 */
function readingBlocks(contentHtml) {
  const $ = cheerio.load(`<div id="root">${contentHtml}</div>`)
  const blocks = []
  // Older posts open with title lines in Latin script ahead of the reading.
  const preamble = []
  for (const el of $('#root').children().toArray()) {
    const text = blockText($, el)
    if (!text) continue
    if (!blocks.length && !GURMUKHI_LETTER.test(text)) { preamble.push(text); continue }
    if (text.startsWith('ਅਰਥ')) break
    if (!GURMUKHI_LETTER.test(text) || !BANI_CHARS.test(text.replace(STRAY_SIGN, ''))) break
    blocks.push({ el, text, $ })
  }
  return { blocks, preamble }
}

/**
 * Leading <strong> in the first block, else its opening segments up to the first double danda that ends more than a mangal.
 * splitTail may cut that last segment where the site left out the danda between heading and first line.
 */
function splitHeading(blocks, { splitTail } = {}) {
  const first = blocks[0]
  const $ = first.$
  const $el = $(first.el).clone()
  $el.find('br').replaceWith(' ')
  const lead = $el.contents().toArray().find(n => n.type !== 'text' || norm(n.data))
  let heading = ''
  let rest = first.text
  let headingSplit = false
  // Some days wrap the whole block in <strong> and then it marks no heading.
  if (lead && lead.type === 'tag' && lead.name === 'strong' && norm($(lead).text()) !== first.text) {
    heading = norm($(lead).text())
    $(lead).remove()
    rest = norm($el.text())
  } else {
    // A mangal alone is never the whole heading since the title line after it belongs to it too.
    let k = -1
    do k = first.text.indexOf('॥', k + 1)
    while (k >= 0 && !canon(first.text.slice(0, k + 1)) && first.text.indexOf('॥', k + 1) >= 0)
    if (k >= 0) {
      heading = norm(first.text.slice(0, k + 1))
      rest = norm(first.text.slice(k + 1))
      const j = first.text.lastIndexOf('॥', k - 1)
      const cut = splitTail && splitTail(first.text.slice(j + 1, k + 1))
      if (cut) {
        heading = norm(`${first.text.slice(0, j + 1)} ${cut.head}`)
        rest = norm(`${cut.body} ${first.text.slice(k + 1)}`)
        headingSplit = true
      }
    }
  }
  return { heading, bani: norm([ rest, ...blocks.slice(1).map(b => b.text) ].join(' ')), heading_split: headingSplit }
}

function isoIfReal(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null
  return dt.toISOString().slice(0, 10)
}

/** "Wednesday, 14 October 2026" */
function dateFromLong(text) {
  const m = norm(text).match(/^(?:[A-Za-z]+,\s*)?(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/)
  if (!m) return undefined
  const month = MONTHS.indexOf(m[2].toLowerCase()) + 1
  return month ? isoIfReal(+m[3], month, +m[1]) : undefined
}

/** "... Date 14-10-2026 ..." */
function dateFromTitle(text) {
  const m = String(text ?? '').match(/\bDate\s+(\d{1,2})-(\d{1,2})-(\d{4})\b/)
  return m ? isoIfReal(+m[3], +m[2], +m[1]) : undefined
}

/**
 * The ang a title cites as { lo, hi }, undefined when it has no "Ang" label.
 * Older posts write "Ang-704" or a range such as "ANG 947-948".
 */
function angFromTitle(text, which) {
  const t = String(text ?? '')
  const label = t.match(/\bAng\b/i)
  if (!label) return undefined
  const m = t.slice(label.index + label[0].length)
    .match(/^\s*[:\-–]?\s*([0-9੦-੯०-९]+)(?:\s*[-–]\s*([0-9੦-੯०-९]+))?/)
  const lo = m ? parseNumeral(m[1]) : null
  if (lo == null) throw new LayoutChangedError(`${which} has an ang label without a number: ${JSON.stringify(norm(t))}`)
  const hi = m[2] !== undefined ? parseNumeral(m[2]) : lo
  if (hi < lo) throw new LayoutChangedError(`${which} has a backwards ang range: ${JSON.stringify(norm(t))}`)
  return { lo, hi }
}

function articleLd($) {
  for (const el of $('script[type="application/ld+json"]').toArray()) {
    let o
    try { o = JSON.parse($(el).text()) } catch (e) { continue }
    if (o && o['@type'] === 'Article') return o
  }
  return null
}

/**
 * hukamnamasahib.com morning page. Throws NoHukamnamaError for the site's
 * not-found page, WrongSessionError for an evening or sangrand page,
 * AngMismatchError when the page cites two angs, and LayoutChangedError when
 * the page is not the shape the probe recorded.
 */
function parseMorning(html, opts = {}) {
  const raw = String(html ?? '')
  if (raw.length < 200) throw new LayoutChangedError('empty response')
  const $ = cheerio.load(raw)
  const docTitle = norm($('title').first().text()).replace(/\s*\|\s*Hukamnama Sahib$/, '')
  if (raw.includes(NOT_FOUND_DIGEST) || docTitle === 'Hukamnama Not Found') {
    if ($('.hukamnama-html-content').length) throw new LayoutChangedError('not-found page with content')
    throw new NoHukamnamaError('hukamnamasahib.com not-found page')
  }

  const rows = rowsOf(flightOf($))
  const mains = findMainProps(rows)
  if (mains.length !== 1) throw new LayoutChangedError(`expected 1 main reading in the page data, found ${mains.length}`)
  const props = mains[0]
  const payload = props.data

  const slug = String(props.slug ?? '')
  const sm = slug.match(/^(\d{4}-\d{2}-\d{2})-([a-z]+)$/)
  if (!sm) throw new LayoutChangedError(`slug not understood: ${JSON.stringify(slug)}`)
  const payloadTitle = norm(payload.title)
  const titleMarker = (payloadTitle.match(MORNING_TITLE) || [])[0]
  if (props.category !== 'morning' || sm[2] !== 'morning' || !titleMarker || !MORNING_TITLE.test(docTitle)) {
    throw new WrongSessionError(`category ${props.category}, slug ${slug}, title ${JSON.stringify(payloadTitle)}`)
  }

  const ld = articleLd($)
  const date = props.publishDate
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date ?? '')) || !isoIfReal(...date.split('-').map(Number))) {
    throw new LayoutChangedError(`publishDate not understood: ${JSON.stringify(date)}`)
  }

  // A post can exist before its text does: the site shows a "being updated" notice and no contentHtml.
  if (payload.contentHtml == null || payload.contentHtml === '') {
    throw new NoHukamnamaError('page has no reading text yet', date)
  }
  const contentHtml = flightString(payload.contentHtml, rows, 'contentHtml')
  const containers = $('.hukamnama-html-content')
  if (containers.length !== 1) throw new LayoutChangedError(`expected 1 .hukamnama-html-content, found ${containers.length}`)
  const flat = s => s.replace(/\s+/g, '')
  if (flat(containers.first().text()) !== flat(cheerio.load(`<div>${contentHtml}</div>`)('div').first().text())) {
    throw new LayoutChangedError('rendered reading differs from the page data')
  }
  const { blocks, preamble } = readingBlocks(contentHtml)
  const contentTitle = preamble.join(' ')

  const dates = {
    slug: sm[1],
    payload: dateFromLong(payload.date),
    title: dateFromTitle(payloadTitle),
    content_title: dateFromTitle(contentTitle),
    ld: ld ? ld.datePublished : undefined,
  }
  for (const [ k, v ] of Object.entries(dates)) {
    if (v !== undefined && v !== date) throw new LayoutChangedError(`page dates disagree: publishDate ${date}, ${k} ${v}`)
  }

  const angSources = {}
  if (payload.ang !== undefined && payload.ang !== null && payload.ang !== '') {
    const n = parseNumeral(String(payload.ang))
    if (n == null) throw new LayoutChangedError(`payload ang not a number: ${JSON.stringify(payload.ang)}`)
    angSources.payload = n
  }
  const titled = {
    title: payloadTitle, document_title: docTitle, h1: norm($('h1').first().text()),
    ld: ld && ld.headline, content_title: contentTitle,
  }
  const ranges = {}
  for (const [ k, t ] of Object.entries(titled)) {
    const r = angFromTitle(t, k)
    if (r === undefined) continue
    if (r.lo === r.hi) angSources[k] = r.lo
    else { ranges[k] = r; angSources[k] = `${r.lo}-${r.hi}` }
  }
  const points = [ ...new Set(Object.values(angSources).filter(v => typeof v === 'number')) ]
  // A range only disagrees when the single cited ang falls outside it.
  if (points.length > 1 || Object.values(ranges).some(r => points.some(p => p < r.lo || p > r.hi))) {
    throw new AngMismatchError(angSources)
  }
  const ang = points.length ? points[0] : null

  if (!blocks.length) {
    if (!flat(cheerio.load(`<div>${contentHtml}</div>`)('div').first().text())) throw new NoHukamnamaError('empty reading', date)
    throw new LayoutChangedError('no Gurmukhi reading block in the content')
  }
  const { heading, bani, heading_split: headingSplit } = splitHeading(blocks, opts)
  if (!bani) throw new NoHukamnamaError('reading has no bani after its heading', date)

  return {
    date,
    time: null,
    session: 'morning',
    heading,
    bani,
    heading_split: headingSplit,
    ang,
    ang_sources: angSources,
    raw_marker: titleMarker,
    slug,
    page_created_utc: props.createdAt ?? payload.createdAt ?? (ld && ld.dateCreated) ?? null,
    page_modified_utc: props.updatedAt ?? payload.updatedAt ?? (ld && ld.dateModified) ?? null,
  }
}

/**
 * splitTail for parseMorning(), judged against the corpus. A segment splits when its leading words match a
 * corpus heading line and the remaining words match a bani line better than the whole segment does.
 */
function headingSplitter(resolver, sourceId = SOURCE_SGGS) {
  const typeIds = new Map(resolver.db.prepare('SELECT id, name_english FROM line_types').all().map(t => [ t.name_english, t.id ]))
  for (const name of [ 'Sirlekh', 'Rahao', 'Pankti' ]) {
    if (!typeIds.has(name)) throw new Error(`corpus has no ${name} line type`)
  }
  const typeOf = new Map(resolver.db.prepare('SELECT id, type_id FROM lines').all().map(l => [ l.id, l.type_id ]))
  const pool = resolver.bySource.get(sourceId) || []
  const headingLines = pool.filter(l => typeOf.get(l.line_id) === typeIds.get('Sirlekh'))
  const baniLines = pool.filter(l => [ typeIds.get('Rahao'), typeIds.get('Pankti') ].includes(typeOf.get(l.line_id)))
  const best = (text, lines) => {
    const q = canon(text)
    if (q.length < 2) return 0
    const grams = bigrams(q)
    let top = 0
    for (const l of lines) {
      // Outside this length band Dice cannot reach lineMatch so skipping never changes a decision.
      if (l.len < q.length * 0.5 || l.len > q.length * 2) continue
      const sim = dicePre(grams, q.length, l.grams, l.len)
      if (sim > top) top = sim
    }
    return top
  }
  return tail => {
    const words = tail.replace(/॥\s*$/, '').trim().split(/\s+/)
    const whole = best(tail, baniLines)
    let pick = null
    for (let i = 1; i < words.length; i++) {
      const head = words.slice(0, i).join(' ')
      if (best(head, headingLines) < THRESHOLDS.lineMatch) continue
      const body = `${words.slice(i).join(' ')} ॥`
      const score = best(body, baniLines)
      // Ties go to the longer head so a trailing number stays with its label.
      if (score >= THRESHOLDS.lineMatch && score > whole && (!pick || score >= pick.score)) pick = { head, body, score }
    }
    return pick && { head: pick.head, body: pick.body }
  }
}

/** parseMorning() plus the guarantee that the page is the date that was asked for. */
function parseMorningForDate(html, dateISO, opts) {
  let rec
  try {
    rec = parseMorning(html, opts)
  } catch (e) {
    if (e instanceof NoHukamnamaError && e.date && e.date !== dateISO) throw new DateMismatchError(dateISO, e.date)
    throw e
  }
  if (rec.date !== dateISO) throw new DateMismatchError(dateISO, rec.date)
  return rec
}

// --- HTTP ----------------------------------------------------------------

let lastRequestAt = 0
let requestCount = 0
const sleep = ms => new Promise(r => setTimeout(r, ms))
const delayMs = () => Math.max(MIN_DELAY_MS, Number(process.env.HNS_DELAY_MS) || 0)

const morningUrl = dateISO => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) throw new Error(`bad date: ${dateISO}`)
  return `${BASE_URL}/hukamnama/${dateISO}-morning`
}

/** @returns {Promise<{status: number, body: Buffer}>} one GET, no redirects followed */
async function fetchMorningRaw(dateISO) {
  const url = morningUrl(dateISO)
  const wait = lastRequestAt + delayMs() - Date.now()
  if (wait > 0) await sleep(wait)
  requestCount++
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    })
    return { status: res.status, body: Buffer.from(await res.arrayBuffer()) }
  } finally {
    // Measured from the END of a request, so a slow reply never shortens the gap.
    lastRequestAt = Date.now()
  }
}

/** A real 404 and the site's not-found page are both "no page yet". */
function parseMorningResponse({ status, body }, dateISO, opts) {
  if (status === 404) throw new NoHukamnamaError(`http_404: ${morningUrl(dateISO)}`)
  if (status !== 200) throw new HttpError(status, morningUrl(dateISO))
  return parseMorningForDate(body.toString('utf8'), dateISO, opts)
}

async function fetchMorning(dateISO, opts) {
  return parseMorningResponse(await fetchMorningRaw(dateISO), dateISO, opts)
}

module.exports = {
  parseMorning, parseMorningForDate, parseMorningResponse, fetchMorning, fetchMorningRaw, morningUrl,
  readingBlocks, splitHeading, headingSplitter, rowsOf, flightOf, findMainProps, flightString,
  WrongSessionError, AngMismatchError, LayoutChangedError, NoHukamnamaError, DateMismatchError, HttpError,
  BASE_URL, MIN_DELAY_MS, NOT_FOUND_DIGEST,
  requestCount: () => requestCount,
}
