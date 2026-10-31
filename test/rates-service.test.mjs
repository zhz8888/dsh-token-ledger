/**
 * Rates service tests.
 *
 * The service exists to make network failure invisible, so most of these tests
 * are about what survives a failure rather than about what happens on success.
 *
 * @module dsh-token-ledger/test/rates-service.test
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createRatesService, fetchJson } from '../lib/rates-service.js'
import { VENDOR_PRICE_SOURCES } from '../lib/vendor-prices.js'

/** A model list with two vendors. */
const MODELS = {
  data: [
    { id: 'acme/new-flash', name: 'Acme New', created: 3000, context_length: 1000, pricing: { prompt: '0.0000002', completion: '0.0000008', input_cache_read: '0.00000002' } },
    { id: 'acme/old-flash', name: 'Acme Old', created: 1000, context_length: 1000, pricing: { prompt: '0.0000001', completion: '0.0000004' } },
    { id: 'beta/only', name: 'Beta Only', created: 2000, context_length: 2000, pricing: { prompt: '0.000001', completion: '0.000002' } },
  ],
}

const FX = { result: 'success', base_code: 'USD', rates: { CNY: 6.725314 }, time_last_update_unix: 1789000000 }

/**
 * A fetch stand-in that answers by URL and records calls.
 *
 * @param {{ models?: unknown, fx?: unknown, failModels?: boolean, failFx?: boolean }} [options] - response control.
 * @returns {{ fetchImpl: typeof fetch, calls: string[] }} the transport and its log.
 */
function stubFetch({ models = MODELS, fx = FX, failModels = false, failFx = false } = {}) {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(String(url))
    const isFx = String(url).includes('rates')
    if (isFx && failFx) throw new Error('fx unreachable')
    if (!isFx && failModels) throw new Error('models unreachable')
    const payload = isFx ? fx : models
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) }
  }
  return { fetchImpl, calls }
}

/**
 * Build a service over a temporary cache file.
 *
 * @param {object} options - service options plus the fetch stub.
 * @returns {{ service: object, path: string, cleanup: () => void, calls: string[] }} the service and its disposer.
 */
function makeService(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'token-ledger-rates-'))
  const path = join(dir, 'rates.json')
  const { fetchImpl, calls } = stubFetch(options)
  const service = createRatesService({
    path,
    // The fixture here is OpenRouter-shaped, so these tests drive the gateway
    // source explicitly; the per-vendor source has its own fixture below. The
    // spread comes last so a test can ask for the other one.
    options: { source: 'openrouter', fetchImpl, modelsUrl: 'https://models.test/list', fxUrl: 'https://rates.test/latest', now: options.now, ...options },
  })
  return { service, path, calls, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('a successful refresh publishes the catalogue and the rate, and caches them', async () => {
  const { service, path, calls, cleanup } = makeService()
  try {
    const outcome = await service.refresh({ reason: 'test' })
    assert.match(outcome.catalogue, /^ok/)
    assert.match(outcome.fx, /^ok/)
    // The model list, the rate, and one request per vendor whose own pricing page
    // is read. The stub answers every one of them, so nothing fails here.
    assert.equal(calls.length, 2 + Object.keys(VENDOR_PRICE_SOURCES).length, 'the list, the rate, and each vendor page')

    const view = service.read()
    assert.equal(view.catalogue.available, true)
    assert.equal(view.catalogue.modelCount, 3)
    assert.equal(view.catalogue.vendorCount, 2)
    assert.equal(view.catalogue.totalAvailable, 3)
    assert.equal(view.fx.available, true)
    assert.equal(view.fx.rate, 6.725314)
    assert.equal(view.fx.overridden, false)
    assert.match(view.catalogue.source, /models\.test/)

    const vendors = view.vendors.map((entry) => entry.vendor)
    assert.deepEqual(vendors, ['acme', 'beta'], 'ordered by model count')
    assert.equal(view.vendors[0].models[0].id, 'acme/new-flash', 'newest first within a vendor')
    assert.equal(view.vendors[0].models[0].prices.input, 0.2, 'scaled to USD per million without artefacts')

    assert.equal(existsSync(path), true, 'the cache file is written')
    const cached = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(cached.catalogue.vendors.length, 2)
    assert.equal(cached.fx.rate, 6.725314)
  } finally {
    cleanup()
  }
})

test('a failed refresh keeps the last good values and says the attempt failed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'token-ledger-rates-'))
  const path = join(dir, 'rates.json')
  try {
    const first = createRatesService({
      path,
      options: { source: 'openrouter', fetchImpl: stubFetch().fetchImpl, modelsUrl: 'https://models.test/list', fxUrl: 'https://rates.test/latest' },
    })
    await first.refresh()
    const good = first.read()
    assert.equal(good.catalogue.available, true)

    // The same cache file, but now nothing is reachable.
    const offline = createRatesService({
      path,
      options: {
        source: 'openrouter',
        fetchImpl: stubFetch({ failModels: true, failFx: true }).fetchImpl,
        modelsUrl: 'https://models.test/list',
        fxUrl: 'https://rates.test/latest',
      },
    })
    const before = offline.read()
    assert.equal(before.catalogue.available, true, 'the cache is read at construction, before any fetch')

    const outcome = await offline.refresh({ reason: 'test' })
    assert.match(outcome.catalogue, /^failed \(models unreachable\)/)
    assert.match(outcome.fx, /^failed \(fx unreachable\)/)

    const after = offline.read()
    assert.equal(after.catalogue.available, true, 'a failed refresh must not blank the table')
    assert.equal(after.catalogue.fetchedAt, good.catalogue.fetchedAt, 'and must not rewrite the fetch time')
    assert.equal(after.fx.rate, 6.725314)
    assert.match(after.lastRefresh.catalogue, /^failed/)
    assert.equal(typeof after.lastRefresh.ageMs, 'number')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a host that has never reached the network still serves a usable shape', () => {
  const { service, cleanup } = makeService()
  try {
    const view = service.read()
    assert.equal(view.catalogue.available, false)
    assert.equal(view.catalogue.modelCount, 0)
    assert.deepEqual(view.vendors, [])
    assert.equal(view.fx.available, false)
    assert.equal(view.fx.rate, null, 'an absent rate is null, not undefined')
    assert.equal(view.lastRefresh.at, null)
    assert.equal(view.currency, 'USD')
    assert.equal(view.quote, 'CNY')
    assert.equal(view.perVendor, 3)
    assert.equal(view.refreshIntervalMs, 30 * 60 * 1000)
  } finally {
    cleanup()
  }
})

test('hand-entered values are saved, outrank fetched ones, and survive a restart', async () => {
  const { service, path, cleanup } = makeService()
  try {
    await service.refresh()
    const saved = service.saveOverrides({
      fx: { rate: 6.9 },
      models: { 'acme/new-flash': { input: 0.42, cacheWrite: 1.5 } },
    })
    assert.equal(saved.ok, true)
    assert.equal(saved.saved.models, 1)
    assert.equal(saved.saved.fx, true)

    const view = service.read()
    assert.equal(view.fx.rate, 6.9)
    assert.equal(view.fx.source, 'manual')
    assert.equal(view.fx.overridden, true)
    assert.equal(view.overriddenModels, 1)
    const row = view.vendors.find((entry) => entry.vendor === 'acme').models.find((entry) => entry.id === 'acme/new-flash')
    assert.equal(row.prices.input, 0.42)
    assert.equal(row.prices.cacheWrite, 1.5, 'a bucket the vendor never published can still be typed in')
    assert.equal(row.source, 'manual')

    // A restart reads the cache and leaves the typed values on top.
    const restarted = createRatesService({ path, options: { fetchImpl: stubFetch().fetchImpl } })
    const afterRestart = restarted.read()
    assert.equal(afterRestart.overriddenModels, 1)
    assert.equal(afterRestart.fx.rate, 6.9)
    const restartRow = afterRestart.vendors.find((entry) => entry.vendor === 'acme').models.find((entry) => entry.id === 'acme/new-flash')
    assert.equal(restartRow.prices.input, 0.42)

    // A refetch does not undo the typed value.
    await restarted.refresh()
    assert.equal(restarted.read().vendors.find((entry) => entry.vendor === 'acme').models.find((entry) => entry.id === 'acme/new-flash').prices.input, 0.42)
  } finally {
    cleanup()
  }
})

test('clearing an override hands the row back to the fetched value', async () => {
  const { service, cleanup } = makeService()
  try {
    await service.refresh()
    service.saveOverrides({ models: { 'acme/new-flash': { input: 9 } } })
    assert.equal(service.read().vendors[0].models[0].prices.input, 9)
    service.saveOverrides({ models: { 'acme/new-flash': null } })
    const row = service.read().vendors.find((entry) => entry.vendor === 'acme').models.find((entry) => entry.id === 'acme/new-flash')
    assert.equal(row.prices.input, 0.2, 'back to the fetched price')
    assert.equal(row.source, 'fetched')
    assert.equal(service.read().overriddenModels, 0)
  } finally {
    cleanup()
  }
})

test('the two review answers hand a field back or record the price that was kept', async () => {
  const { service, cleanup } = makeService()
  const row = () => service.read().vendors.find((entry) => entry.vendor === 'acme').models.find((entry) => entry.id === 'acme/new-flash')
  try {
    await service.refresh()
    // Typed against a published 0.2 in / 0.8 out, so both fields are a disagreement.
    service.saveOverrides({ models: { 'acme/new-flash': { input: 0.42, output: 0.9 } } })
    assert.deepEqual(service.read().pending.map((entry) => entry.fields.map((field) => field.key)), [['input', 'output']])

    // "Keep mine" writes down the published number that was on screen, and only
    // that one: the field that was never answered is still asked about.
    const kept = service.saveOverrides({ keep: { 'acme/new-flash': ['input'] } })
    assert.equal(kept.saved.kept, 1)
    assert.deepEqual(service.read().pending.map((entry) => entry.fields.map((field) => field.key)), [['output']])
    assert.equal(row().prices.input, 0.42, 'the typed price survives the answer')

    // "Use official" deletes the typed values, which is what hands the fields
    // back to the catalogue rather than freezing them at today's number.
    const adopted = service.saveOverrides({ adopt: { 'acme/new-flash': ['input'] } })
    assert.equal(adopted.saved.adopted, 1)
    assert.equal(row().prices.input, 0.2, 'back to the published price')
    assert.equal(row().prices.output, 0.9, 'and the field that was kept is still typed')
    assert.equal(row().source, 'manual', 'one typed field left, so the row is still protected')

    service.saveOverrides({ adopt: { 'acme/new-flash': ['output'] } })
    assert.equal(service.read().overriddenModels, 0, 'with nothing typed left the override goes entirely')
    assert.equal(row().source, 'fetched')
    assert.deepEqual(service.read().pending, [])
  } finally {
    cleanup()
  }
})

test('an invalid patch is refused and changes nothing', async () => {
  const { service, cleanup } = makeService()
  try {
    await service.refresh()
    const refused = service.saveOverrides({ fx: { rate: 'not a number' } })
    assert.equal(refused.ok, false)
    assert.match(refused.error, /fx\.rate/)
    assert.equal(service.read().fx.rate, 6.725314, 'the previous rate is untouched')
    assert.equal(service.read().fx.overridden, false)
  } finally {
    cleanup()
  }
})

test('the timer refreshes on its interval and stops on demand', async () => {
  const { service, calls, cleanup } = makeService({ intervalMs: 15 })
  try {
    await service.refresh()
    const afterFirst = calls.length
    service.start()
    service.start() // a second call must not double-schedule
    await new Promise((resolve) => setTimeout(resolve, 70))
    service.stop()
    const afterTimer = calls.length
    assert.ok(afterTimer > afterFirst, `expected the timer to refresh, saw ${afterFirst} -> ${afterTimer}`)

    // After stop, nothing more happens.
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(calls.length, afterTimer, 'a stopped timer must not keep fetching')
  } finally {
    cleanup()
  }
})

test('fetchJson reports a timeout, an HTTP error and malformed JSON instead of throwing', async () => {
  const timeout = await fetchJson('https://x.test', {
    fetchImpl: (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      }),
    timeoutMs: 20,
  })
  assert.equal(timeout.ok, false)
  assert.match(timeout.reason, /timeout after 20ms/)

  const http = await fetchJson('https://x.test', { fetchImpl: async () => ({ ok: false, status: 503, text: async () => '' }) })
  assert.deepEqual(http, { ok: false, reason: 'HTTP 503' })

  const malformed = await fetchJson('https://x.test', { fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'not json' }) })
  assert.equal(malformed.ok, false)

  // The per-vendor price list is 5.9 MB today, so a response that size is a real
  // one and must not be mistaken for an attack.
  const realistic = await fetchJson('https://x.test', {
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ pad: 'x'.repeat(6 * 1024 * 1024) }) }),
  })
  assert.equal(realistic.ok, true, 'a six-megabyte body is a real response')

  const huge = await fetchJson('https://x.test', { fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'x'.repeat(17 * 1024 * 1024) }) })
  assert.equal(huge.ok, false)
  assert.match(huge.reason, /body too large/)

  const none = await fetchJson('https://x.test', { fetchImpl: null })
  assert.equal(none.ok, false)
  assert.match(none.reason, /no fetch implementation/)
})

test('a malformed response body is a failed source, not a crash', async () => {
  const { service, cleanup } = makeService({ models: { data: 'nope' }, fx: { rates: {} } })
  try {
    const outcome = await service.refresh()
    assert.match(outcome.catalogue, /^failed \(no usable models/)
    assert.match(outcome.fx, /^failed \(no usable rate/)
    assert.equal(service.read().catalogue.available, false)
  } finally {
    cleanup()
  }
})

test('fetchJson enforces the size cap while the body is arriving, not after it is in memory', async () => {
  // A `text()`-shaped transport can only be measured after the fact, but a real
  // fetch response carries a stream: the cap has to be applied to the stream, or
  // a hostile endpoint has already filled memory by the time the length is read.
  let textCalls = 0
  const chunk = () => new Uint8Array(1024 * 1024).fill(0x78)
  const oversized = await fetchJson('https://x.test', {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      body: new ReadableStream({
        pull(controller) {
          controller.enqueue(chunk())
        },
      }),
      text: async () => {
        textCalls += 1
        return 'x'.repeat(17 * 1024 * 1024)
      },
    }),
  })
  assert.equal(oversized.ok, false)
  assert.equal(textCalls, 0, 'the body is streamed; text() never materialises it')
  assert.equal(oversized.reason, 'body too large (>16777216 bytes)', '16 MB is the cap')

  // A declared body size is refused before a byte of it is read at all.
  let bodyReads = 0
  const declared = await fetchJson('https://x.test', {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': String(64 * 1024 * 1024) }),
      body: {
        getReader() {
          bodyReads += 1
          throw new Error('the body must not be read when its declared length is too large')
        },
      },
      text: async () => '',
    }),
  })
  assert.equal(declared.ok, false)
  assert.equal(declared.reason, 'body too large (>16777216 bytes)')
  assert.equal(bodyReads, 0, 'an oversized declared length stops the read before a byte is taken')

  // A streamed body under the cap decodes across chunk boundaries and parses.
  const encoder = new TextEncoder()
  const small = await fetchJson('https://x.test', {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('{"pad":"'))
          controller.enqueue(encoder.encode('ok"}'))
          controller.close()
        },
      }),
      text: async () => {
        throw new Error('text() must not be used for a stream')
      },
    }),
  })
  assert.equal(small.ok, true)
  assert.deepEqual(small.json, { pad: 'ok' })
})

test('a price save that cannot reach the disk is reported, not claimed', () => {
  const { service, path, cleanup } = makeService()
  try {
    // The atomic writer renames `<path>.tmp-<pid>` into place, so a directory
    // sitting on that name makes the write fail the way a full disk would.
    mkdirSync(`${path}.tmp-${process.pid}`)
    const saved = service.saveOverrides({ models: { 'acme/new-flash': { input: 0.42 } } })
    assert.equal(saved.ok, false, 'the page must not be told the value was saved')
    assert.equal(saved.error, 'could not store the price overrides')
    // The value is still served from memory; it is the disk that refused it.
    assert.equal(service.read().vendors[0].models[0].prices.input, 0.42)
  } finally {
    cleanup()
  }
})

test('a rate quoted against another base is a failed fetch, and the USD rate stays', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'token-ledger-rates-'))
  const path = join(dir, 'rates.json')
  try {
    const first = createRatesService({
      path,
      options: { source: 'openrouter', fetchImpl: stubFetch().fetchImpl, modelsUrl: 'https://models.test/list', fxUrl: 'https://rates.test/latest' },
    })
    await first.refresh()
    const good = first.read().fx.rate
    assert.equal(good, 6.725314)

    // An endpoint answering against EUR is not a USD rate: the refresh is a
    // failed one and the last good USD rate keeps being served.
    const euro = { ...FX, base_code: 'EUR', rates: { CNY: 7.8 } }
    const second = createRatesService({
      path,
      options: { source: 'openrouter', fetchImpl: stubFetch({ fx: euro }).fetchImpl, modelsUrl: 'https://models.test/list', fxUrl: 'https://rates.test/latest' },
    })
    const outcome = await second.refresh({ reason: 'test' })
    assert.match(outcome.fx, /^failed \(no usable rate/)
    assert.equal(second.read().fx.rate, good, 'the USD rate on disk is kept')
    assert.equal(second.read().fx.base, 'USD')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cancelRefresh aborts the fetch in flight and lets the refresh settle', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'token-ledger-rates-'))
  const path = join(dir, 'rates.json')
  let calls = 0
  let inflightSignal = null
  let hang = true
  const fetchImpl = (url, options) => {
    calls += 1
    if (hang) {
      inflightSignal = options.signal
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      })
    }
    const payload = String(url).includes('rates.test') ? FX : MODELS
    return Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify(payload) })
  }
  const service = createRatesService({
    path,
    options: { source: 'openrouter', fetchImpl, modelsUrl: 'https://models.test/list', fxUrl: 'https://rates.test/latest' },
  })
  try {
    // Cancelling with nothing running is a promise that resolves, not a throw.
    await service.cancelRefresh()

    const pending = service.refresh({ reason: 'test' })
    while (calls === 0) await new Promise((resolve) => setTimeout(resolve, 1))
    assert.equal(inflightSignal.aborted, false, 'the request runs until it is cancelled')
    const cancel = service.cancelRefresh()
    assert.equal(typeof cancel.then, 'function', 'cancelling returns something awaitable')
    const [outcome] = await Promise.all([pending, cancel])
    assert.equal(inflightSignal.aborted, true, 'the fetch in flight is aborted')
    assert.equal(outcome.catalogue, 'cancelled')
    assert.equal(outcome.fx, 'cancelled')
    assert.equal(calls, 1, 'a cancelled refresh does not go on to the other sources')

    // The service is usable again: the in-flight slot is free once it settles.
    hang = false
    const after = await service.refresh({ reason: 'test' })
    assert.match(after.catalogue, /^ok/)
    assert.equal(service.read().catalogue.available, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a price typed for a model only the expanded list carries is reviewed and settleable', async () => {
  const { service, cleanup } = makeService({ models: MODELS_MANY })
  try {
    await service.refresh()
    const published = service.read().vendors.find((entry) => entry.vendor === 'acme').models.map((model) => model.id)
    assert.deepEqual(published, ['acme/m5', 'acme/m4', 'acme/m3'], 'the head is the three newest')

    // `acme/m1` is served by the expansion and described by the same fetch, so
    // it is reviewed and counted like a published row — and, above all, it does
    // not appear as a second "acme" group with its prices converted as dollars.
    service.saveOverrides({ models: { 'acme/m1': { input: 9 } } })
    const after = service.read()
    const acme = after.vendors.filter((entry) => entry.vendor === 'acme')
    assert.equal(acme.length, 1, 'the vendor appears once')
    assert.equal(acme[0].manualOnly, undefined)
    assert.equal(after.overriddenModels, 1)
    assert.deepEqual(after.pending.map((entry) => entry.id), ['acme/m1'])
    assert.deepEqual(after.pending[0].fields, [{ key: 'input', manual: 9, official: 0.1 }])

    // "Keep mine" records the official number for that row too, so the
    // disagreement settles instead of standing forever.
    const kept = service.saveOverrides({ keep: { 'acme/m1': ['input'] } })
    assert.equal(kept.ok, true)
    assert.equal(kept.saved.kept, 1)
    assert.deepEqual(service.read().pending, [], 'the answer settles the disagreement')
    assert.equal(service.readVendor('acme').models.find((model) => model.id === 'acme/m1').prices.input, 9, 'the expanded list serves the typed price')
  } finally {
    cleanup()
  }
})

/* ------------------------------------------------ the per-vendor price source -- */

/** A models.dev-shaped payload: two of the vendors the page publishes. */
const MODELSDEV = {
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    models: {
      'deepseek-v4-flash': { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', release_date: '2026-09-10', limit: { context: 128000 }, cost: { input: 0.15, output: 0.6, cache_read: 0.003 } },
      'deepseek-v4-pro': { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', release_date: '2026-09-01', cost: { input: 0.435, output: 0.87 } },
    },
  },
  // Qwen is sold under Alibaba's provider id, not "qwen".
  alibaba: {
    id: 'alibaba',
    name: 'Alibaba',
    models: {
      'qwen3.8-max': { id: 'qwen3.8-max', name: 'Qwen3.8 Max', release_date: '2026-08-03', limit: { context: 1000000 }, cost: { input: 2, output: 6, cache_read: 0.25, cache_write: 2.5 } },
      'unpriced-model': { id: 'unpriced-model', name: 'No Price', release_date: '2026-09-30' },
    },
  },
  // A vendor with no entry in the mapping must not appear at all.
  openai: { id: 'openai', name: 'OpenAI', models: {} },
}

test('the default source is each vendor’s own list price, not a gateway quote', async () => {
  const { service, calls, cleanup } = makeService({ source: 'modelsdev', models: MODELSDEV })
  try {
    const outcome = await service.refresh({ reason: 'test' })
    assert.match(outcome.catalogue, /^ok/)
    assert.match(outcome.catalogue, /modelsdev/, 'the log says which source answered')

    const state = service.read()
    assert.equal(state.priceSource, 'modelsdev')
    assert.equal(state.catalogue.sourceId, 'modelsdev')
    assert.equal(state.catalogue.modelCount, 3, 'the unpriced model is not published')
    assert.deepEqual(state.vendors.map((entry) => entry.vendor), ['deepseek', 'qwen'], 'curated order, mapped ids')
    const flash = state.vendors[0].models[0]
    assert.equal(flash.id, 'deepseek/deepseek-v4-flash', 'a bare id is namespaced for overrides and tooltips')
    assert.equal(flash.prices.input, 0.15, 'USD per million, straight from the vendor list')
    assert.equal(flash.prices.cacheRead, 0.003)
    assert.equal(flash.contextLength, 128000)
    assert.equal(flash.created, Date.parse('2026-09-10'))
    const max = state.vendors[1].models[0]
    assert.equal(max.id, 'qwen/qwen3.8-max')
    assert.equal(max.prices.cacheWrite, 2.5, 'a cache-write price is carried when the source has one')
    // The stub answers the vendor pages with the same JSON fixture, whose HTML
    // parse yields nothing, so every vendor here falls back to the dataset — and
    // that shows up as `source: 'dataset'` rather than as a broken table.
    assert.equal(calls.length, 2 + Object.keys(VENDOR_PRICE_SOURCES).length)
    assert.ok(state.vendors.every((entry) => entry.source === 'dataset'), 'a page that yields nothing is a fallback, not a failure')
    assert.equal(state.catalogue.vendorPages.filter((entry) => entry.ok).length, 0)
  } finally {
    cleanup()
  }
})

test('an unknown source falls back to the default instead of failing', async () => {
  const { service, cleanup } = makeService({ source: 'nonsense', models: MODELSDEV })
  try {
    const outcome = await service.refresh()
    assert.match(outcome.catalogue, /modelsdev/)
    assert.equal(service.read().priceSource, 'modelsdev')
  } finally {
    cleanup()
  }
})

test('switching source to the gateway changes both the URL and the parsing', async () => {
  const { service, calls, cleanup } = makeService({ source: 'openrouter' })
  try {
    await service.refresh()
    assert.equal(service.read().catalogue.sourceId, 'openrouter')
    assert.match(calls[0], /models\.test/, 'the configured URL still wins')
  } finally {
    cleanup()
  }
})

/* ------------------------------------------- the whole list of one provider -- */

/** A model list whose one provider has more models than the quota publishes. */
const MODELS_MANY = {
  data: [
    { id: 'acme/m5', name: 'Acme Five', created: 5000, context_length: 1000, pricing: { prompt: '0.0000005', completion: '0.000002' } },
    { id: 'acme/m4', name: 'Acme Four', created: 4000, context_length: 1000, pricing: { prompt: '0.0000004', completion: '0.0000016' } },
    { id: 'acme/m3', name: 'Acme Three', created: 3000, context_length: 1000, pricing: { prompt: '0.0000003', completion: '0.0000012' } },
    { id: 'acme/m2', name: 'Acme Two', created: 2000, context_length: 1000, pricing: { prompt: '0.0000002', completion: '0.0000008' } },
    { id: 'acme/m1', name: 'Acme One', created: 1000, context_length: 1000, pricing: { prompt: '0.0000001', completion: '0.0000004' } },
  ],
}

/**
 * DeepSeek's own pricing page, with four models priced for peak and off-peak.
 *
 * A vendor that charges by time of day is two rows for one model, so the page
 * carries a table with a period column per model.
 */
const DEEPSEEK_PAGE = `
<html><body>
<table>
  <tr><th>模型</th><th>deepseek-a</th><th>deepseek-b</th><th>deepseek-c</th><th>deepseek-d</th></tr>
  <tr><td>模型版本</td><td>A</td><td>B</td><td>C</td><td>D</td></tr>
  <tr><td>百万tokens输入 （缓存未命中）</td><td>空闲时段</td><td>1元</td><td>2元</td><td>3元</td><td>4元</td></tr>
  <tr><td>高峰时段</td><td>2元</td><td>4元</td><td>6元</td><td>8元</td></tr>
  <tr><td>百万tokens输出</td><td>空闲时段</td><td>4元</td><td>8元</td><td>12元</td><td>16元</td></tr>
  <tr><td>高峰时段</td><td>8元</td><td>16元</td><td>24元</td><td>32元</td></tr>
</table>
</body></html>`

/**
 * A fetch stand-in that answers DeepSeek's own pricing page with its table.
 *
 * @param {object} [options] - the models list and the page's HTML.
 * @returns {{ fetchImpl: typeof fetch }} the transport.
 */
function stubFetchWithVendorPage({ models = MODELS, page = DEEPSEEK_PAGE } = {}) {
  return {
    fetchImpl: async (url) => {
      const target = String(url)
      if (target.includes('api-docs.deepseek.com')) {
        return { ok: true, status: 200, text: async () => page }
      }
      const payload = target.includes('rates') ? FX : models
      return { ok: true, status: 200, text: async () => JSON.stringify(payload) }
    },
  }
}

test('the published payload stays small, and says what an expansion would show', async () => {
  const { service, cleanup } = makeService({ models: MODELS_MANY })
  try {
    await service.refresh()
    const view = service.read()
    const acme = view.vendors.find((entry) => entry.vendor === 'acme')
    // The whole list is not published with the table: this payload is also the
    // price catalogue the bill and the overview price from.
    assert.equal('allModels' in acme, false, 'the whole list is served on demand instead')
    assert.equal(acme.models.length, 3, 'the table still shows the newest few')
    assert.equal(acme.modelCount, 5, 'and the header still says how many models the provider has')
    assert.equal(acme.expandable, true, 'so the page knows there is more to show')
    assert.equal(acme.expandedCount, 5, 'and how much of it there is')
  } finally {
    cleanup()
  }
})

test('the catalogue the bill prices from carries every model, and the page still gets a small payload', async () => {
  // The page shows a provider's newest few models and the bill prices usage by
  // model, so the two need different payloads: the page's stays small, and the
  // bill's carries every model the catalogue has.
  const { service, cleanup } = makeService({ models: MODELS_MANY })
  try {
    await service.refresh()
    const page = service.read()
    const catalogue = service.readCatalogue()
    const acme = (payload) => payload.vendors.find((entry) => entry.vendor === 'acme')
    assert.equal(acme(page).models.length, 3, 'the page shows the head')
    assert.equal('allModels' in acme(page), false, 'and no whole list')
    assert.equal(acme(catalogue).models.length, 5, 'the bill prices from the whole list')
    assert.equal(acme(catalogue).modelCount, 5)
    // The rest of the payload is the same answer, so the rate and the freshness
    // are the ones the page already showed.
    assert.equal(catalogue.fx.rate, page.fx.rate)
    assert.equal(catalogue.catalogue.fetchedAt, page.catalogue.fetchedAt)
  } finally {
    cleanup()
  }
})

test('a provider can be served its whole list, with the typed prices on top', async () => {
  const { service, cleanup } = makeService({ models: MODELS_MANY })
  try {
    await service.refresh()
    const full = service.readVendor('acme')
    assert.equal(full.vendor, 'acme')
    assert.equal(full.modelCount, 5, 'every priced model of the provider')
    assert.equal(full.publishedCount, 3, 'three of them were already published')
    assert.deepEqual(full.models.map((row) => row.id), ['acme/m5', 'acme/m4', 'acme/m3', 'acme/m2', 'acme/m1'])
    assert.equal(full.models[0].source, 'fetched')
    assert.equal(full.models[0].prices.input, 0.5, 'the fetched price, in USD per million')

    // A typed price wins over the fetched one in the expanded list too.
    service.saveOverrides({ models: { 'acme/m1': { input: 9 } } })
    const typed = service.readVendor('acme')
    assert.equal(typed.models[4].prices.input, 9)
    assert.equal(typed.models[4].source, 'manual')
    assert.equal(typed.models[0].prices.input, 0.5, 'and the fetched prices are left alone')

    assert.equal(service.readVendor('nobody'), undefined, 'a provider the catalogue does not carry')
    assert.equal(service.readVendor(''), undefined)
  } finally {
    cleanup()
  }
})

test('the cached catalogue keeps the whole list, so an offline host can still expand', async () => {
  const { service, path, cleanup } = makeService({ models: MODELS_MANY })
  try {
    await service.refresh()
    const cached = JSON.parse(readFileSync(path, 'utf8'))
    const acme = cached.catalogue.vendors.find((entry) => entry.vendor === 'acme')
    assert.equal(acme.allModels.length, 5, 'the cache keeps what the expansion needs')

    // A host that cannot reach the network reads the same list back.
    const offline = createRatesService({ path, options: { fetchImpl: stubFetch({ failModels: true, failFx: true }).fetchImpl } })
    assert.equal(offline.readVendor('acme').modelCount, 5)
  } finally {
    cleanup()
  }
})

test('a provider priced by time of day expands into the same kind of row', async () => {
  const { service, cleanup } = makeService({ fetchImpl: stubFetchWithVendorPage().fetchImpl })
  try {
    await service.refresh()
    const view = service.read()
    const deepseek = view.vendors.find((entry) => entry.vendor === 'deepseek')
    assert.equal(deepseek.source, 'vendor', 'the price comes from the vendor’s own page')
    // One model is two rows here, so the count of models is not the count of
    // rows, and the expansion says how many rows it would show.
    assert.equal(deepseek.modelCount, 4, 'four models')
    assert.equal(deepseek.models.length, 6, 'but six published rows, two per model')
    assert.equal(deepseek.expandable, true)
    assert.equal(deepseek.expandedCount, 8, 'eight rows in all')

    const full = service.readVendor('deepseek')
    assert.equal(full.modelCount, 8)
    assert.equal(full.publishedCount, 6)
    assert.equal(full.models[0].id, 'deepseek/deepseek-a@peak', 'the same row shape as the published one')
    assert.equal(full.models[0].period, 'peak')
    assert.equal(full.models[0].periodLabel, 'peak')
    assert.equal(full.models[1].period, 'offPeak')
    assert.deepEqual(full.models[0].prices, { input: 2, output: 8, cacheRead: null, cacheWrite: null })
  } finally {
    cleanup()
  }
})
