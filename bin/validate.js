#!/usr/bin/env node
'use strict'

/**
 * Offline validation against gurbaninow/hukamnama-archive. For each date in
 * the list: parse the cached archive response, resolve it, compare with the
 * gurbaninow file for that day, and attribute every disagreement from the
 * page text itself. No network.
 *
 *   node bin/validate.js validation/dates.txt
 *
 * Writes validation/results.jsonl (gitignored) and validation/report.md.
 * gurbaninow is a reference only, never an authority: its recent days likely
 * come from its SikhNet fallback (see report.md), so "reference wrong" is a
 * legitimate outcome.
 */

const fs = require('fs')
const path = require('path')
const {
  Resolver, SOURCE_SGGS, THRESHOLDS, splitLines, canon, bigrams, dicePre,
} = require('../lib/resolve')
const { parseArchiveForDate } = require('../lib/scrape')
const { cachePath } = require('../lib/cache')
const { writeReport } = require('./analyse')

const DB_PATH = process.env.SHABADOS_DB
  || 'node_modules/@shabados/database/build/database.sqlite'
const CACHE_DIR = process.env.CACHE_DIR || path.join(__dirname, '..', 'cache', 'archive')
const GN_DIR = process.env.GN_ARCHIVE
  || path.join(__dirname, '..', '..', 'gurbaninow-hukamnama-archive', 'archive')
const RESULTS = path.join(__dirname, '..', 'validation', 'results.jsonl')

// A set "reaches" the page when it explains the reading as well as a high grade demands.
const REACH = { coverage: THRESHOLDS.highCoverage, avg: THRESHOLDS.lineStrong }
// Reverse coverage bands: below LOW a shabad was not read, at or above READ it was.
const REV = { low: 0.2, notRead: 0.5, read: 0.8 }
const ADJACENT = 2
// Corpus lines this short are headings or rahaau stubs that splitLines() folds away.
const MIN_LINE_CANON = 8

const r3 = x => Number(x.toFixed(3))
const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x))

function gnIds(date) {
  const [ y, m, d ] = date.split('-')
  const f = path.join(GN_DIR, y, m, `${d}.json`)
  if (!fs.existsSync(f)) return null
  return JSON.parse(fs.readFileSync(f, 'utf8')).shabad_ids
}

class Index {
  constructor(resolver) {
    this.R = resolver
    this.byShabad = new Map()
    this.order = new Map()
    for (const l of resolver.lines) {
      if (l.source_id !== SOURCE_SGGS) continue
      if (!this.byShabad.has(l.shabad_id)) this.byShabad.set(l.shabad_id, [])
      this.byShabad.get(l.shabad_id).push(l)
      this.order.set(l.shabad_id, l.shabad_order)
    }
    this.byOrder = new Map([ ...this.order ].map(([ id, o ]) => [ o, id ]))
  }

  adjacentTo(id, set) {
    const o = this.order.get(id)
    return o != null && set.some(s => this.order.has(s) && Math.abs(this.order.get(s) - o) <= ADJACENT)
  }

  neighbours(set) {
    const out = new Set()
    for (const s of set) {
      const o = this.order.get(s)
      if (o == null) continue
      for (let k = -ADJACENT; k <= ADJACENT; k++) {
        const id = this.byOrder.get(o + k)
        if (id && !set.includes(id)) out.add(id)
      }
    }
    return [ ...out ]
  }

  angs(id) {
    return { start: this.R.shabadStartAng.get(id) ?? null, end: this.R.shabadEndAng.get(id) ?? null }
  }
}

const toQuery = lines => lines.map(t => { const c = canon(t); return { len: c.length, grams: bigrams(c) } })

/**
 * HS per-line best-match scoring restricted to one id set: the share of page
 * lines found in that set at lineMatch, and their mean similarity.
 */
function scoreAgainst(index, query, ids) {
  const pool = ids.flatMap(id => index.byShabad.get(id) || [])
  let matched = 0, sum = 0
  for (const q of query) {
    let best = 0
    for (const c of pool) {
      const s = dicePre(q.grams, q.len, c.grams, c.len)
      if (s > best) best = s
    }
    if (best >= THRESHOLDS.lineMatch) { matched++; sum += best }
  }
  const coverage = query.length ? matched / query.length : 0
  const avg = matched ? sum / matched : 0
  return {
    coverage: r3(coverage), avg: r3(avg),
    reaches: coverage >= REACH.coverage && avg >= REACH.avg,
  }
}

/** Share of a shabad's own corpus lines that some page line matches at lineMatch. */
function reverseCoverage(index, query, id) {
  const lines = (index.byShabad.get(id) || []).filter(l => l.len >= MIN_LINE_CANON)
  if (!lines.length) return null
  let hit = 0
  for (const l of lines) {
    if (query.some(q => dicePre(q.grams, q.len, l.grams, l.len) >= THRESHOLDS.lineMatch)) hit++
  }
  return r3(hit / lines.length)
}

/** Which acceptance gates the result failed, mirroring the ok expression in Resolver.resolve(). */
function gates(r) {
  const T = THRESHOLDS
  if (r.reason === 'query_too_short' || r.reason === 'no_candidate') {
    return { failing: [ r.reason === 'no_candidate' ? 'lineMatch' : 'query_too_short' ], vetoes: [], rescued: [], high_limits: [] }
  }
  const failing = []
  if (r.coverage < T.minCoverage) failing.push('minCoverage')
  if (r.score < T.lineMatch) failing.push('lineMatch')
  if (r.margin < T.minMargin && !r.counter_discriminates) failing.push('minMargin')
  const vetoes = []
  if (r.ang_delta != null) {
    if (Math.abs(r.ang_delta) > T.maxAngDelta) vetoes.push('maxAngDelta')
    if (r.ang_delta < T.minAngDeltaSggs) vetoes.push('minAngDeltaSggs')
    if (r.ang_corpus_end != null && r.ang_scraped - r.ang_corpus_end > T.maxAngPastEndSggs) {
      vetoes.push('maxAngPastEndSggs')
    }
  }
  failing.push(...vetoes.map(v => `veto_${v}`))
  const rescued = (r.margin < T.minMargin && r.counter_discriminates) ? [ 'counter_override' ] : []
  const high_limits = []
  if (r.ok && r.confidence === 'medium') {
    if (r.coverage < T.highCoverage) high_limits.push('highCoverage')
    if (r.score < T.lineStrong) high_limits.push('lineStrong')
    if (!(r.counter_agrees || r.counters.length === 0)) high_limits.push('counter_agrees')
  }
  return { failing, vetoes, rescued, high_limits }
}

function classify(index, ours, gn) {
  if (!gn) return 'NO_REFERENCE'
  if (!ours.length) return gn.length ? 'REFUSED' : 'AGREE'
  if (sameSet(ours, gn)) return 'AGREE'
  const extraOurs = ours.filter(x => !gn.includes(x))
  const extraGn = gn.filter(x => !ours.includes(x))
  if (!extraOurs.length && extraGn.every(x => index.adjacentTo(x, ours))) return 'SUBSET'
  if (!extraGn.length && extraOurs.every(x => index.adjacentTo(x, gn))) return 'SUPERSET'
  return 'DIFFERENT'
}

function textualDuplicate(index, a, b) {
  const canonsB = new Set(b.flatMap(id => (index.byShabad.get(id) || [])
    .filter(l => l.len >= MIN_LINE_CANON).map(l => l.canon)))
  return a.some(id => (index.byShabad.get(id) || []).some(l => l.len >= MIN_LINE_CANON && canonsB.has(l.canon)))
}

function attribute(index, row, query, revQuery) {
  const cand = row.candidate_ids
  const gn = row.gn_ids
  const graded = row.confidence === 'high' || row.confidence === 'medium'

  const rev = {}
  for (const id of new Set([ ...cand, ...gn ])) rev[id] = reverseCoverage(index, revQuery, id)
  const outside = new Set([ ...index.neighbours(cand), ...index.neighbours(gn) ])
  const neighbourRev = {}
  for (const id of outside) {
    if (rev[id] !== undefined) continue
    const v = reverseCoverage(index, revQuery, id)
    if (v != null && v >= REV.low) neighbourRev[id] = v
  }

  const review = []
  const tags = []
  for (const [ id, v ] of Object.entries(rev)) {
    if (v == null) continue
    const side = [ cand.includes(id) && 'ours', gn.includes(id) && 'gn' ].filter(Boolean).join('+')
    if (v >= REV.low && v < REV.read) {
      review.push({ id, side, rev: v, below_not_read: v < REV.notRead })
    } else if (v < REV.low) {
      tags.push(`${side} ${id} not read`)
    }
  }
  // Outside a set means outside THAT set, so the other side's members count too.
  for (const [ id, v ] of Object.entries({ ...rev, ...neighbourRev })) {
    if (v == null) continue
    for (const [ name, set ] of [ [ 'ours', cand ], [ 'gn', gn ] ]) {
      if (set.includes(id) || !index.adjacentTo(id, set)) continue
      if (v >= REV.read) tags.push(`${name} missing read shabad ${id}`)
      else if (!(id in rev)) {
        const prev = review.find(x => x.id === id && x.side.startsWith('adjacent to '))
        if (prev) prev.side += `+${name}`
        else review.push({ id, side: `adjacent to ${name}`, rev: v, below_not_read: false })
      }
    }
  }

  const fwdOurs = cand.length ? scoreAgainst(index, query, cand) : null
  const fwdGn = scoreAgainst(index, query, gn)

  let label
  const oursNotRead = tags.some(t => /^ours.* not read$/.test(t))
  const gnNotRead = tags.some(t => /gn \S+ not read$/.test(t))
  if (review.length) {
    label = 'needs review'
  } else if (oursNotRead && graded) {
    label = 'KNOWN-WRONG (ours not read)'
  } else if (gnNotRead && !oursNotRead) {
    label = 'reference wrong (gn, likely SikhNet-sourced)'
  } else if (row.class === 'REFUSED' && sameSet(cand, gn)) {
    label = 'refused, candidate equals reference'
  } else {
    const oR = !!(fwdOurs && fwdOurs.reaches)
    const gR = fwdGn.reaches
    if (gR && !oR) label = graded ? 'KNOWN-WRONG (us wrong)' : 'us wrong, refused'
    else if (oR && !gR) label = 'reference wrong (gn, likely SikhNet-sourced)'
    else if (oR && gR) {
      const diff = [ ...cand.filter(x => !gn.includes(x)), ...gn.filter(x => !cand.includes(x)) ]
      const adjacency = diff.every(x => index.adjacentTo(x, cand.filter(y => gn.includes(y))))
      label = 'edition/id difference: ' + (adjacency && diff.length ? 'adjacency extra'
        : textualDuplicate(index, cand.filter(x => !gn.includes(x)), gn) ? 'textual duplicate'
          : 'other')
    } else label = 'unattributed'
  }
  return { label, tags, review, rev, neighbour_rev: neighbourRev, fwd_ours: fwdOurs, fwd_gn: fwdGn }
}

function main() {
  const listFile = process.argv[2]
  if (!listFile) {
    console.error('usage: validate.js <date-list-file>')
    process.exit(2)
  }
  if (!fs.existsSync(DB_PATH)) {
    console.error(`corpus not found at ${DB_PATH} — set SHABADOS_DB`)
    process.exit(2)
  }
  const dates = fs.readFileSync(listFile, 'utf8').split('\n').map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))

  const resolver = new Resolver(DB_PATH)
  const index = new Index(resolver)
  const rows = []

  for (const date of dates) {
    const gn = gnIds(date)
    const row = { date, gn_ids: gn, gn_angs: gn ? Object.fromEntries(gn.map(id => [ id, index.angs(id) ])) : null }
    const cp = cachePath(CACHE_DIR, date)
    if (!fs.existsSync(cp)) {
      rows.push({ ...row, status: 'not_cached', class: 'NOT_CACHED' })
      continue
    }

    let rec
    try {
      rec = parseArchiveForDate(fs.readFileSync(cp, 'utf8'), date)
    } catch (e) {
      rows.push({
        ...row, status: 'parse_refused', parse_error: e.name, parse_detail: e.message,
        class: gn && gn.length ? 'REFUSED' : 'NO_REFERENCE', attribution: { label: `refused: ${e.name}` },
      })
      console.error(`${date}  ${e.name}`)
      continue
    }

    const r = resolver.resolve(rec.heading, rec.bani, SOURCE_SGGS, { ang: rec.ang })
    const noAng = resolver.resolve(rec.heading, rec.bani, SOURCE_SGGS, { ang: null })
    const ours = r.ok ? r.shabad_ids : []
    Object.assign(row, {
      status: 'ok',
      ids: ours,
      candidate_ids: r.shabad_ids || [],
      confidence: r.confidence,
      score: r.score ?? null,
      margin: r.margin ?? null,
      coverage: r.coverage ?? null,
      reason: r.reason ?? null,
      ang: rec.ang,
      ang_ascii: rec.ang_ascii,
      ang_gurmukhi: rec.ang_gurmukhi,
      ang_field: rec.ang_field,
      ang_corpus: r.ang_corpus ?? null,
      ang_corpus_end: r.ang_corpus_end ?? null,
      ang_delta: r.ang_delta ?? null,
      cited_minus_last: (rec.ang != null && r.ang_corpus_end != null) ? rec.ang - r.ang_corpus_end : null,
      counters: r.counters ?? [],
      counter_lines: r.counter_lines ?? null,
      counter_discriminates: r.counter_discriminates ?? false,
      devanagari_digits: rec.devanagari_digits,
      lines_total: r.lines_total ?? null,
      gates: r.coverage != null || r.reason ? gates(r) : null,
      tie_break_decided: JSON.stringify(noAng.line_ids) !== JSON.stringify(r.line_ids)
        || JSON.stringify(noAng.shabad_ids) !== JSON.stringify(r.shabad_ids),
    })
    row.class = classify(index, ours, gn)

    const multi = (gn && gn.length > 1) || row.candidate_ids.length > 1
    if (gn && (row.class !== 'AGREE' || multi)) {
      const query = toQuery(splitLines(rec.bani))
      const revQuery = toQuery(splitLines(`${rec.heading} ॥ ${rec.bani}`))
      const a = attribute(index, row, query, revQuery)
      if (row.class === 'AGREE') {
        row.reverse = a.rev
        row.attribution = a.review.length ? { label: 'needs review', review: a.review, rev: a.rev } : null
      } else {
        row.attribution = a
      }
    }
    rows.push(row)
    const lbl = row.attribution ? `  ${row.attribution.label}` : ''
    console.error(`${date}  ${row.class}  ours=${ours.join('+') || '-'}/${r.confidence}  gn=${(gn || []).join('+')}${lbl}`)
  }

  fs.writeFileSync(RESULTS, rows.map(r => JSON.stringify(r)).join('\n') + '\n')
  const report = writeReport(rows, { list: path.relative(path.join(__dirname, '..'), path.resolve(listFile)) })
  console.error(`\nwrote ${path.relative(process.cwd(), RESULTS)} and ${path.relative(process.cwd(), report)}`)
}

if (require.main === module) main()

module.exports = { scoreAgainst, reverseCoverage, classify, gates }
