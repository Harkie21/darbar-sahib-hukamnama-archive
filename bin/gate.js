#!/usr/bin/env node
'use strict'

/**
 * Pre-push gate. Each check prints PASS or FAIL and any FAIL exits 1.
 * Usage: node bin/gate.js [repo root], defaulting to this repository.
 */

const fs = require('fs')
const path = require('path')
const { execFileSync, spawnSync } = require('child_process')

const CRONS = [ '37 2 * * *', '7 4 * * *', '37 5 * * *', '7 8 * * *', '7 11 * * *' ]
const FINAL_CRON = '7 11 * * *'
const ARCHIVE_NOTE = 'expected before first push only; once the daily job has published, this check fails by design'

// Built from pieces so this file and its test never match their own search.
const ATTRIBUTION = new RegExp([ 'cl' + 'aude', 'anthr' + 'opic', 'co-' + 'authored' ].join('|'), 'i')
const TRANSLATION_KEY = /desc|english|^e(heading|hukamnama|footer)/i
const LATIN_RUN = /\p{Script=Latin}[\p{Script=Latin} ,.;:!?-]*\p{Script=Latin}/gu
// The hukamnamasahib.com page title is the one long Latin phrase a real fixture needs.
const TITLE_ALLOW = /^(Amrit Vele Da|Sandhiya Vele Da|Sangrand) Hukamnama Sri Darbar Sahib, Amritsar/
// Dandas sit in the Devanagari block but belong to Gurmukhi text too.
const DEVANAGARI = /[\u0900-\u0963\u0966-\u097F]/
// Opens the Punjabi explanation on hukamnamasahib.com.
const EXPLANATION = '\u0A05\u0A30\u0A25'
const GURMUKHI = /[਀-੿]/
// Whitespace or a danda may separate words so a pasted pankti counts as one run.
const GURMUKHI_SIX_WORDS = /[਀-੿‌‍]+(?:[\s।॥]+[਀-੿‌‍]+){5,}/

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 })
const tracked = root => git(root, [ 'ls-files', '-z' ]).split('\0').filter(Boolean)
const readIf = (root, rel) => {
  const file = path.join(root, rel)
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
}

function walk(dir, base) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const rel = path.posix.join(base, e.name)
    return e.isDirectory() ? walk(path.join(dir, e.name), rel) : [ rel ]
  })
}

/** Each check returns null on pass or a short failure detail. */
const CHECKS = [
  {
    name: 'archive/ holds no dated files and no latest.json',
    run(root) {
      const files = new Set([ ...tracked(root).filter(f => f.startsWith('archive/')), ...walk(path.join(root, 'archive'), 'archive') ])
      const bad = [ ...files ].filter(f => f === 'archive/latest.json' || /^archive\/\d{4}\/\d{2}\/\d{2}\.json$/.test(f)).sort()
      return bad.length ? `${bad.join(', ')} (${ARCHIVE_NOTE})` : null
    },
  },
  {
    name: 'nothing tracked under cache/, no poll-log.txt, no validation/results.jsonl',
    run(root) {
      const bad = tracked(root).filter(f =>
        f.startsWith('cache/') || path.posix.basename(f) === 'poll-log.txt' || f === 'validation/results.jsonl')
      return bad.length ? bad.join(', ') : null
    },
  },
  {
    name: 'no Gurmukhi in validation/report.md, no 6-word Gurmukhi line in README.md',
    run(root) {
      const problems = []
      const report = readIf(root, 'validation/report.md')
      if (report != null) {
        report.split('\n').forEach((line, i) => {
          if (GURMUKHI.test(line)) problems.push(`validation/report.md:${i + 1}`)
        })
      }
      const readme = readIf(root, 'README.md')
      if (readme != null) {
        readme.split('\n').forEach((line, i) => {
          if (GURMUKHI_SIX_WORDS.test(line)) problems.push(`README.md:${i + 1}`)
        })
      }
      return problems.length ? problems.join(', ') : null
    },
  },
  {
    name: 'test fixtures hold no translation keys, Devanagari, explanation or Latin run over 40 chars',
    run(root) {
      const problems = []
      for (const f of tracked(root).filter(f => f.startsWith('test/fixtures'))) {
        const text = readIf(root, f)
        if (text == null) continue
        for (const m of text.matchAll(/"((?:[^"\\]|\\.)*)"\s*:/g)) {
          if (TRANSLATION_KEY.test(m[1])) problems.push(`${f} key ${m[1]}`)
        }
        for (const m of text.matchAll(LATIN_RUN)) {
          const allowed = m[0].match(TITLE_ALLOW)
          const run = allowed ? m[0].slice(allowed[0].length) : m[0]
          if (run.length > 40) problems.push(`${f} Latin run of ${run.length}: ${JSON.stringify(run.slice(0, 40))}`)
        }
        const deva = text.match(DEVANAGARI)
        if (deva) problems.push(`${f} Devanagari U+${deva[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`)
        if (text.includes(EXPLANATION)) problems.push(`${f} explanation marker`)
      }
      return problems.length ? problems.join('; ') : null
    },
  },
  {
    name: 'no attribution strings in tracked files or commit messages',
    run(root) {
      const problems = []
      for (const f of tracked(root)) {
        const text = readIf(root, f)
        if (text != null && ATTRIBUTION.test(text)) problems.push(f)
      }
      const commits = git(root, [ 'log', '--format=%h%x1f%B%x1e' ]).split('\x1e').map(s => s.trim()).filter(Boolean)
      for (const c of commits) {
        const [ hash, message ] = c.split('\x1f')
        if (ATTRIBUTION.test(message)) problems.push(`commit ${hash}`)
      }
      return problems.length ? problems.join(', ') : null
    },
  },
  {
    name: 'every commit not by hukamnama-bot has a body',
    run(root) {
      const commits = git(root, [ 'log', '--format=%h%x1f%an%x1f%b%x1e' ]).split('\x1e').map(s => s.trim()).filter(Boolean)
      const bad = commits.map(c => c.split('\x1f'))
        .filter(([ , author, body ]) => author !== 'hukamnama-bot' && !(body || '').trim())
        .map(([ hash ]) => hash)
      return bad.length ? `no body: ${bad.join(', ')}` : null
    },
  },
  {
    name: 'schema test passes',
    run(root) {
      if (!fs.existsSync(path.join(root, 'test', 'schema.test.js'))) return 'test/schema.test.js missing'
      const r = spawnSync(process.execPath, [ 'test/schema.test.js' ], { cwd: root, encoding: 'utf8' })
      return r.status === 0 ? null : `exit ${r.status}`
    },
  },
  {
    name: 'daily.yml has the five crons and FINAL_RUN names the last one once',
    run(root) {
      const yml = readIf(root, '.github/workflows/daily.yml')
      if (yml == null) return '.github/workflows/daily.yml missing'
      const crons = [ ...yml.matchAll(/^\s*-\s*cron:\s*'([^']*)'\s*$/gm) ].map(m => m[1])
      if (JSON.stringify(crons) !== JSON.stringify(CRONS)) return `crons are ${JSON.stringify(crons)}`
      const finalLines = yml.split('\n').filter(l => /^\s*FINAL_RUN:/.test(l))
      if (finalLines.length !== 1) return `${finalLines.length} FINAL_RUN lines`
      const quoted = `'${FINAL_CRON}'`
      const inFinal = finalLines[0].split(quoted).length - 1
      if (inFinal !== 1 || !finalLines[0].includes(`github.event.schedule == ${quoted}`)) {
        return `FINAL_RUN expression names ${quoted} ${inFinal} times`
      }
      const total = yml.split(quoted).length - 1
      return total === 2 ? null : `${quoted} appears ${total} times, expected the cron and the FINAL_RUN expression`
    },
  },
]

function runChecks(root) {
  return CHECKS.map(c => {
    let detail
    try { detail = c.run(root) } catch (e) { detail = `error: ${e.message}` }
    return { name: c.name, ok: detail == null, detail }
  })
}

if (require.main === module) {
  const root = path.resolve(process.argv[2] || path.join(__dirname, '..'))
  const results = runChecks(root)
  for (const r of results) console.log(r.ok ? `PASS  ${r.name}` : `FAIL  ${r.name}: ${r.detail}`)
  process.exit(results.every(r => r.ok) ? 0 : 1)
}

module.exports = { runChecks, CHECKS, CRONS, ARCHIVE_NOTE }
