#!/usr/bin/env node
'use strict'

/**
 * Fetches archive responses for a list of dates into cache/archive/, for
 * offline validation only. Never writes to archive/.
 *
 *   node bin/harvest-validation.js validation/dates.txt
 *
 *  1. Cache-first. A cached date is never requested again, whatever it holds;
 *     an empty-day or wrong-date answer is data and is cached as received.
 *  2. Resumable and SIGINT-safe. Ctrl-C finishes the current date and stops.
 *  3. Stops after 3 consecutive failed attempts (retries included) and at once
 *     on 403 or 429, since either means the server wants us gone.
 *
 * Env:
 *   CACHE_DIR      default ./cache/archive
 *   SGPC_DELAY_MS  may raise the 3000 ms floor between requests, never lower it
 */

const fs = require('fs')
const path = require('path')
const {
  fetchArchiveRaw, parseArchiveForDate, HttpError, requestCount,
} = require('../lib/scrape')
const { cachePath, writeCache } = require('../lib/cache')

const CACHE_DIR = process.env.CACHE_DIR || path.join(__dirname, '..', 'cache', 'archive')
const MAX_RETRIES = 2
const MAX_CONSECUTIVE_FAILURES = 3
const BACKOFF_MS = 10_000

const sleep = ms => new Promise(r => setTimeout(r, ms))

function readDates(file) {
  return fs.readFileSync(file, 'utf8').split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
}

/** One line of outcome per date. Names the error class only, never the text. */
function describe(raw, date) {
  try {
    const r = parseArchiveForDate(raw.toString('utf8'), date)
    return `ok ang=${r.ang ?? '-'} bani_len=${r.bani.length}`
  } catch (e) {
    return e.name
  }
}

async function main() {
  const listFile = process.argv[2]
  if (!listFile) {
    console.error('usage: harvest-validation.js <date-list-file>')
    process.exit(2)
  }
  const dates = readDates(listFile)
  for (const d of dates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`bad date in list: ${d}`)
  }

  let stopping = false
  process.on('SIGINT', () => {
    console.error('\nStopping after this date. Re-run the same command to resume.')
    stopping = true
  })

  let fetched = 0, cached = 0, consecutiveFailures = 0
  console.error(`${dates.length} dates, cache ${CACHE_DIR}`)

  for (let i = 0; i < dates.length && !stopping; i++) {
    const date = dates[i]
    const tag = `[${i + 1}/${dates.length}] ${date}`
    const cp = cachePath(CACHE_DIR, date)
    if (fs.existsSync(cp)) {
      cached++
      console.error(`${tag}  (cached) ${describe(fs.readFileSync(cp), date)}`)
      continue
    }

    let raw = null
    for (let attempt = 0; attempt <= MAX_RETRIES && raw == null; attempt++) {
      if (attempt > 0) await sleep(BACKOFF_MS * Math.pow(3, attempt - 1))
      try {
        raw = await fetchArchiveRaw(date)
        consecutiveFailures = 0
      } catch (err) {
        consecutiveFailures++
        console.error(`${tag}  attempt ${attempt + 1} failed: ${err.message}`)
        if (err instanceof HttpError && (err.status === 403 || err.status === 429)) {
          console.error(`STOP: server answered ${err.status}`)
          process.exit(1)
        }
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.error(`STOP: ${MAX_CONSECUTIVE_FAILURES} consecutive failed attempts`)
          process.exit(1)
        }
      }
    }
    if (raw == null) continue

    writeCache(CACHE_DIR, date, raw)
    fetched++
    console.error(`${tag}  ${describe(raw, date)}`)
  }

  console.error(`\nfetched ${fetched}, from cache ${cached}, requests made ${requestCount()}`)
}

main().catch(e => { console.error('FATAL:', e); process.exit(1) })
