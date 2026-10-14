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
 */

const fs = require('fs')
const path = require('path')
const { Resolver, SOURCE_SGGS } = require('../lib/resolve')
const { fetchLatestHtml, parseLatest, todayIST } = require('../lib/scrape')
const { pack } = require('../lib/pack')
const { datedPath, writeDay, writeLatest } = require('../lib/write')

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

/** @returns {Promise<number>} the process exit code */
async function run({
  fetchHtml = fetchLatestHtml,
  today = todayIST,
  env = process.env,
  archiveDir = ARCHIVE_DIR,
  makeResolver = defaultResolver,
  corpusVersion = CORPUS_VERSION,
  log = msg => console.error(msg),
} = {}) {
  const page = parseLatest(String(await fetchHtml()))
  const date = today()

  if (page.date !== date) {
    log(`not_yet ${page.date}`)
    return env.FINAL_RUN === '1' ? 1 : 0
  }

  const r = makeResolver().resolve(page.heading, page.bani, SOURCE_SGGS, { ang: page.ang })
  log(
    `${date}\tSGGS\t${(r.shabad_ids || []).join('+') || '-'}\tscore=${r.score}\tmargin=${r.margin}\t` +
    `ang=${r.ang_scraped}/${r.ang_corpus}\tΔ=${r.ang_delta}\t${r.confidence}`
  )

  // SGGS is the whole reading. If it did not resolve, buildPayload throws.
  const payload = buildPayload(date, { sggs: r }, corpusVersion)

  const file = datedPath(archiveDir, date)
  if (fs.existsSync(file)) {
    const prev = JSON.parse(fs.readFileSync(file, 'utf8'))
    const prevIds = JSON.stringify(prev.shabad_ids)
    if (prevIds !== JSON.stringify(payload.shabad_ids)) {
      log(`WARNING: ${date} already published as ${prevIds}, now ${JSON.stringify(payload.shabad_ids)}`)
    }
  }
  writeDay(archiveDir, payload)
  log(`wrote ${path.relative(process.cwd(), file)}`)

  writeLatest(archiveDir, payload)
  log(`wrote ${path.relative(process.cwd(), path.join(archiveDir, 'latest.json'))}`)
  return 0
}

if (require.main === module) {
  run().then(code => process.exit(code), err => {
    console.error(`FAILED: ${err.message}`)
    process.exit(1)
  })
}

module.exports = { buildPayload, run }
