#!/usr/bin/env node
'use strict'

/**
 * Offline cross-check of hukamnamasahib.com morning pages against the cached
 * SGPC archive responses for the same dates. No network.
 *
 *   node bin/crosscheck-hns.js validation/dates.txt
 *
 * Writes cache/hns-crosscheck.jsonl and validation/hns-crosscheck.md. The
 * report carries ids, numbers and diff positions only, never Gurbani text.
 */

const fs = require('fs')
const path = require('path')
const { Resolver, SOURCE_SGGS, THRESHOLDS, canon, dice } = require('../lib/resolve')
const { parseArchiveForDate } = require('../lib/scrape')
const { parseMorningResponse, headingSplitter, NoHukamnamaError } = require('../lib/hns')
const { readCached } = require('./harvest-hns')

const DB_PATH = process.env.SHABADOS_DB
  || 'node_modules/@shabados/database/build/database.sqlite'
const ROOT = path.join(__dirname, '..')
const SGPC_DIR = path.join(ROOT, 'cache', 'archive')
const HNS_DIR = process.env.HNS_CACHE_DIR || path.join(ROOT, 'cache', 'hns')
const RESULTS = path.join(ROOT, 'cache', 'hns-crosscheck.jsonl')
const REPORT = path.join(ROOT, 'validation', 'hns-crosscheck.md')

const r4 = x => Number(x.toFixed(4))
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
const isPrefix = (a, b) => a.length <= b.length && a.every((x, i) => x === b[i])

const ORDER = [ 'EQUAL_IDS', 'PREFIX', 'START_WRONG', 'OTHER', 'REFUSED', 'MISSING' ]

/** How the ids hns would publish relate to SGPC's for the same day. */
function relation(hns, sgpc) {
  if (!hns.shabad_ids.length || hns.shabad_ids[0] !== sgpc.shabad_ids[0]) return 'START_WRONG'
  if (same(hns.shabad_ids, sgpc.shabad_ids) && same(hns.line_ids, sgpc.line_ids)) return 'EQUAL_IDS'
  if (isPrefix(hns.shabad_ids, sgpc.shabad_ids) && isPrefix(hns.line_ids, sgpc.line_ids)) return 'PREFIX'
  return 'OTHER'
}

/** Edit hunks between two strings as positions and lengths, from an LCS table. */
function diffHunks(a, b) {
  const n = a.length, m = b.length
  const w = m + 1
  const L = new Uint32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i * w + j] = a[i] === b[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1])
    }
  }
  const hunks = []
  let i = 0, j = 0, cur = null
  const flush = () => { if (cur) { hunks.push(cur); cur = null } }
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { flush(); i++; j++; continue }
    if (!cur) cur = { hns_pos: i, hns_len: 0, sgpc_pos: j, sgpc_len: 0 }
    if (j < m && (i >= n || L[i * w + j + 1] >= L[(i + 1) * w + j])) { cur.sgpc_len++; j++ } else { cur.hns_len++; i++ }
  }
  flush()
  return hunks
}

const hunkText = hs => hs.map(h => `hns@${h.hns_pos}+${h.hns_len}/sgpc@${h.sgpc_pos}+${h.sgpc_len}`).join(' ')

function ist(utc) {
  if (!utc) return null
  const t = Date.parse(utc)
  if (Number.isNaN(t)) return null
  return new Date(t + 5.5 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16)
}

const pick = r => ({
  ok: !!r.ok, shabad_ids: r.shabad_ids || [], line_ids: r.line_ids || [], confidence: r.confidence,
  score: r.score ?? null, margin: r.margin ?? null, coverage: r.coverage ?? null,
  lines: r.lines_total != null ? `${r.lines_matched}/${r.lines_total}` : null,
  counter_lines: r.counter_lines ?? null, ang_delta: r.ang_delta ?? null, veto: r.reason ?? null,
})

/** Which of the resolver's acceptance gates a resolution failed. */
function refusalOf(r) {
  const gates = []
  if (r.veto) gates.push(`${r.veto} (ang_delta ${r.ang_delta})`)
  if (r.coverage != null && r.coverage < THRESHOLDS.minCoverage) gates.push(`coverage under ${THRESHOLDS.minCoverage}`)
  if (r.score != null && r.score < THRESHOLDS.lineMatch) gates.push(`score under ${THRESHOLDS.lineMatch}`)
  if (r.margin != null && r.margin < THRESHOLDS.minMargin) {
    gates.push(`margin under ${THRESHOLDS.minMargin}${r.counter_lines != null ? ` and the rarest counter sits on ${r.counter_lines} lines` : ''}`)
  }
  return `sggs_unresolved: ${gates.join('; ') || r.confidence}`
}

function readDates(file) {
  return fs.readFileSync(file, 'utf8').split('\n').map(l => l.trim()).filter(l => /^\d{4}-\d{2}-\d{2}$/.test(l))
}

function check(dates) {
  const resolver = new Resolver(DB_PATH)
  const splitTail = headingSplitter(resolver)
  const sgpcFull = new Map()
  const rows = []

  for (const date of dates) {
    const sgpc = parseArchiveForDate(fs.readFileSync(path.join(SGPC_DIR, date.slice(0, 4), `${date}.json`), 'utf8'), date)
    sgpcFull.set(date, canon(`${sgpc.heading} ${sgpc.bani}`))
    const sgpcRes = pick(resolver.resolve(sgpc.heading, sgpc.bani, SOURCE_SGGS, { ang: sgpc.ang }))
    const row = { date, sgpc: sgpcRes, sgpc_ang: sgpc.ang }

    const cached = readCached(HNS_DIR, date)
    if (!cached) { rows.push({ ...row, class: 'MISSING', reason: 'not harvested' }); continue }
    let page
    try {
      page = parseMorningResponse(cached, date, { splitTail })
    } catch (e) {
      const cls = e instanceof NoHukamnamaError ? 'MISSING' : 'REFUSED'
      rows.push({ ...row, class: cls, reason: e.message, http_status: cached.status })
      continue
    }

    const hnsRes = pick(resolver.resolve(page.heading, page.bani, SOURCE_SGGS, { ang: page.ang }))
    const hFull = canon(`${page.heading} ${page.bani}`)
    const hHead = canon(page.heading), sHead = canon(sgpc.heading)
    const hBani = canon(page.bani), sBani = canon(sgpc.bani)
    const textEqual = hFull === sgpcFull.get(date)
    Object.assign(row, {
      hns: hnsRes,
      hns_ang: page.ang,
      heading_split: page.heading_split,
      ang_equal: page.ang === sgpc.ang,
      text_equal: textEqual,
      dice: r4(dice(hFull, sgpcFull.get(date))),
      len: { hns: hFull.length, sgpc: sgpcFull.get(date).length },
      heading_equal: hHead === sHead,
      heading_dice: r4(dice(hHead, sHead)),
      heading_len: { hns: hHead.length, sgpc: sHead.length },
      bani_equal: hBani === sBani,
      bani_dice: r4(dice(hBani, sBani)),
      bani_len: { hns: hBani.length, sgpc: sBani.length },
      heading_hunks: hHead === sHead ? [] : diffHunks(hHead, sHead),
      bani_hunks: hBani === sBani ? [] : diffHunks(hBani, sBani),
      page_created_utc: page.page_created_utc,
      page_modified_utc: page.page_modified_utc,
      // fetch-today publishes nothing when SGGS did not resolve.
      class: hnsRes.ok ? relation(hnsRes, sgpcRes) : 'REFUSED',
      reason: hnsRes.ok ? undefined : refusalOf(hnsRes),
      hns_full: hFull,
    })
    rows.push(row)
  }

  // Another day's text: some other date's SGPC reading matches this page strictly better than its own.
  for (const row of rows) {
    if (!row.hns_full) continue
    const own = dice(row.hns_full, sgpcFull.get(row.date))
    let best = null
    for (const [ d, full ] of sgpcFull) {
      if (d === row.date) continue
      const s = dice(row.hns_full, full)
      if (s > own && (!best || s > best.dice)) best = { date: d, dice: r4(s) }
    }
    row.other_day = best
    delete row.hns_full
  }
  return rows
}

function counts(rows, key) {
  const out = {}
  for (const r of rows) out[r[key]] = (out[r[key]] || 0) + 1
  return out
}

function stats(values) {
  const v = values.filter(Boolean).sort()
  if (!v.length) return null
  return { n: v.length, min: v[0], median: v[Math.floor((v.length - 1) / 2)], max: v[v.length - 1] }
}

const ids = r => (r && r.shabad_ids.length ? r.shabad_ids.join('+') : '-')
const statText = st => (st ? `n=${st.n}, min ${st.min}, median ${st.median}, max ${st.max}` : 'absent on every page')

function writeReport(rows, dates) {
  const parsed = rows.filter(r => r.hns)
  const byClass = counts(rows, 'class')
  const modifiedIst = parsed.map(r => ist(r.page_modified_utc))
  // Older posts were all re-saved in one bulk edit so only same-day edits say when a post goes up.
  const sameDay = parsed.map(r => ist(r.page_modified_utc)).filter((t, i) => t && t.slice(0, 10) === parsed[i].date)

  const L = []
  L.push('# hukamnamasahib.com cross-check')
  L.push('')
  L.push(`Generated by \`bin/crosscheck-hns.js\` from the hukamnamasahib.com morning page for each of the ${dates.length} dates in \`validation/dates.txt\`, compared with the cached SGPC archive response for the same date (the days behind [report.md](report.md)). Corpus \`@shabados/database@4.8.7\`, SGGS only. Ids, numbers and diff positions only.`)
  L.push('')
  L.push('Both sides go through the same resolver with their own heading, bani and ang. SGPC resolved on every day. "Equal" text compares canonical text (the resolver\'s `canon()`), so spacing, danda, vishraam and digits never count as differences.')
  L.push('')
  L.push('## Relation to SGPC')
  L.push('')
  L.push('| class | days | dates (hns confidence) |')
  L.push('|---|---|---|')
  for (const c of ORDER) {
    const inClass = rows.filter(r => r.class === c)
    const conf = counts(inClass.filter(r => r.hns).map(r => ({ c: r.hns.confidence })), 'c')
    const listed = c === 'EQUAL_IDS'
      ? Object.entries(conf).map(([ k, v ]) => `${k} ${v}`).join(', ') || '-'
      : inClass.map(r => `${r.date}${r.hns ? ` (${r.hns.confidence})` : ''}`).join(', ') || '-'
    L.push(`| ${c} | ${inClass.length} | ${listed} |`)
  }
  L.push('')
  L.push('- EQUAL_IDS: same shabad_ids and same line_ids as SGPC.')
  L.push('- PREFIX: shabad_ids a non-empty leading prefix of SGPC\'s and line_ids a leading prefix of SGPC\'s. The site showed only the opening part of the reading.')
  L.push('- START_WRONG: the first shabad id differs from SGPC\'s.')
  L.push('- OTHER: any other relation (extra shabad, gap, lines that are not a prefix).')
  L.push('- REFUSED: fetch-today would publish nothing (SGGS not resolved, ang disagreement, layout).')
  L.push('- MISSING: no morning page with text.')
  L.push('')
  const published = rows.filter(r => r.class === 'EQUAL_IDS' || r.class === 'PREFIX')
  const firstShabad = published.filter(r => r.hns.shabad_ids[0] === r.sgpc.shabad_ids[0]).length
  const firstLine = published.filter(r => r.hns.line_ids[0] === r.sgpc.line_ids[0]).length
  L.push('## Acceptance')
  L.push('')
  L.push(`- START_WRONG: ${byClass.START_WRONG || 0}.`)
  L.push(`- OTHER: ${byClass.OTHER || 0}.`)
  L.push(`- Of ${published.length} published days (EQUAL_IDS and PREFIX): first_shabad_equal ${firstShabad}, first_line_equal ${firstLine}.`)
  L.push(`- Pages whose text matches another date's SGPC reading better than its own: ${rows.filter(r => r.other_day).length}.`)
  L.push('')
  L.push('## Every non-EQUAL_IDS day')
  L.push('')
  L.push('| date | class | sgpc (grade) | hns (grade) | shabads hns/sgpc | lines hns/sgpc | ang sgpc/hns | dice | len hns/sgpc | reason |')
  L.push('|---|---|---|---|---|---|---|---|---|---|')
  for (const r of rows.filter(x => x.class !== 'EQUAL_IDS')) {
    L.push(`| ${r.date} | ${r.class} | ${ids(r.sgpc)} (${r.sgpc.confidence}) | ${r.hns ? `${ids(r.hns)} (${r.hns.confidence})` : '-'} | ${r.hns ? `${r.hns.shabad_ids.length}/${r.sgpc.shabad_ids.length}` : '-'} | ${r.hns ? `${r.hns.line_ids.length}/${r.sgpc.line_ids.length}` : '-'} | ${r.sgpc_ang ?? '-'}/${r.hns_ang ?? '-'} | ${r.dice ?? '-'} | ${r.len ? `${r.len.hns}/${r.len.sgpc}` : '-'} | ${r.reason || '-'} |`)
  }
  L.push('')
  const refused = rows.filter(r => r.class === 'REFUSED' && r.hns)
  if (refused.length) {
    L.push('## Refused days')
    L.push('')
    L.push('| date | score | margin | coverage | lines matched | ang_delta | veto |')
    L.push('|---|---|---|---|---|---|---|')
    for (const r of refused) L.push(`| ${r.date} | ${r.hns.score} | ${r.hns.margin} | ${r.hns.coverage} | ${r.hns.lines} | ${r.hns.ang_delta} | ${r.reason.replace(/^sggs_unresolved: /, '')} |`)
    L.push('')
  }
  L.push('## Heading and bani')
  L.push('')
  const split = parsed.filter(r => r.heading_split)
  L.push(`The heading split rule (\`headingSplitter\` in \`lib/hns.js\`) fired on ${split.length} day${split.length === 1 ? '' : 's'}${split.length ? `: ${split.map(r => r.date).join(', ')}` : ''}. It applies where the site left out the danda between the heading and the first line.`)
  L.push('')
  L.push(`Of ${parsed.length} parsed days: heading_equal ${parsed.filter(r => r.heading_equal).length}, bani_equal ${parsed.filter(r => r.bani_equal).length}, text_equal ${parsed.filter(r => r.text_equal).length}, ang_equal ${parsed.filter(r => r.ang_equal).length}.`)
  L.push('')
  const uneven = parsed.filter(r => !r.heading_equal || !r.bani_equal)
  if (uneven.length) {
    L.push('Every day where either part differs. Positions index the canonical strings; `hns@p+n/sgpc@q+m` replaces n characters at p with m characters at q.')
    L.push('')
    L.push('| date | class | heading_equal | heading dice | heading len hns/sgpc | heading diff | bani_equal | bani dice | bani len hns/sgpc | bani diff |')
    L.push('|---|---|---|---|---|---|---|---|---|---|')
    for (const r of uneven) {
      L.push(`| ${r.date} | ${r.class} | ${r.heading_equal} | ${r.heading_dice} | ${r.heading_len.hns}/${r.heading_len.sgpc} | ${hunkText(r.heading_hunks) || '-'} | ${r.bani_equal} | ${r.bani_dice} | ${r.bani_len.hns}/${r.bani_len.sgpc} | ${hunkText(r.bani_hunks) || '-'} |`)
    }
    L.push('')
  }
  const otherDay = rows.filter(r => r.other_day)
  if (otherDay.length) {
    L.push('## Other-day text')
    L.push('')
    L.push('| date | own dice | better date | its dice |')
    L.push('|---|---|---|---|')
    for (const r of otherDay) L.push(`| ${r.date} | ${r.dice} | ${r.other_day.date} | ${r.other_day.dice} |`)
    L.push('')
  }
  L.push('## Page times')
  L.push('')
  L.push('From the page data: `page_created_utc` is the post\'s own creation time and `page_modified_utc` the Article `dateModified`. Shown in IST.')
  L.push('')
  L.push(`- page_created_utc: ${statText(stats(parsed.map(r => ist(r.page_created_utc))))}.`)
  L.push(`- page_modified_utc: ${statText(stats(modifiedIst))}.`)
  L.push(`- page_modified_utc on the post's own date, time of day: ${statText(stats(sameDay.map(t => t.slice(11))))}.`)
  L.push('')
  L.push('| date | created (IST) | modified (IST) |')
  L.push('|---|---|---|')
  for (const r of parsed) L.push(`| ${r.date} | ${ist(r.page_created_utc) ?? '-'} | ${ist(r.page_modified_utc) ?? '-'} |`)
  L.push('')
  fs.writeFileSync(REPORT, L.join('\n'))
}

function main() {
  const listFile = process.argv[2]
  if (!listFile) {
    console.error('usage: crosscheck-hns.js <date-list-file>')
    process.exit(2)
  }
  const dates = readDates(listFile)
  const rows = check(dates)
  fs.writeFileSync(RESULTS, rows.map(r => JSON.stringify(r)).join('\n') + '\n')
  writeReport(rows, dates)
  const byClass = counts(rows, 'class')
  console.error(JSON.stringify(byClass))
  console.error(`other-day: ${rows.filter(r => r.other_day).length}`)
  console.error(`wrote ${path.relative(process.cwd(), RESULTS)} and ${path.relative(process.cwd(), REPORT)}`)
}

if (require.main === module) main()

module.exports = { diffHunks, relation }
