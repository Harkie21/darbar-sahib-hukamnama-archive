'use strict'

/**
 * The published file must be the Hazur Sahib schema exactly: same keys, same
 * order, same value types. Only source differs, and dsg is present but null.
 * test/hs-shape.json is a keys/types skeleton of hazur-sahib-hukamnama-archive
 * archive/latest.json with every value removed.
 */

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { Resolver, SOURCE_SGGS } = require('../lib/resolve')
const { parseLatest } = require('../lib/scrape')
const { serialize } = require('../lib/write')
const { buildPayload } = require('../bin/fetch-today')

const DB_PATH = process.env.SHABADOS_DB
  || 'node_modules/@shabados/database/build/database.sqlite'
const HS_SHAPE = require('./hs-shape.json')

let failures = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`) }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`) }
}

const shape = v => Array.isArray(v) ? (v.length ? [ shape(v[0]) ] : [])
  : v === null ? 'null'
    : typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([ k, x ]) => [ k, shape(x) ]))
      : typeof v

/** Key order matters as much as key set: serialize() writes keys in insertion order. */
function sameShape(actual, expected, where = '$') {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${where} should be an array`)
    if (expected.length && actual.length) sameShape(actual[0], expected[0], `${where}[0]`)
    return
  }
  if (expected && typeof expected === 'object') {
    assert.deepStrictEqual(Object.keys(actual), Object.keys(expected), `${where} key order`)
    for (const k of Object.keys(expected)) sameShape(actual[k], expected[k], `${where}.${k}`)
    return
  }
  assert.strictEqual(actual, expected, `${where} type`)
}

const page = parseLatest(fs.readFileSync(path.join(__dirname, 'fixtures', 'index-2026-10-14.html'), 'utf8'))
const r = new Resolver(DB_PATH).resolve(page.heading, page.bani, SOURCE_SGGS, { ang: page.ang })
const payload = buildPayload(page.date, { sggs: r }, '4.8.7')
const written = JSON.parse(serialize(payload))

console.log('schema matches Hazur Sahib')
check('the fixture day resolves, so the payload is a real one', () => {
  assert.ok(r.ok, JSON.stringify(r))
  assert.strictEqual(r.confidence, 'high')
})
check('top-level key order is identical', () => {
  assert.deepStrictEqual(Object.keys(written), Object.keys(HS_SHAPE))
})
check('sggs block has the same keys, order and types', () => {
  sameShape(shape(written.sggs), HS_SHAPE.sggs, '$.sggs')
})
check('every other block matches except dsg', () => {
  const { dsg: _a, ...rest } = shape(written)
  const { dsg: _b, ...hsRest } = HS_SHAPE
  sameShape(rest, hsRest)
  assert.deepStrictEqual(Object.keys(rest), Object.keys(hsRest))
})
check('dsg is present and null', () => {
  assert.ok(Object.prototype.hasOwnProperty.call(written, 'dsg'))
  assert.strictEqual(written.dsg, null)
})
check('source is darbar_sahib', () => {
  assert.strictEqual(written.source, 'darbar_sahib')
})
check('shabad_ids mirrors sggs.shabad_ids', () => {
  assert.deepStrictEqual(written.shabad_ids, written.sggs.shabad_ids)
})
check('serialized bytes follow the shared rule: two-space JSON plus one newline', () => {
  const bytes = serialize(payload)
  assert.strictEqual(bytes, JSON.stringify(payload, null, 2) + '\n')
  assert.ok(!bytes.includes('\r'))
})

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
