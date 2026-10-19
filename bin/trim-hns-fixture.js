#!/usr/bin/env node
'use strict'

/**
 * Cuts a saved hukamnamasahib.com page down to a test fixture.
 *
 *   node bin/trim-hns-fixture.js cache/hns/2026-10-14-morning.html test/fixtures/hns-2026-10-14-morning.html
 *
 * Keeps the real page data object, the main reading's Gurmukhi bani in full,
 * and the first bani line of each related post so the exclusion test has
 * something to exclude. Drops the explanation, Devanagari, English, footer,
 * styling and every other part of the page.
 */

const fs = require('fs')
const cheerio = require('cheerio')
const {
  rowsOf, flightOf, findMainProps, flightString, readingBlocks, splitHeading, NOT_FOUND_DIGEST,
} = require('../lib/hns')

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const textRow = (id, text) => `${id}:T${Buffer.byteLength(text, 'utf8').toString(16)},${text}`
const pushScript = flight => `<script>self.__next_f.push(${JSON.stringify([ 1, flight ]).replace(/</g, '\\u003c')})</script>`

function trimNotFound($, rows) {
  const keep = [ ...rows.entries() ].find(([ , r ]) => r.json && r.json.includes(NOT_FOUND_DIGEST))
  if (!keep) throw new Error('not-found page without the digest row')
  const digestOnly = `${keep[0]}:${JSON.stringify({ digest: NOT_FOUND_DIGEST })}\n`
  return [
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">',
    `<meta name="robots" content="${esc($('meta[name=robots]').attr('content') || 'noindex')}">`,
    `<title>${esc($('title').first().text())}</title></head><body>`,
    pushScript(digestOnly),
    '</body></html>',
    '',
  ].join('\n')
}

function firstBaniLine(contentHtml) {
  const { blocks } = readingBlocks(contentHtml)
  if (!blocks.length) return ''
  const { bani } = splitHeading(blocks)
  const k = bani.indexOf('॥')
  return k >= 0 ? bani.slice(0, k + 1).trim() : bani
}

function trimPage($, rows) {
  const mains = findMainProps(rows)
  if (mains.length !== 1) throw new Error(`expected 1 main props object, found ${mains.length}`)
  const props = structuredClone(mains[0])

  const { blocks } = readingBlocks(flightString(props.data.contentHtml, rows, 'contentHtml'))
  const mainHtml = blocks.map(b => b.$.html(b.el)).join('\n')
  const textRows = [ textRow('a1', mainHtml) ]
  props.data.contentHtml = '$a1'

  const related = []
  props.relatedPosts.forEach((entry, n) => {
    const payload = entry.post && entry.post.payload
    if (!payload) return
    const line = firstBaniLine(flightString(payload.contentHtml, rows, 'related contentHtml'))
    const id = `b${n + 1}`
    const html = `<p>${esc(line)}</p>`
    textRows.push(textRow(id, html))
    payload.contentHtml = `$${id}`
    related.push({ slug: entry.post.slug, line })
  })

  let ld = null
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const o = JSON.parse($(el).text())
      if (o['@type'] === 'Article') {
        ld = Object.fromEntries([ '@context', '@type', 'headline', 'datePublished', 'dateCreated', 'dateModified', 'url' ]
          .filter(k => o[k] !== undefined).map(k => [ k, o[k] ]))
      }
    } catch (e) { /* not the article block */ }
  })

  const flight = `0:${JSON.stringify([ '$', '$L1', null, props ])}\n${textRows.join('')}`
  return [
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">',
    `<title>${esc($('title').first().text())}</title>`,
    ld ? `<script type="application/ld+json">${JSON.stringify(ld)}</script>` : '',
    '</head><body>',
    `<h1>${esc($('h1').first().text())}</h1>`,
    '<div class="hukamnama-reading-pane"><div class="hukamnama-html-content">',
    mainHtml,
    '</div></div>',
    '<aside><ul>',
    ...related.map(r => `<li><a href="/hukamnama/${esc(r.slug)}"><span>${esc(r.line)}</span></a></li>`),
    '</ul></aside>',
    pushScript(flight),
    '</body></html>',
    '',
  ].filter(l => l !== '').join('\n') + '\n'
}

function main() {
  const [ input, output ] = process.argv.slice(2)
  if (!input || !output) {
    console.error('usage: trim-hns-fixture.js <saved page> <fixture out>')
    process.exit(2)
  }
  const raw = fs.readFileSync(input, 'utf8')
  const $ = cheerio.load(raw)
  const rows = rowsOf(flightOf($))
  const out = raw.includes(NOT_FOUND_DIGEST) ? trimNotFound($, rows) : trimPage($, rows)
  fs.writeFileSync(output, out)
  console.error(`wrote ${output} (${Buffer.byteLength(out)} bytes)`)
}

main()
