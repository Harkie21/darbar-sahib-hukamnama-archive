'use strict'

/**
 * The SGPC page cites its ang in a footer, so the resolver receives it through
 * opts.ang. That path must behave exactly like an ang appended to the bani.
 */

const assert = require('assert')
const Database = require('better-sqlite3')
const { toUnicode } = require('gurmukhi-utils')
const { Resolver, SOURCE_SGGS } = require('../lib/resolve')

const DB_PATH = process.env.SHABADOS_DB
  || 'node_modules/@shabados/database/build/database.sqlite'
const N = Number(process.env.PARITY_N || 200)
const SEED = Number(process.env.PARITY_SEED || 1)

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function sample(items, n, rng) {
  const pool = items.slice()
  const take = Math.min(n, pool.length)
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(rng() * (pool.length - i))
    const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp
  }
  return pool.slice(0, take)
}

const GURMUKHI_DIGITS = '੦੧੨੩੪੫੬੭੮੯'
const toGurmukhiNum = n => String(n).split('').map(d => GURMUKHI_DIGITS[+d]).join('')

const db = new Database(DB_PATH, { readonly: true })
const resolver = new Resolver(DB_PATH)
const linesFor = db.prepare(
  'SELECT gurmukhi, source_page FROM lines WHERE shabad_id = ? ORDER BY order_id'
)
const all = db.prepare('SELECT id FROM shabads WHERE source_id = ? ORDER BY id')
  .all(SOURCE_SGGS).map(r => r.id)
const ids = sample(all, N, mulberry32(SEED))

let failures = 0
for (const id of ids) {
  const rows = linesFor.all(id)
  const bani = rows.map(r => toUnicode(r.gurmukhi)).join(' ').replace(/[;,]/g, '  ')
  const ang = rows[0].source_page
  const viaText = resolver.resolve('', `${bani} ਅੰਗ-${toGurmukhiNum(ang)}`, SOURCE_SGGS)
  const viaOpts = resolver.resolve('', bani, SOURCE_SGGS, { ang })
  try {
    assert.deepStrictEqual(viaOpts, viaText)
  } catch (e) {
    failures++
    if (failures <= 5) console.log(`  FAIL ${id}\n       ${e.message.split('\n').slice(0, 12).join('\n       ')}`)
  }
}

console.log(`parity seed=${SEED} n=${ids.length}: ${ids.length - failures} identical, ${failures} differ`)
process.exit(failures ? 1 : 0)
