#!/usr/bin/env node
'use strict'

/**
 * Measures when SGPC actually posts the day's mukhvaak. Reads index.php every
 * 30 minutes, at most 16 times, and appends one line per request to
 * poll-log.txt. Never resolves and never writes to archive/.
 *
 *   node bin/poll-latest.js
 *
 * Line format (tab separated):
 *   utc_time  page_date page_time  ang  bani_len  timestamp_raw(JSON)  timestamp_codepoints
 * or, on failure:
 *   utc_time  ERROR  error_name  message
 */

const fs = require('fs')
const path = require('path')
const { fetchLatestHtml, parseLatest } = require('../lib/scrape')

const LOG = path.join(__dirname, '..', 'poll-log.txt')
const INTERVAL_MS = 30 * 60 * 1000
const MAX_REQUESTS = 16
const MAX_CONSECUTIVE_FAILURES = 3

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  let stopping = false
  process.on('SIGINT', () => {
    console.error('\nStopping after this request.')
    stopping = true
  })

  let consecutiveFailures = 0
  for (let i = 1; i <= MAX_REQUESTS && !stopping; i++) {
    const utc = new Date().toISOString()
    let line
    try {
      const page = parseLatest((await fetchLatestHtml()).toString('utf8'))
      consecutiveFailures = 0
      line = [
        utc, `${page.date} ${page.time ?? '-'}`, page.ang ?? '-', page.bani.length,
        JSON.stringify(page.timestamp_raw), [ ...page.timestamp_raw ].length,
      ].join('\t')
    } catch (err) {
      consecutiveFailures++
      line = [ utc, 'ERROR', err.name, err.message ].join('\t')
    }
    fs.appendFileSync(LOG, line + '\n')
    console.error(`[${i}/${MAX_REQUESTS}] ${line}`)

    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      console.error(`${MAX_CONSECUTIVE_FAILURES} consecutive failures, stopping.`)
      process.exit(1)
    }
    if (i < MAX_REQUESTS && !stopping) {
      // Short slices so SIGINT does not have to wait out the full interval.
      const until = Date.now() + INTERVAL_MS
      while (!stopping && Date.now() < until) await sleep(Math.min(5000, until - Date.now()))
    }
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1) })
