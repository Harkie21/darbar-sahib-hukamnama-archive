#!/usr/bin/env node
'use strict'

/**
 * Fetches the hukamnamasahib.com morning page for each date in a list into
 * cache/hns/, for offline cross-checking only. Never writes to archive/.
 *
 *   node bin/harvest-hns.js validation/dates.txt
 *
 *  1. Cache-first. Each URL is fetched at most once, whatever it returned.
 *     A probe capture in cache/probe-hns/ is reused byte for byte.
 *  2. No retries. Stops after 3 consecutive failures and at once on 403 or 429.
 *  3. At least 3000 ms between requests (HNS_DELAY_MS may only raise it).
 */

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { fetchMorningRaw, parseMorningResponse, requestCount } = require('../lib/hns')

const CACHE_DIR = process.env.HNS_CACHE_DIR || path.join(__dirname, '..', 'cache', 'hns')
const PROBE_DIR = path.join(__dirname, '..', 'cache', 'probe-hns')
const MAX_CONSECUTIVE_FAILURES = 3

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex')
const pagePath = (dir, date) => path.join(dir, `${date}-morning.html`)
// A non-200 answer is cached too so the URL is never asked again.
const statusPath = (dir, date) => path.join(dir, `${date}-morning.status`)

function readDates(file) {
  return fs.readFileSync(file, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
}

/** The cached response for a date, or null when it has never been fetched. */
function readCached(dir, date) {
  const file = pagePath(dir, date)
  if (!fs.existsSync(file)) return null
  const sp = statusPath(dir, date)
  const status = fs.existsSync(sp) ? Number(fs.readFileSync(sp, 'utf8').trim()) : 200
  return { status, body: fs.readFileSync(file) }
}

/** One line of outcome per date. Names the error class only, never the text. */
function describe(res, date) {
  try {
    const r = parseMorningResponse(res, date)
    return `ok ang=${r.ang ?? '-'} bani_len=${r.bani.length}`
  } catch (e) {
    return e.name
  }
}

async function main() {
  const listFile = process.argv[2]
  if (!listFile) {
    console.error('usage: harvest-hns.js <date-list-file>')
    process.exit(2)
  }
  const dates = readDates(listFile)
  for (const d of dates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`bad date in list: ${d}`)
  }
  fs.mkdirSync(CACHE_DIR, { recursive: true })

  let stopping = false
  process.on('SIGINT', () => {
    console.error('\nStopping after this date. Re-run the same command to resume.')
    stopping = true
  })

  let fetched = 0, cached = 0, reused = 0, consecutiveFailures = 0
  console.error(`${dates.length} dates, cache ${CACHE_DIR}`)

  for (let i = 0; i < dates.length && !stopping; i++) {
    const date = dates[i]
    const tag = `[${i + 1}/${dates.length}] ${date}`
    const target = pagePath(CACHE_DIR, date)

    const probe = pagePath(PROBE_DIR, date)
    if (!fs.existsSync(target) && fs.existsSync(probe)) {
      const src = fs.readFileSync(probe)
      fs.copyFileSync(probe, target)
      if (sha256(fs.readFileSync(target)) !== sha256(src)) throw new Error(`probe copy differs for ${date}`)
      reused++
      console.error(`${tag}  (probe reused, sha256 ${sha256(src).slice(0, 12)}) ${describe({ status: 200, body: src }, date)}`)
      continue
    }

    const hit = readCached(CACHE_DIR, date)
    if (hit) {
      cached++
      console.error(`${tag}  (cached) ${describe(hit, date)}`)
      continue
    }

    let res
    try {
      res = await fetchMorningRaw(date)
    } catch (err) {
      consecutiveFailures++
      console.error(`${tag}  failed: ${err.message}`)
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.error(`STOP: ${MAX_CONSECUTIVE_FAILURES} consecutive failures`)
        process.exit(1)
      }
      continue
    }
    if (res.status === 403 || res.status === 429) {
      console.error(`${tag}  STOP: server answered ${res.status}`)
      process.exit(1)
    }
    fs.writeFileSync(target, res.body)
    if (res.status !== 200) fs.writeFileSync(statusPath(CACHE_DIR, date), `${res.status}\n`)
    fetched++
    if (res.status === 200 || res.status === 404) consecutiveFailures = 0
    else if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      console.error(`${tag}  http ${res.status}\nSTOP: ${MAX_CONSECUTIVE_FAILURES} consecutive failures`)
      process.exit(1)
    }
    console.error(`${tag}  http ${res.status} ${describe(res, date)}`)
  }

  console.error(`\nfetched ${fetched}, from cache ${cached}, probe reused ${reused}, requests made ${requestCount()}`)
}

if (require.main === module) main().catch(e => { console.error('FATAL:', e); process.exit(1) })

module.exports = { readCached, pagePath }
