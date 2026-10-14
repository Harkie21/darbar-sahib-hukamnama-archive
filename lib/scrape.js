'use strict'

const cheerio = require('cheerio')
const { canon, parseNumeral } = require('./resolve')

const LATEST_URL = 'https://hs.sgpc.net/index.php'
const ARCHIVE_URL = 'https://hs.sgpc.net/hssearchhukmanamaTestCalender.php'
const USER_AGENT =
  'darbar-sahib-hukamnama-archive/0.1 (+https://github.com/Harkie21/darbar-sahib-hukamnama-archive; contact: harkiratsingh135790@gmail.com)'

// A floor, not a default: SGPC_DELAY_MS may only make the scraper slower.
const MIN_DELAY_MS = 3000

const DIGIT_CLASS = '੦-੯०-९0-9'
// The digits of an ang are sometimes split by a space or zero-width character,
// as HS extractAng() found on Nanded's page, so the run tolerates them.
const DIGIT_RUN = `[${DIGIT_CLASS}][${DIGIT_CLASS}\\s\\u200b\\u200c\\u00a0]*`

class LayoutChangedError extends Error {
  constructor(detail) {
    super(`layout_changed: ${detail}`)
    this.name = 'LayoutChangedError'
  }
}

/** The server answered fine but published nothing for that day. Data, not failure. */
class NoHukamnamaError extends Error {
  constructor(detail, date = null) {
    super(`no_hukamnama: ${detail}`)
    this.name = 'NoHukamnamaError'
    this.date = date
  }
}

/** The page cites two different angs. Neither can be trusted, so the day is refused. */
class AngMismatchError extends Error {
  constructor(ascii, gurmukhi) {
    super(`ang_mismatch: english ${ascii} vs gurmukhi ${gurmukhi}`)
    this.name = 'AngMismatchError'
    this.ang_ascii = ascii
    this.ang_gurmukhi = gurmukhi
  }
}

class DateMismatchError extends Error {
  constructor(requested, got) {
    super(`date_mismatch: requested ${requested}, got ${got}`)
    this.name = 'DateMismatchError'
    this.requested = requested
    this.got = got
  }
}

class HttpError extends Error {
  constructor(status, url) {
    super(`http_${status}: ${url}`)
    this.name = 'HttpError'
    this.status = status
  }
}

/** IST date, "YYYY-MM-DD". The hukamnama is read at Amritsar, so its day
 *  boundary governs "today", not the machine's local clock. */
function todayIST() {
  const now = new Date(Date.now() + (5.5 * 60 * 60 * 1000))
  return now.toISOString().slice(0, 10)
}

const norm = s => String(s ?? '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim()

function isoIfReal(y, m, d) {
  if (y == null || m == null || d == null) return null
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null
  return dt.toISOString().slice(0, 10)
}

/**
 * "14-10-2026  05:15 AM" -> { date: '2026-10-14', time: '05:15' }.
 * The page puts two spaces before the time, and the time may be absent.
 */
function parseTimestamp(text) {
  const t = norm(text)
  const D = `[${DIGIT_CLASS}]`
  const m = t.match(new RegExp(
    `^(${D}{1,2})-(${D}{1,2})-(${D}{4})(?:\\s+(${D}{1,2}):(${D}{2})\\s*(AM|PM))?$`, 'i'
  ))
  if (!m) throw new LayoutChangedError(`timestamp not understood: ${JSON.stringify(t)}`)
  const date = isoIfReal(parseNumeral(m[3]), parseNumeral(m[2]), parseNumeral(m[1]))
  if (!date) throw new LayoutChangedError(`timestamp is not a calendar date: ${JSON.stringify(t)}`)
  let time = null
  if (m[4] !== undefined) {
    let h = parseNumeral(m[4])
    const min = parseNumeral(m[5])
    if (h < 1 || h > 12 || min > 59) throw new LayoutChangedError(`timestamp time out of range: ${JSON.stringify(t)}`)
    const pm = m[6].toUpperCase() === 'PM'
    if (h === 12) h = 0
    if (pm) h += 12
    time = `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
  }
  return { date, time }
}

/**
 * The single ang cited in one card's footers, or null when no label exists.
 * A label whose number does not parse is a layout change, never a missing ang.
 */
function angFromFooters(footers, labelRe, which) {
  const values = []
  for (const raw of footers) {
    const text = String(raw ?? '')
    const labels = [ ...text.matchAll(new RegExp(labelRe.source, 'gi')) ]
    for (const lm of labels) {
      const rest = text.slice(lm.index + lm[0].length)
      const m = rest.match(new RegExp(`^\\s*[:：\\-–—]?\\s*(${DIGIT_RUN})\\)`))
      const n = m ? parseNumeral(m[1]) : null
      if (n == null) {
        throw new LayoutChangedError(`${which} ang label without a number: ${JSON.stringify(norm(text))}`)
      }
      values.push(n)
    }
  }
  if (new Set(values).size > 1) {
    throw new LayoutChangedError(`${which} footers cite several angs: ${values.join(',')}`)
  }
  return values.length ? values[0] : null
}

const GURMUKHI_ANG_LABEL = /\(\s*ਅੰਗ/
const ENGLISH_ANG_LABEL = /\(\s*(?:Page|Ang)\b/

function countDevanagari(...texts) {
  return texts.join('').match(/[०-९]/g)?.length ?? 0
}

/** Shared by both parsers so the latest page and the archive can never disagree on rules. */
function toRecord({ date, time, gheading1, gheading2, bani, gFooters, eFooters, angField }) {
  const angAscii = angFromFooters(eFooters, ENGLISH_ANG_LABEL, 'english')
  const angGurmukhi = angFromFooters(gFooters, GURMUKHI_ANG_LABEL, 'gurmukhi')
  if (angAscii != null && angGurmukhi != null && angAscii !== angGurmukhi) {
    throw new AngMismatchError(angAscii, angGurmukhi)
  }
  return {
    date,
    time,
    heading: norm(`${gheading1 ?? ''} ${gheading2 ?? ''}`),
    bani,
    ang: angAscii ?? angGurmukhi,
    ang_ascii: angAscii,
    ang_gurmukhi: angGurmukhi,
    ang_field: angField == null || angField === '' ? null : parseNumeral(String(angField)),
    devanagari_digits: countDevanagari(bani, ...gFooters, ...eFooters),
  }
}

/**
 * hs.sgpc.net/index.php. Throws NoHukamnamaError when the card is empty,
 * LayoutChangedError when the page is not the shape the probe recorded.
 */
function parseLatest(html) {
  if (!html || String(html).length < 200) throw new LayoutChangedError('empty response')
  const $ = cheerio.load(html)

  const cards = $('.hukamnama-card')
  if (cards.length !== 1) throw new LayoutChangedError(`expected 1 .hukamnama-card, found ${cards.length}`)
  const card = cards.first()

  const stamps = $('p.customDate').filter((_, el) =>
    $(el).closest('.hukamnama-card, .hukamnama-card2').length === 0)
  if (stamps.length !== 1) throw new LayoutChangedError(`expected 1 timestamp, found ${stamps.length}`)
  const { date, time } = parseTimestamp(stamps.first().text())

  card.find('br').replaceWith(' ')
  const blocks = card.find('p.hukamnama-text').map((_, el) => norm($(el).text())).get().filter(Boolean)
  if (!card.find('p.hukamnama-text').length) throw new LayoutChangedError('no p.hukamnama-text in the card')
  if (!blocks.length) throw new NoHukamnamaError('card has no bani', date)
  const bani = blocks.join(' ')

  let angField = null
  const embedded = $('#hukamnamaPdfData')
  if (embedded.length) {
    let data
    try { data = JSON.parse(embedded.first().text()) } catch (e) {
      throw new LayoutChangedError(`#hukamnamaPdfData is not JSON: ${e.message}`)
    }
    if (data.date !== date) {
      throw new LayoutChangedError(`#hukamnamaPdfData date ${data.date} vs timestamp ${date}`)
    }
    if (canon(data.ghukamnama) !== canon(bani)) {
      throw new LayoutChangedError('#hukamnamaPdfData bani differs from the rendered bani')
    }
    angField = data.ang
  }

  const rec = toRecord({
    date,
    time,
    gheading1: card.find('h4.hukamnama-title').text(),
    gheading2: card.find('h5.hukamnama-subtitle').text(),
    bani,
    gFooters: card.find('p.customDate').map((_, el) => $(el).text()).get(),
    eFooters: $('.hukamnama-card2 p.customDate').map((_, el) => $(el).text()).get(),
    angField,
  })
  // Kept verbatim so the poll log can show exactly what a strict date parser would see.
  rec.timestamp_raw = stamps.first().text().trim()
  return rec
}

/** hssearchhukmanamaTestCalender.php JSON. It carries no reading time. */
function parseArchive(raw) {
  let data
  try { data = JSON.parse(String(raw)) } catch (e) {
    throw new LayoutChangedError(`archive response is not JSON: ${e.message}`)
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new LayoutChangedError(`archive response is not an object: ${typeof data}`)
  }
  const h = data.hukamnama
  if (data.supported === false) {
    throw new NoHukamnamaError(norm(h && h.message) || 'supported=false', (h && h.date) || null)
  }
  if (data.supported !== true || !h || typeof h !== 'object') {
    throw new LayoutChangedError(`unexpected archive keys: ${Object.keys(data).join(',')}`)
  }
  const m = String(h.date ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  const date = m ? isoIfReal(+m[1], +m[2], +m[3]) : null
  if (!date) throw new LayoutChangedError(`archive date not understood: ${JSON.stringify(h.date)}`)

  const bani = norm(String(h.ghukamnama ?? '').replace(/<br\s*\/?>/gi, ' '))
  if (!bani) throw new NoHukamnamaError('empty ghukamnama', date)

  return toRecord({
    date,
    time: null,
    gheading1: h.gheading1,
    gheading2: h.gheading2,
    bani,
    gFooters: [ h.gfooter1, h.gfooter2 ],
    eFooters: [ h.efooter1, h.efooter2 ],
    angField: h.ang,
  })
}

/** parseArchive() plus the guarantee that the server answered the date that was asked. */
function parseArchiveForDate(raw, dateISO) {
  let rec
  try {
    rec = parseArchive(raw)
  } catch (e) {
    if (e instanceof NoHukamnamaError && e.date && e.date !== dateISO) {
      throw new DateMismatchError(dateISO, e.date)
    }
    throw e
  }
  if (rec.date !== dateISO) throw new DateMismatchError(dateISO, rec.date)
  return rec
}

// --- HTTP ----------------------------------------------------------------

let lastRequestAt = 0
let requestCount = 0
const sleep = ms => new Promise(r => setTimeout(r, ms))
const delayMs = () => Math.max(MIN_DELAY_MS, Number(process.env.SGPC_DELAY_MS) || 0)

/** Every request to hs.sgpc.net goes through here, so the floor holds across callers. */
async function politeFetch(url, init = {}) {
  const wait = lastRequestAt + delayMs() - Date.now()
  if (wait > 0) await sleep(wait)
  requestCount++
  try {
    const res = await fetch(url, {
      ...init,
      headers: { 'User-Agent': USER_AGENT, ...(init.headers || {}) },
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    })
    const body = Buffer.from(await res.arrayBuffer())
    if (res.status !== 200) throw new HttpError(res.status, url)
    return body
  } finally {
    // Measured from the END of a request, so a slow reply never shortens the gap.
    lastRequestAt = Date.now()
  }
}

/** @returns {Promise<Buffer>} raw index.php body */
function fetchLatestHtml() {
  return politeFetch(LATEST_URL, { headers: { Accept: 'text/html' } })
}

/** @returns {Promise<Buffer>} raw archive JSON body, exactly as received */
function fetchArchiveRaw(dateISO) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) throw new Error(`bad date: ${dateISO}`)
  return politeFetch(ARCHIVE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json',
    },
    body: new URLSearchParams({ selected_date: dateISO }).toString(),
  })
}

async function fetchArchiveForDate(dateISO) {
  return parseArchiveForDate((await fetchArchiveRaw(dateISO)).toString('utf8'), dateISO)
}

module.exports = {
  parseLatest, parseArchive, parseArchiveForDate, parseTimestamp,
  fetchLatestHtml, fetchArchiveRaw, fetchArchiveForDate, todayIST,
  LayoutChangedError, NoHukamnamaError, AngMismatchError, DateMismatchError, HttpError,
  LATEST_URL, ARCHIVE_URL, USER_AGENT, MIN_DELAY_MS,
  requestCount: () => requestCount,
}
