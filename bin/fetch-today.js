#!/usr/bin/env node
'use strict'

/**
 * Daily job. Reads hs.sgpc.net/index.php, resolves the mukhvaak against the
 * pinned Shabad OS corpus, writes archive/YYYY/MM/DD.json and latest.json.
 *
 * Writes NOTHING unless the page shows today's IST date and SGGS resolved.
 * A missing file is a clean 404 the client already handles; a wrong file is
 * wrong Gurbani in front of someone.
 *
 * The page keeps showing the previous day until SGPC posts, so a stale page
 * is "not yet", not a failure. FINAL_RUN=1 marks the last attempt of the day,
 * where still being stale must go red.
 *
 * Every run prints one JSON line to stdout (and the step summary) saying
 * what happened: written, unchanged, replaced, not_yet or refused.
 */

const fs = require('fs')
const path = require('path')
const { Resolver, SOURCE_SGGS } = require('../lib/resolve')
const { fetchLatestHtml, parseLatest, todayIST } = require('../lib/scrape')
const { pack } = require('../lib/pack')
const { serialize, datedPath, writeDay, writeLatest } = require('../lib/write')

const DB_PATH = process.env.SHABADOS_DB
  || 'node_modules/@shabados/database/build/database.sqlite'
const CORPUS_VERSION = process.env.SHABADOS_VERSION || '4.8.7'
const ARCHIVE_DIR = process.env.ARCHIVE_DIR || path.join(__dirname, '..', 'archive')

// Pure and side-effect free so a failed SGGS resolution never reaches a
// write call — buildPayload throws before run() gets anywhere near
// writeDay/writeLatest.
function buildPayload(date, results, corpusVersion) {
  if (!results.sggs || !results.sggs.ok) {
    throw new Error(`sggs_unresolved: ${results.sggs ? results.sggs.confidence : 'missing'}`)
  }
  return {
    date,
    source: 'darbar_sahib',
    // Mirrors gurbaninow/hukamnama-archive so a client written against that
    // format works here unmodified.
    shabad_ids: results.sggs.shabad_ids,
    sggs: pack(results.sggs),
    // Present but null so the key set matches the Hazur Sahib archive exactly.
    dsg: null,
    corpus: { name: '@shabados/database', version: corpusVersion },
  }
}

function defaultResolver() {
  if (!fs.existsSync(DB_PATH)) {
    throw new Error(`corpus not found at ${DB_PATH} — set SHABADOS_DB`)
  }
  return new Resolver(DB_PATH)
}

/** One run log line. Fixed key order so the line reads the same on every run. */
function logLine({ run_utc, page_date = null, page_time = null, outcome, shabad_ids = null,
  confidence = null, reason, previous_ids }) {
  const entry = { run_utc, page_date, page_time, outcome, shabad_ids, confidence }
  if (outcome === 'refused') entry.reason = reason
  if (outcome === 'replaced') entry.previous_ids = previous_ids
  return JSON.stringify(entry)
}

/** @returns {Promise<number>} the process exit code */
async function run({
  fetchHtml = fetchLatestHtml,
  today = todayIST,
  env = process.env,
  archiveDir = ARCHIVE_DIR,
  makeResolver = defaultResolver,
  corpusVersion = CORPUS_VERSION,
  log = msg => console.error(msg),
  now = () => new Date(Date.now()).toISOString(),
  // Synchronous so process.exit() right after cannot drop the line on a pipe.
  out = line => fs.writeSync(1, line + '\n'),
} = {}) {
  const fields = { run_utc: now() }
  // The run log never reaches archive/ so re-runs still reproduce identical bytes there.
  const report = extra => {
    const line = logLine({ ...fields, ...extra })
    out(line)
    if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, line + '\n')
  }

  const attempt = async () => {
    const page = parseLatest(String(await fetchHtml()))
    fields.page_date = page.date
    fields.page_time = page.time
    const date = today()

    if (page.date !== date) {
      log(`not_yet ${page.date}`)
      return { code: env.FINAL_RUN === '1' ? 1 : 0, entry: { outcome: 'not_yet' } }
    }

    const r = makeResolver().resolve(page.heading, page.bani, SOURCE_SGGS, { ang: page.ang })
    fields.shabad_ids = r.shabad_ids || []
    fields.confidence = r.confidence
    log(
      `${date}\tSGGS\t${(r.shabad_ids || []).join('+') || '-'}\tscore=${r.score}\tmargin=${r.margin}\t` +
      `ang=${r.ang_scraped}/${r.ang_corpus}\tΔ=${r.ang_delta}\t${r.confidence}`
    )

    // SGGS is the whole reading. If it did not resolve, buildPayload throws.
    const payload = buildPayload(date, { sggs: r }, corpusVersion)

    const file = datedPath(archiveDir, date)
    let outcome = 'written'
    let previousIds
    if (fs.existsSync(file)) {
      const before = fs.readFileSync(file, 'utf8')
      const prev = JSON.parse(before)
      const prevIds = JSON.stringify(prev.shabad_ids)
      if (prevIds !== JSON.stringify(payload.shabad_ids)) {
        log(`WARNING: ${date} already published as ${prevIds}, now ${JSON.stringify(payload.shabad_ids)}`)
      }
      if (before === serialize(payload)) {
        outcome = 'unchanged'
      } else {
        outcome = 'replaced'
        previousIds = prev.shabad_ids ?? null
      }
    }
    writeDay(archiveDir, payload)
    log(`wrote ${path.relative(process.cwd(), file)}`)

    writeLatest(archiveDir, payload)
    log(`wrote ${path.relative(process.cwd(), path.join(archiveDir, 'latest.json'))}`)
    return { code: 0, entry: { outcome, previous_ids: previousIds } }
  }

  let result
  try {
    result = await attempt()
  } catch (err) {
    report({ outcome: 'refused', reason: err.message })
    throw err
  }
  report(result.entry)
  return result.code
}

if (require.main === module) {
  run().then(code => process.exit(code), err => {
    console.error(`FAILED: ${err.message}`)
    process.exit(1)
  })
}

module.exports = { buildPayload, run, logLine }
