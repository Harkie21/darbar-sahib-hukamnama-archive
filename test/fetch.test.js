'use strict'

const assert = require('assert')
const { fetchMorningRaw, isTransient, LayoutChangedError, REQUEST_TIMEOUT_MS } = require('../lib/hns')

let failures = 0
const queue = []
const check = (name, fn) => queue.push(async () => {
  try { await fn(); console.log(`  ok   ${name}`) }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`) }
})

const DATE = '2026-11-18'
const URL = 'https://hukamnamasahib.com/hukamnama/2026-11-18-morning'
const timeoutError = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
const networkError = () => new TypeError('fetch failed')
const res = status => ({ status, body: Buffer.from('') })

/** A `get` that plays back `script`, one entry per call, and records the URLs asked. */
function scripted(script) {
  const urls = []
  const get = async url => {
    const step = script[urls.push(url) - 1]
    if (step instanceof Error) throw step
    return step
  }
  return { get, urls }
}

const quiet = { wait: async () => {}, log: () => {} }

console.log('retry')

check('each request gets 60 s', () => {
  assert.strictEqual(REQUEST_TIMEOUT_MS, 60_000)
})
check('a timeout then a 200 succeeds on the second attempt', async () => {
  const { get, urls } = scripted([ timeoutError(), res(200) ])
  assert.strictEqual((await fetchMorningRaw(DATE, { get, ...quiet })).status, 200)
  assert.deepStrictEqual(urls, [ URL, URL ])
})
check('network errors and 5xx are retried, waiting 5, 15 and 45 s', async () => {
  const waits = []
  const { get, urls } = scripted([ networkError(), res(503), timeoutError(), res(200) ])
  const r = await fetchMorningRaw(DATE, { get, wait: async ms => waits.push(ms), log: () => {} })
  assert.strictEqual(r.status, 200)
  assert.strictEqual(urls.length, 4)
  assert.deepStrictEqual(waits, [ 5_000, 15_000, 45_000 ])
})
check('after 3 retries the last timeout is thrown', async () => {
  const { get, urls } = scripted([ timeoutError(), timeoutError(), timeoutError(), timeoutError() ])
  await assert.rejects(fetchMorningRaw(DATE, { get, ...quiet }), { name: 'TimeoutError' })
  assert.strictEqual(urls.length, 4)
})
check('after 3 retries the last 5xx response is returned', async () => {
  const { get, urls } = scripted([ res(502), res(502), res(502), res(500) ])
  assert.strictEqual((await fetchMorningRaw(DATE, { get, ...quiet })).status, 500)
  assert.strictEqual(urls.length, 4)
})
check('a 4xx or a redirect is an answer, not retried', async () => {
  for (const status of [ 403, 404, 301 ]) {
    const { get, urls } = scripted([ res(status) ])
    assert.strictEqual((await fetchMorningRaw(DATE, { get, ...quiet })).status, status)
    assert.strictEqual(urls.length, 1)
  }
})
check('any other error is thrown at once', async () => {
  const { get, urls } = scripted([ new Error('boom') ])
  await assert.rejects(fetchMorningRaw(DATE, { get, ...quiet }), /boom/)
  assert.strictEqual(urls.length, 1)
})
check('no delays means one attempt', async () => {
  const { get, urls } = scripted([ timeoutError(), res(200) ])
  await assert.rejects(fetchMorningRaw(DATE, { get, delays: [], ...quiet }), { name: 'TimeoutError' })
  assert.strictEqual(urls.length, 1)
})
check('transient covers timeouts, aborts, fetch failed and terminated only', () => {
  assert.ok(isTransient(timeoutError()))
  assert.ok(isTransient(Object.assign(new Error('x'), { name: 'AbortError' })))
  assert.ok(isTransient(networkError()))
  assert.ok(isTransient(new TypeError('terminated')))
  assert.ok(!isTransient(new TypeError('x is not a function')))
  assert.ok(!isTransient(new LayoutChangedError('x')))
})

;(async () => {
  for (const step of queue) await step()
  console.log(failures ? `\n${failures} FAILED` : '\nall passed')
  process.exit(failures ? 1 : 0)
})()
