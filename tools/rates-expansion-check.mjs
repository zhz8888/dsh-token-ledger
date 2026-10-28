#!/usr/bin/env node
/**
 * Check the Rates expansion over a real socket.
 *
 * The Rates page can expand a vendor to every model it has. This script drives
 * the plugin's own host half and its own route — with a stub transport, so it
 * needs no network — behind a real `node:http` server, and prints what comes
 * back. It is the run recorded under "The rates expansion" in
 * `docs/VERIFICATION.md`, kept so that the capture can be repeated.
 *
 * Run it from the repository root: `node tools/rates-expansion-check.mjs`.
 *
 * @module dsh-token-ledger/tools/rates-expansion-check
 */

import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRatesService } from '../lib/rates-service.js'
import { createRatesRoute } from '../lib/route.js'

/**
 * One models.dev row.
 *
 * @param {string} id - the model id.
 * @param {string} name - the model name.
 * @param {string} released - the release date.
 * @param {number} input - the input price per million tokens.
 * @param {number} output - the output price per million tokens.
 * @param {number|null} [cacheRead] - the cache-read price.
 * @returns {object} the row.
 */
const MODEL = (id, name, released, input, output, cacheRead = null) => ({
  id,
  name,
  release_date: released,
  limit: { context: 200000 },
  cost: { input, output, cache_read: cacheRead, cache_write: null },
})

/** A catalogue with one vendor of five models and one of two. */
const MODELS_DEV = {
  openai: {
    id: 'openai',
    name: 'OpenAI',
    models: {
      'gpt-6': MODEL('gpt-6', 'GPT-6', '2026-09-01', 1.25, 10, 0.125),
      'gpt-5.1': MODEL('gpt-5.1', 'GPT-5.1', '2026-05-01', 1.25, 10, 0.125),
      'gpt-5': MODEL('gpt-5', 'GPT-5', '2026-01-15', 1.25, 10, 0.125),
      'gpt-4o': MODEL('gpt-4o', 'GPT-4o', '2024-11-01', 2.5, 10, 1.25),
      'gpt-4o-mini': MODEL('gpt-4o-mini', 'GPT-4o mini', '2024-07-01', 0.15, 0.6, 0.075),
    },
  },
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    models: {
      'claude-fable-5.1': MODEL('claude-fable-5.1', 'Claude Fable 5.1', '2026-08-01', 3, 15, 0.3),
      'claude-fable-5': MODEL('claude-fable-5', 'Claude Fable 5', '2026-02-01', 3, 15, 0.3),
    },
  },
}

/** The rate the fixture quotes. */
const FX = { base_code: 'USD', rates: { CNY: 7.1234 }, time_last_update_unix: 1789000000 }

/**
 * A transport that answers by URL, so the run needs no network.
 *
 * @param {string} url - the URL that is being read.
 * @returns {Promise<{ ok: boolean, status: number, text: () => Promise<string> }>} the response.
 */
const stubFetch = async (url) => {
  const text = String(url).includes('fx.test') ? JSON.stringify(FX) : JSON.stringify(MODELS_DEV)
  return { ok: true, status: 200, text: async () => text }
}

const dir = mkdtempSync(join(tmpdir(), 'token-ledger-expand-'))
const path = join(dir, 'rates.json')
const service = createRatesService({
  path,
  options: {
    source: 'modelsdev',
    modelsUrl: 'https://models.dev/api.json',
    fxUrl: 'https://fx.test/latest',
    fetchImpl: stubFetch,
    perVendor: 3,
    log: { info: (...args) => console.log('[host]', ...args), warn: () => {} },
  },
})

await service.refresh({ reason: 'verification' })

const route = createRatesRoute({ rates: service })
const server = createServer((req, res) => {
  route.handler(req, res).catch(() => {
    res.writeHead(500)
    res.end('{}')
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

/**
 * Read one route.
 *
 * @param {string} pathname - the path and query.
 * @param {object} [init] - fetch options.
 * @returns {Promise<{ status: number, bytes: number, body: string }>} the answer.
 */
const get = async (pathname, init) => {
  const response = await fetch(`${base}${pathname}`, init)
  const body = await response.text()
  return { status: response.status, bytes: body.length, body }
}

const whole = await get('/api/token-ledger/rates')
const payload = JSON.parse(whole.body)
console.log(`\nGET /api/token-ledger/rates -> ${whole.status}, ${whole.bytes} bytes`)
for (const entry of payload.vendors) {
  console.log(
    `  ${entry.vendor.padEnd(10)} models=${String(entry.modelCount).padStart(2)} published=${entry.models.length} expandable=${entry.expandable} expandedCount=${entry.expandedCount}`,
  )
}
console.log(`  payload carries no full list: ${payload.vendors.every((entry) => entry.allModels === undefined)}`)

const openai = await get('/api/token-ledger/rates?vendor=openai')
const openaiBody = JSON.parse(openai.body)
console.log(`\nGET /api/token-ledger/rates?vendor=openai -> ${openai.status}, ${openai.bytes} bytes`)
console.log(`  vendor=${openaiBody.vendor} modelCount=${openaiBody.modelCount} publishedCount=${openaiBody.publishedCount}`)
for (const model of openaiBody.models) {
  const input = String(model.prices.input).padEnd(5)
  const output = String(model.prices.output).padEnd(6)
  console.log(`  ${model.id.padEnd(18)} in=${input} out=${output} source=${model.source}`)
}

const missing = await get('/api/token-ledger/rates?vendor=nope')
console.log(`\nGET /api/token-ledger/rates?vendor=nope -> ${missing.status} ${missing.body}`)

const empty = await get('/api/token-ledger/rates?vendor=')
console.log(`GET /api/token-ledger/rates?vendor=      -> ${empty.status}, ${empty.bytes} bytes (the whole payload, as without the parameter)`)

const foreign = await get('/api/token-ledger/rates', { headers: { origin: 'https://evil.example' } })
console.log(`GET /api/token-ledger/rates (foreign origin) -> ${foreign.status} ${foreign.body}`)

const cache = JSON.parse(readFileSync(path, 'utf8'))
const cachedOpenai = cache.catalogue.vendors.find((entry) => entry.vendor === 'openai')
console.log(`\nrates.json ${statSync(path).size} bytes; the cache keeps openai's whole list: ${cachedOpenai.allModels.length} rows`)

server.close()
rmSync(dir, { recursive: true, force: true })
