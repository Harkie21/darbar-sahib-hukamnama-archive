#!/usr/bin/env node
'use strict'

/**
 * Reads validation/results.jsonl and writes validation/report.md. Pure
 * analysis, no network. Ids and numbers only: no Gurbani text reaches the report.
 *
 *   node bin/analyse.js [results.jsonl]
 *
 * The numbers here are measurements, not tuning input. A threshold or veto
 * change needs its own decision.
 */

const fs = require('fs')
const path = require('path')
const { THRESHOLDS } = require('../lib/resolve')
const { parseLatest } = require('../lib/scrape')

const ROOT = path.join(__dirname, '..')
const RESULTS = path.join(ROOT, 'validation', 'results.jsonl')
const REPORT = path.join(ROOT, 'validation', 'report.md')
const PROBE_INDEX = path.join(ROOT, 'cache', 'probe', '01-index.html')
const POLL_LOG = path.join(ROOT, 'poll-log.txt')

const count = (rows, fn) => rows.filter(fn).length
const pct = (n, d) => d ? `${(100 * n / d).toFixed(1)}%` : '-'
const ids = a => (a && a.length ? a.join('+') : '-')
const dl = a => a.length ? `${a.length} (${a.join(', ')})` : '0'

function histogram(values) {
  const h = new Map()
  for (const v of values) h.set(v, (h.get(v) || 0) + 1)
  return [ ...h.entries() ].sort((a, b) => a[0] - b[0])
}

const table = (head, rows) => [
  `| ${head.join(' | ')} |`,
  `|${head.map(() => '---').join('|')}|`,
  ...rows.map(r => `| ${r.join(' | ')} |`),
].join('\n')

/**
 * gurbaninow passes this element's trimmed text to date-fns parse(text, 'dd-MM-yyyy').
 * date-fns rejects any non-whitespace left after the pattern, so a time suffix
 * makes the date Invalid and its later toISOString() throws.
 */
const gnParseWouldThrow = text => !/^\d{1,2}-\d{1,2}-\d{1,4}\s*$/.test(String(text).trim())

function indexCaptures() {
  const out = []
  if (fs.existsSync(PROBE_INDEX)) {
    try {
      const p = parseLatest(fs.readFileSync(PROBE_INDEX, 'utf8'))
      out.push({ source: 'cache/probe/01-index.html', date: p.date, raw: p.timestamp_raw })
    } catch (e) {
      out.push({ source: 'cache/probe/01-index.html', error: e.name })
    }
  }
  if (fs.existsSync(POLL_LOG)) {
    for (const line of fs.readFileSync(POLL_LOG, 'utf8').split('\n').filter(Boolean)) {
      const f = line.split('\t')
      if (f[1] === 'ERROR' || f.length < 5) continue
      out.push({ source: `poll-log ${f[0]}`, date: f[1].split(' ')[0], raw: JSON.parse(f[4]) })
    }
  }
  return out
}

function codepoints(s) {
  return [ ...s ].map(c => `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`).join(' ')
}

function measurements(rows) {
  const ok = rows.filter(r => r.status === 'ok')
  const m = {}
  m.ang_delta = histogram(ok.map(r => r.ang_delta).filter(v => v != null))
  m.cited_minus_last = histogram(ok.map(r => r.cited_minus_last).filter(v => v != null))

  const margins = ok.map(r => r.margin).filter(v => v != null).sort((a, b) => a - b)
  let gap = { size: 0, lo: null, hi: null }
  for (let i = 1; i < margins.length; i++) {
    const d = margins[i] - margins[i - 1]
    if (d > gap.size) gap = { size: d, lo: margins[i - 1], hi: margins[i] }
  }
  const q = p => margins.length ? margins[Math.min(margins.length - 1, Math.floor(margins.length * p))] : null
  m.margin = { n: margins.length, min: margins[0], p05: q(0.05), median: q(0.5), max: margins[margins.length - 1], gap }
  m.margin_bands = histogram(margins.map(v => Math.floor(v * 20) / 20))
  m.margin_near_gate = ok.filter(r => r.margin != null && Math.abs(r.margin - THRESHOLDS.minMargin) < 0.05)
    .map(r => `${r.date} (${r.margin}, ${r.confidence})`)

  const gate = {}
  const bump = (k, f) => { gate[k] = gate[k] || { failing: 0, sole: 0, rescued: 0, high_limit: 0 }; gate[k][f]++ }
  for (const r of ok) {
    if (!r.gates) continue
    for (const g of r.gates.failing) bump(g, 'failing')
    if (r.gates.failing.length === 1) bump(r.gates.failing[0], 'sole')
    for (const g of r.gates.rescued) bump(g, 'rescued')
    for (const g of r.gates.high_limits) bump(g, 'high_limit')
  }
  m.gates = gate
  m.tie_break = ok.filter(r => r.tie_break_decided).map(r => r.date)

  const multiOurs = count(ok, r => r.ids.length > 1)
  const multiGn = count(rows, r => r.gn_ids && r.gn_ids.length > 1)
  m.multi = { ours: multiOurs, ours_of: count(ok, r => r.ids.length > 0), gn: multiGn, gn_of: count(rows, r => r.gn_ids) }

  const parsed = ok
  m.ang_sources = {
    both_equal: count(parsed, r => r.ang_ascii != null && r.ang_gurmukhi != null && r.ang_ascii === r.ang_gurmukhi),
    mismatch_refused: count(rows, r => r.parse_error === 'AngMismatchError'),
    ascii_only: parsed.filter(r => r.ang_ascii != null && r.ang_gurmukhi == null).map(r => r.date),
    gurmukhi_only: parsed.filter(r => r.ang_ascii == null && r.ang_gurmukhi != null).map(r => r.date),
    neither: parsed.filter(r => r.ang_ascii == null && r.ang_gurmukhi == null).map(r => r.date),
  }
  m.medium = ok.filter(r => r.confidence === 'medium').map(r => `${r.date} (${r.gates ? r.gates.high_limits.join(',') : '-'})`)
  m.ang_field_disagree = parsed.filter(r => r.ang_field != null && r.ang != null && r.ang_field !== r.ang)
    .map(r => `${r.date} (field ${r.ang_field}, footer ${r.ang})`)
  m.ang_field_missing = count(parsed, r => r.ang_field == null)
  m.devanagari = { days: count(parsed, r => r.devanagari_digits > 0), digits: parsed.reduce((a, r) => a + (r.devanagari_digits || 0), 0) }
  m.date_mismatch = rows.filter(r => r.parse_error === 'DateMismatchError').map(r => r.date)
  m.parse_errors = histogram(rows.filter(r => r.parse_error).map(r => r.parse_error))
  m.captures = indexCaptures()
  return m
}

function revCell(rev) {
  if (!rev) return '-'
  return Object.entries(rev).map(([ id, v ]) => `${id} ${v ?? 'n/a'}`).join(', ')
}

function buildReport(rows, { list = 'validation/dates.txt' } = {}) {
  const m = measurements(rows)
  const ok = rows.filter(r => r.status === 'ok')
  const classes = [ 'AGREE', 'REFUSED', 'SUBSET', 'SUPERSET', 'DIFFERENT', 'NO_REFERENCE', 'NOT_CACHED' ]
  const L = []

  L.push('# Validation report')
  L.push('')
  L.push(`Generated by \`bin/validate.js\` from cached SGPC archive responses for the ${rows.length} dates in \`${list}\`, ` +
    'compared with `gurbaninow/hukamnama-archive`. Corpus `@shabados/database@4.8.7`, SGGS only. Ids and numbers only.')
  L.push('')

  L.push('## Agreement')
  L.push('')
  L.push(table([ 'class', 'days', 'share', 'high', 'medium', 'low / parse refused' ], classes
    .map(c => [ c, rows.filter(r => r.class === c) ])
    .filter(([ , rs ]) => rs.length)
    .map(([ c, rs ]) => [ c, rs.length, pct(rs.length, rows.length),
      count(rs, r => r.confidence === 'high'), count(rs, r => r.confidence === 'medium'),
      count(rs, r => r.confidence === 'low' || r.parse_error) ])))
  L.push('')
  const graded = ok.filter(r => r.ids.length)
  L.push(`Graded high or medium: ${graded.length}. Of those, agreeing with gurbaninow: ${count(graded, r => r.class === 'AGREE')}.`)
  const kw = rows.filter(r => r.attribution && /KNOWN-WRONG/.test(r.attribution.label))
  const un = rows.filter(r => r.attribution && r.attribution.label === 'unattributed')
  L.push(`KNOWN-WRONG: ${kw.length}${kw.length ? ` (${kw.map(r => r.date).join(', ')})` : ''}. ` +
    `Unattributed: ${un.length}${un.length ? ` (${un.map(r => r.date).join(', ')})` : ''}.`)
  L.push('')

  L.push('## Disagreements')
  L.push('')
  const dis = rows.filter(r => r.class !== 'AGREE' && r.class !== 'NOT_CACHED')
  if (!dis.length) L.push('None.')
  else {
    L.push('Forward scores are coverage/avg of the page lines against that id set (reaches at ' +
      `${THRESHOLDS.highCoverage}/${THRESHOLDS.lineStrong}). Reverse coverage is the share of each shabad's corpus lines found on the page.`)
    L.push('')
    L.push(table([ 'date', 'class', 'ours (grade)', 'candidate', 'gn', 'attribution', 'fwd ours', 'fwd gn', 'reverse coverage', 'notes' ],
      dis.map(r => {
        const a = r.attribution || {}
        return [ r.date, r.class, `${ids(r.ids)} (${r.confidence || r.parse_error || '-'})`, ids(r.candidate_ids), ids(r.gn_ids),
          a.label || '-',
          a.fwd_ours ? `${a.fwd_ours.coverage}/${a.fwd_ours.avg}` : '-',
          a.fwd_gn ? `${a.fwd_gn.coverage}/${a.fwd_gn.avg}` : '-',
          revCell(a.rev) + (a.neighbour_rev && Object.keys(a.neighbour_rev).length ? `; adjacent: ${revCell(a.neighbour_rev)}` : ''),
          [ ...(a.tags || []), r.reason ? `reason ${r.reason}` : '', r.gates && r.gates.failing.length ? `failed ${r.gates.failing.join(',')}` : '',
            r.parse_error ? r.parse_error : '' ].filter(Boolean).join('; ') || '-' ]
      })))
  }
  L.push('')

  L.push('## Needs review')
  L.push('')
  const rev = rows.filter(r => r.attribution && r.attribution.review && r.attribution.review.length)
  if (!rev.length) L.push('None.')
  else {
    L.push(`Days with a reverse coverage in [0.2, 0.8). Not auto-classified. "below 0.5" marks values the not-read rule would otherwise catch.`)
    L.push('')
    L.push(table([ 'date', 'class', 'ours (grade)', 'gn', 'shabad', 'side', 'reverse coverage', 'below 0.5' ],
      rev.flatMap(r => r.attribution.review.map(x => [ r.date, r.class, `${ids(r.ids)} (${r.confidence})`, ids(r.gn_ids), x.id, x.side, x.rev, x.below_not_read ? 'yes' : '' ]))))
  }
  L.push('')

  L.push('## Multi-shabad days')
  L.push('')
  const multi = rows.filter(r => (r.gn_ids && r.gn_ids.length > 1) || (r.candidate_ids && r.candidate_ids.length > 1))
  L.push(table([ 'date', 'class', 'ours (grade)', 'gn', 'gn angs', 'reverse coverage' ], multi.map(r => [
    r.date, r.class, `${ids(r.ids)} (${r.confidence || r.parse_error})`, ids(r.gn_ids),
    r.gn_angs ? Object.entries(r.gn_angs).map(([ id, a ]) => `${id} ${a.start}-${a.end}`).join(', ') : '-',
    revCell(r.reverse || (r.attribution && r.attribution.rev)) ])))
  L.push('')

  L.push('## Refused days')
  L.push('')
  const refused = rows.filter(r => r.class === 'REFUSED')
  if (!refused.length) L.push('None.')
  else L.push(table([ 'date', 'reason', 'score', 'margin', 'coverage', 'ang_delta', 'counter_lines' ], refused.map(r => [
    r.date, r.parse_error || r.reason || (r.gates ? r.gates.failing.join(',') : '-'),
    r.score ?? '-', r.margin ?? '-', r.coverage ?? '-', r.ang_delta ?? '-', r.counter_lines ?? '-' ])))
  L.push('')

  L.push('## Measurements')
  L.push('')
  L.push('### ang_delta (cited minus corpus start ang)')
  L.push('')
  L.push(table([ 'delta', 'days' ], m.ang_delta))
  L.push('')
  L.push('### cited minus last ang of the reading')
  L.push('')
  L.push(table([ 'value', 'days' ], m.cited_minus_last))
  L.push('')
  L.push('### margin')
  L.push('')
  L.push(`n=${m.margin.n}  min=${m.margin.min}  p05=${m.margin.p05}  median=${m.margin.median}  max=${m.margin.max}. ` +
    `Widest empty band: ${m.margin.gap.lo} to ${m.margin.gap.hi} (width ${m.margin.gap.size.toFixed(3)}). minMargin is ${THRESHOLDS.minMargin}.`)
  L.push('')
  L.push(table([ 'band (lower edge, width 0.05)', 'days' ], m.margin_bands.map(([ b, n ]) => [ b.toFixed(2), n ])))
  L.push('')
  L.push(`Within 0.05 of minMargin: ${m.margin_near_gate.length ? m.margin_near_gate.join(', ') : 'none'}.`)
  L.push('')
  L.push('### gates')
  L.push('')
  L.push('"failing" counts days that failed the gate, "sole" days where it was the only failing gate, ' +
    '"rescued" days the counter override let through, "high_limit" medium days held below high by that check.')
  L.push('')
  L.push(table([ 'gate', 'failing', 'sole', 'rescued', 'high_limit' ],
    [ 'minCoverage', 'lineMatch', 'minMargin', 'counter_override', 'veto_maxAngDelta', 'veto_minAngDeltaSggs',
      'veto_maxAngPastEndSggs', 'query_too_short', 'highCoverage', 'lineStrong', 'counter_agrees' ]
      .map(g => { const x = m.gates[g] || {}; return [ g, x.failing || 0, x.sole || 0, x.rescued || 0, x.high_limit || 0 ] })))
  L.push('')
  L.push(`Tie-break (result changes when the ang is withheld): ${m.tie_break.length}${m.tie_break.length ? ` (${m.tie_break.join(', ')})` : ''}.`)
  L.push('')
  L.push('### other counts')
  L.push('')
  L.push(`- Multi-shabad rate: ours ${m.multi.ours}/${m.multi.ours_of} (${pct(m.multi.ours, m.multi.ours_of)}), gurbaninow ${m.multi.gn}/${m.multi.gn_of} (${pct(m.multi.gn, m.multi.gn_of)}). The date list deliberately over-samples gurbaninow multi-id days.`)
  L.push(`- English vs Gurmukhi footer ang: both present and equal ${m.ang_sources.both_equal}, mismatch (refused) ${m.ang_sources.mismatch_refused}, English only ${dl(m.ang_sources.ascii_only)}, Gurmukhi only ${dl(m.ang_sources.gurmukhi_only)}, neither ${dl(m.ang_sources.neither)}.`)
  L.push(`- Medium days and what held them below high: ${dl(m.medium)}.`)
  L.push(`- ang_field (the record's own ang column) disagreeing with the footer ang: ${m.ang_field_disagree.length}${m.ang_field_disagree.length ? ` (${m.ang_field_disagree.join(', ')})` : ''}. Missing: ${m.ang_field_missing}.`)
  L.push(`- Devanagari digits: ${m.devanagari.digits} digits on ${m.devanagari.days} days.`)
  L.push(`- DateMismatch: ${m.date_mismatch.length}${m.date_mismatch.length ? ` (${m.date_mismatch.join(', ')})` : ''}.`)
  L.push(`- Parse errors: ${m.parse_errors.length ? m.parse_errors.map(([ k, n ]) => `${k} ${n}`).join(', ') : 'none'}.`)
  L.push('')

  L.push('## gurbaninow date parse on the SGPC timestamp')
  L.push('')
  L.push('gurbaninow reads the first `.customDate` matching `\\d{1,2}-\\d{1,2}-\\d{4}`, trims it, and passes it to ' +
    "date-fns `parse(text, 'dd-MM-yyyy')`. date-fns returns Invalid Date when non-whitespace remains after the pattern, " +
    'and index.js then throws on `toISOString()`, falling back to SikhNet. Archive responses carry no timestamp, so this is ' +
    'counted over index.php captures only; archive days are N/A. The throw follows from reading gurbaninow lib/sgpc.js and index.js; ' +
    'date-fns is not installed in that clone, so it was not executed. The capture itself is checked byte by byte below.')
  L.push('')
  L.push(table([ 'capture', 'page date', 'UTF-8 bytes', 'code points', 'code point dump', 'gn parse would throw' ],
    m.captures.map(c => c.error ? [ c.source, '-', '-', '-', c.error, '-' ] : [
      c.source, c.date, Buffer.byteLength(c.raw, 'utf8'), [ ...c.raw ].length, codepoints(c.raw),
      gnParseWouldThrow(c.raw) ? 'yes' : 'no' ])))
  L.push('')
  L.push(`Would throw: ${count(m.captures, c => c.raw && gnParseWouldThrow(c.raw))} of ${m.captures.length} captures.`)
  L.push('')

  L.push('## Source quirks')
  L.push('')
  L.push('- The archive endpoint is `hssearchhukmanamaTestCalender.php` (POST `selected_date=YYYY-MM-DD`), so its "Test" name is part of the contract.')
  L.push('- The English ang label varies between `(Page: N)` and `(Ang: N)`.')
  L.push('- The index.php timestamp has a double space before the time (`DD-MM-YYYY  HH:MM AM`).')
  L.push('- The timestamp is the reading time, not the posting time; the page keeps the previous day until SGPC posts.')
  L.push('- A day with nothing published returns HTTP 200 with `supported:false`.')
  L.push('- No cookie is set or needed.')
  L.push('')

  L.push('## Known issues carried over from Hazur Sahib, deliberately unfixed')
  L.push('')
  L.push('- `stripAngSuffix` builds its regex from a template literal containing `\\s`, which becomes a literal `s`. It still strips an ang suffix written without spaces; the SGPC path passes the ang through `opts.ang` and never relies on it.')
  L.push('- `extractCounters` misses chained counters: counter 4 followed directly by counter 2, sharing the middle double danda, yields `[4]`, not `[4, 2]`.')
  L.push('')
  return L.join('\n')
}

function writeReport(rows, opts) {
  fs.writeFileSync(REPORT, buildReport(rows, opts))
  return REPORT
}

if (require.main === module) {
  const file = process.argv[2] || RESULTS
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
  const m = measurements(rows)
  console.log(JSON.stringify({ ...m, captures: m.captures.length }, null, 2))
  console.error(`wrote ${path.relative(process.cwd(), writeReport(rows))}`)
}

module.exports = { buildReport, writeReport, measurements, gnParseWouldThrow }
