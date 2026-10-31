/**
 * The rates service: fetch, cache, schedule and serve.
 *
 * Split from `rates.js` on purpose. That module is pure — payloads in, rows out —
 * and is tested without a socket. This one owns everything that can fail: the
 * network, the cache file, the timer, and the merge of hand-entered values over
 * fetched ones. Its whole job is to make those failures invisible to the page.
 *
 * The rules it enforces:
 *
 * - **A failed refresh never clears a good value.** The last successful catalogue
 *   and rate stay served, with their fetch time, so the page can say how old they
 *   are instead of going blank.
 * - **A fetch failure is not an error state.** It is the normal case on a
 *   firewalled host, so it is recorded as `ok: false` with a reason and nothing
 *   throws upward.
 * - **Overrides outlive refreshes.** They live in their own section of the cache
 *   file and are re-applied to every fetch.
 * - **One fetch serves every client.** The timer runs in the host, so opening the
 *   settings page does not cause a request, and an offline host does not retry
 *   once per page view.
 *
 * @module dsh-token-ledger/rates-service
 */

import {
  DEFAULT_FX_URL,
  DEFAULT_PRICE_SOURCE,
  MAINSTREAM_VENDORS,
  MODELSDEV_URL,
  MODELS_PER_VENDOR,
  OPENROUTER_MODELS_URL,
  PRICE_CURRENCY,
  PRICE_KEYS,
  PRICE_SOURCES,
  QUOTE_CURRENCY,
  REFRESH_INTERVAL_MS,
  VENDOR_LIMIT,
  applyOverrides,
  emptyRatesState,
  mergeModelOverride,
  parseCatalogue,
  parseFx,
  parseModelsDev,
  validateOverrides,
} from './rates.js'
import { loadLedger, saveLedger } from './store.js'
import { VENDOR_PRICE_SOURCES, vendorRows } from './vendor-prices.js'

/**
 * Refuse to parse a response body larger than this.
 *
 * The per-vendor list is 5.9 MB today (OpenRouter's is ~750 kB), and the cap
 * exists to stop a hostile or broken endpoint from filling memory, not to keep
 * a real response out. Sixteen megabytes leaves headroom for the list to grow
 * — it grew by a megabyte in a year — while still being a limit.
 */
const MAX_BODY_BYTES = 16 * 1024 * 1024

/**
 * The per-vendor list is a large file over a possibly slow link, so it gets
 * longer than the rate.
 *
 * A minute, because the list is 5.9 MB now and a download of it over a slow
 * link was measured at 44 seconds — past the half-minute this used to allow,
 * which meant the refresh failed on the very hosts that needed it most.
 */
const MODELS_TIMEOUT_MS = 60000
const FX_TIMEOUT_MS = 20000
/** A vendor's pricing page is small, but a slow cloud portal is still slow. */
const VENDOR_TIMEOUT_MS = 20000

/** The default URL for each source. */
const SOURCE_URLS = { modelsdev: MODELSDEV_URL, openrouter: OPENROUTER_MODELS_URL }

/**
 * Read a response body while counting its bytes, refusing a body that grows
 * past {@link MAX_BODY_BYTES}.
 *
 * The cap has to be applied as the body arrives: `response.text()` buffers the
 * whole body first, so a hostile or broken endpoint would already have filled
 * memory by the time a length check ran. The stream is read chunk by chunk and
 * cancelled the moment the count crosses the cap. A transport that answers with
 * a whole body and no stream (the tests and the host's stubs are shaped that
 * way) still works, and is measured after the fact.
 *
 * @param {object} response - a `fetch` response.
 * @returns {Promise<{ ok: true, text: string }|{ ok: false, reason: string }>} the body, or why it was refused.
 */
async function readBody(response) {
  if (response.body === null || response.body === undefined || typeof response.body.getReader !== 'function') {
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return { ok: false, reason: `body too large (>${MAX_BODY_BYTES} bytes)` }
    return { ok: true, text }
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BODY_BYTES) {
        await reader.cancel()
        return { ok: false, reason: `body too large (>${MAX_BODY_BYTES} bytes)` }
      }
      text += decoder.decode(value, { stream: true })
    }
    return { ok: true, text: text + decoder.decode() }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // A cancelled stream can already have released the lock.
    }
  }
}

/**
 * Fetch a body with a timeout, without throwing.
 *
 * `json: false` returns the raw text instead of parsing it, which is what the
 * vendor pricing pages need: they are HTML, and the same strictness that protects
 * the JSON sources would reject them for not being JSON.
 *
 * `signal` lets the caller stop a request it started: the service hands one to
 * every request a refresh makes, so `cancelRefresh()` can abort them all. A
 * request cancelled that way answers `reason: 'cancelled'` rather than claiming
 * a timeout, because a page that reported a timeout after the plugin was
 * disabled would be wrong about what happened.
 *
 * @param {string} url - the URL.
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number, json?: boolean, signal?: AbortSignal }} [options] - the transport.
 * @returns {Promise<{ ok: true, json?: unknown, text?: string }|{ ok: false, reason: string }>} the result.
 */
export async function fetchJson(url, { fetchImpl = globalThis.fetch, timeoutMs = MODELS_TIMEOUT_MS, json = true, signal } = {}) {
  if (typeof fetchImpl !== 'function') return { ok: false, reason: 'no fetch implementation available' }
  // A cancelled refresh does not start another request: this is what makes
  // cancelling cheap when it lands between two sources.
  if (signal?.aborted) return { ok: false, reason: 'cancelled' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  // Two reasons to abort reach the same request: the timeout above, and the
  // service being stopped.
  const combined = signal === undefined ? controller.signal : AbortSignal.any([controller.signal, signal])
  try {
    const response = await fetchImpl(url, {
      signal: combined,
      headers: json
        ? { accept: 'application/json', 'user-agent': 'dsh-token-ledger' }
        : // A page that blocks unknown clients answers 403 to a bare request; these
          // are the headers a browser sends, which is what makes them readable.
          {
            accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
            'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'user-agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
          },
    })
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` }
    // A declared length is free evidence: an oversized body is refused before a
    // byte of it is read.
    const declared = Number.parseInt(response.headers?.get?.('content-length') ?? '', 10)
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return { ok: false, reason: `body too large (>${MAX_BODY_BYTES} bytes)` }
    const body = await readBody(response)
    if (!body.ok) return body
    if (!json) return { ok: true, text: body.text }
    return { ok: true, json: JSON.parse(body.text) }
  } catch (error) {
    const reason = signal?.aborted ? 'cancelled' : error?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : String(error?.message ?? error)
    return { ok: false, reason }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Create the rates service.
 *
 * @param {object} input - the service's dependencies.
 * @param {string} input.path - where to cache fetched state.
 * @param {{ source?: string, modelsUrl?: string, fxUrl?: string, perVendor?: number, vendorLimit?: number, fetchImpl?: typeof fetch, now?: () => number, intervalMs?: number, log?: object }} [input.options] - overrides, mostly for tests.
 * @returns {object} the service.
 */
export function createRatesService({ path, options = {} }) {
  const source = PRICE_SOURCES.includes(options.source) ? options.source : DEFAULT_PRICE_SOURCE
  const modelsUrl = options.modelsUrl ?? SOURCE_URLS[source]
  const fxUrl = options.fxUrl ?? DEFAULT_FX_URL
  const perVendor = options.perVendor ?? MODELS_PER_VENDOR
  const vendorLimit = options.vendorLimit ?? VENDOR_LIMIT
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const now = options.now ?? (() => Date.now())
  const intervalMs = options.intervalMs ?? REFRESH_INTERVAL_MS
  const log = options.log ?? {}

  let state = loadLedger(path) ?? emptyRatesState()
  if (state.version !== 1) state = emptyRatesState()
  if (state.overrides === undefined || typeof state.overrides !== 'object') state.overrides = { models: {}, fx: null }
  if (typeof state.overrides.models !== 'object' || state.overrides.models === null) state.overrides.models = {}

  let timer
  let inFlight
  let inFlightController

  /**
   * Write the state atomically.
   *
   * The write can fail — a full disk, a read-only directory — and a refresh is
   * not the place to throw about it: the numbers it just fetched are already
   * the best ones served. A save, though, has to be told (see `saveOverrides`),
   * because the values it wrote would be gone after a restart.
   *
   * @returns {boolean} whether the state reached the disk.
   */
  const persist = () => {
    try {
      saveLedger(path, state)
      return true
    } catch (error) {
      log.warn?.('[token-ledger] could not write rates cache: %o', error)
      return false
    }
  }

  /**
   * Read the vendors' own pricing pages.
   *
   * Only vendors with a parser are fetched. Each page is independent: one failing
   * is that vendor falling back to the dataset, not the table failing, and every
   * attempt is recorded so the page can show which vendors are live.
   *
   * A page's whole list of priced rows is kept beside the published head of it,
   * so a provider can be expanded to all of its models later without reading the
   * page a second time.
   *
   * @param {{ perVendor?: number, signal?: AbortSignal }} [options] - how many models per vendor, and the signal that stops a cancelled refresh.
   * @returns {Promise<{ byVendor: Map<string, object>, outcome: object[] }>} the rows, and the per-vendor result. A page that yields nothing usable counts as a failure rather than as a vendor with no models.
   */
  const readVendorPages = async ({ perVendor: perVendorCount = perVendor, signal } = {}) => {
    const byVendor = new Map()
    const outcome = []
    for (const [vendor, adapter] of Object.entries(VENDOR_PRICE_SOURCES)) {
      // A refresh that was cancelled stops asking; the remaining pages are not
      // worth a request on a host that is going away.
      if (signal?.aborted) break
      const page = await fetchJson(adapter.url, { fetchImpl, timeoutMs: VENDOR_TIMEOUT_MS, json: false, signal })
      if (signal?.aborted) break
      if (!page.ok) {
        outcome.push({ vendor, ok: false, url: adapter.url, reason: page.reason })
        log.warn?.('[token-ledger] could not read %s prices from %s: %s', vendor, adapter.url, page.reason)
        continue
      }
      let parsed
      try {
        parsed = adapter.parse(page.text)
      } catch (error) {
        outcome.push({ vendor, ok: false, url: adapter.url, reason: String(error?.message ?? error) })
        continue
      }
      const rows = vendorRows(vendor, parsed, { perVendor: perVendorCount })
      if (rows.length === 0) {
        // The page answered but nothing was recognised: a layout change, not an
        // empty catalogue, so it is reported as a failure and the vendor falls
        // back rather than disappearing.
        outcome.push({ vendor, ok: false, url: adapter.url, reason: 'no price rows found on the page' })
        log.warn?.('[token-ledger] %s pricing page yielded no rows: %s', vendor, adapter.url)
        continue
      }
      byVendor.set(vendor, {
        rows,
        // The page's whole list, kept beside the published head of it. Reading
        // a vendor's pricing page is slow and often impossible, so the rows it
        // yielded are kept: the page may want to show every model of this
        // vendor later, and a host that cannot reach the page again cannot
        // rebuild the list. The two agree on order, because the rows are
        // produced model by model in the page's order.
        allModels: vendorRows(vendor, parsed, { perVendor: parsed.models.length }),
        modelCount: parsed.models.length,
        url: adapter.url,
        note: parsed.note ?? '',
        currency: parsed.currency ?? adapter.currency ?? PRICE_CURRENCY,
      })
      outcome.push({ vendor, ok: true, url: adapter.url, models: rows.length })
    }
    return { byVendor, outcome }
  }

  /**
   * Fetch both sources and cache whatever worked.
   *
   * The two are independent: a blocked FX endpoint must not cost the user the
   * model prices, and vice versa.
   *
   * One refresh runs at a time: a caller that arrives while another is running
   * joins it rather than starting a second, so the timer and a page's "refresh
   * now" cannot race each other. Each run owns an `AbortController` that its
   * fetches carry, which is what makes {@link cancelRefresh} able to stop them.
   *
   * @param {{ reason?: string }} [trigger] - why the refresh ran, for the log.
   * @returns {Promise<{ catalogue: string, fx: string }>} per-source outcome.
   */
  const refresh = async (trigger = {}) => {
    if (inFlight !== undefined) return inFlight
    const active = new AbortController()
    inFlightController = active
    inFlight = (async () => {
      const at = now()
      const outcome = { catalogue: 'failed', fx: 'failed' }

      const models = await fetchJson(modelsUrl, { fetchImpl, timeoutMs: MODELS_TIMEOUT_MS, signal: active.signal })
      if (active.signal.aborted) {
        // A cancelled refresh stops asking: the host is going away, so the
        // sources that have not been read yet are not worth a request.
        outcome.catalogue = 'cancelled'
        outcome.fx = 'cancelled'
      } else if (models.ok) {
        const parsed =
          source === 'modelsdev'
            ? parseModelsDev(models.json, { perVendor, vendorLimit })
            : parseCatalogue(models.json, { perVendor, now: at, vendorLimit })
        if (parsed.selected > 0) {
          // Vendors whose own pricing page can be read override their rows. One
          // vendor's page failing is that vendor falling back to the dataset, not
          // the whole table failing, so each is fetched and reported separately.
          const official = await readVendorPages({ perVendor, signal: active.signal })
          const vendors = parsed.vendors
            .map((entry) => {
              const override = official.byVendor.get(entry.vendor)
              // A vendor whose own page was read is shown that page's rows, and
              // that page's whole list with them: the expansion has to be the
              // same prices as the table, not the dataset's.
              if (override === undefined) return { ...entry, source: 'dataset' }
              return {
                ...entry,
                models: override.rows,
                allModels: override.allModels,
                modelCount: override.modelCount,
                source: 'vendor',
                sourceUrl: override.url,
                note: override.note,
                currency: override.currency,
              }
            })
            // A vendor whose own page was read is shown that page's rows, even
            // when the dataset carries it under another id: the page is the
            // vendor's own list price and the dataset's is a platform's.
            .concat(
              [...official.byVendor.entries()]
                .filter(([vendor]) => !parsed.vendors.some((entry) => entry.vendor === vendor))
                .map(([vendor, override]) => ({
                  vendor,
                  modelCount: override.modelCount,
                  models: override.rows,
                  allModels: override.allModels,
                  source: 'vendor',
                  sourceUrl: override.url,
                  note: override.note,
                  currency: override.currency,
                })),
            )
          const ordered = [
            ...MAINSTREAM_VENDORS.filter((vendor) => vendors.some((entry) => entry.vendor === vendor)).map((vendor) =>
              vendors.find((entry) => entry.vendor === vendor),
            ),
            ...vendors.filter((entry) => !MAINSTREAM_VENDORS.includes(entry.vendor)),
          ]
          const shown = vendorLimit > 0 ? ordered.slice(0, vendorLimit) : ordered

          state.catalogue = {
            source: modelsUrl,
            sourceId: source,
            fetchedAt: at,
            ok: true,
            vendorCount: shown.length,
            availableVendorCount: ordered.length,
            modelCount: shown.reduce((sum, entry) => sum + entry.models.length, 0),
            totalAvailable: parsed.total,
            perVendor,
            vendorLimit,
            currency: PRICE_CURRENCY,
            vendorPages: official.outcome,
            vendors: shown,
          }
          outcome.catalogue = `ok (${state.catalogue.modelCount} models, ${shown.length} of ${ordered.length} vendors, ${source}; ${official.outcome.filter((entry) => entry.ok).length} vendor page(s) read)`
        } else {
          outcome.catalogue = 'failed (no usable models in the response)'
        }
      } else {
        outcome.catalogue = `failed (${models.reason})`
      }

      if (!active.signal.aborted) {
        const fx = await fetchJson(fxUrl, { fetchImpl, timeoutMs: FX_TIMEOUT_MS, signal: active.signal })
        if (fx.ok) {
          const parsed = parseFx(fx.json, { quote: QUOTE_CURRENCY })
          if (parsed !== undefined) {
            state.fx = { source: fxUrl, fetchedAt: at, ok: true, ...parsed }
            outcome.fx = `ok (1 ${parsed.base} = ${parsed.rate} ${parsed.quote})`
          } else {
            outcome.fx = 'failed (no usable rate in the response)'
          }
        } else {
          outcome.fx = `failed (${fx.reason})`
        }
      }

      // A cancel that landed in the middle of a run taints what it had reached:
      // a half-read catalogue is not an answer, and neither is a rate fetched
      // before the cancel. Both are reported as cancelled rather than as ok.
      if (active.signal.aborted) {
        outcome.catalogue = 'cancelled'
        outcome.fx = 'cancelled'
      }

      // A cancelled refresh is a shutdown, not an answer: it does not rewrite
      // the cache with a failed attempt.
      if (!active.signal.aborted) {
        persist()
        // The last *attempt* is recorded separately from the last success. A page
        // that only knew "last successful fetch" could not tell a user that the
        // refresh has been failing for an hour while showing hour-old numbers.
        state.lastRefresh = { at, catalogue: outcome.catalogue, fx: outcome.fx }
        persist()
      }
      log.info?.('[token-ledger] rates refresh (%s): catalogue %s, fx %s', trigger.reason ?? 'timer', outcome.catalogue, outcome.fx)
      return outcome
    })().finally(() => {
      // The controller and the in-flight promise are dropped whichever way the
      // run ended, so the next refresh starts clean and a late cancel has
      // nothing left to abort.
      if (inFlightController === active) inFlightController = undefined
      inFlight = undefined
    })
    return inFlight
  }

  /**
   * Stop the fetch a refresh has in flight, and wait for the refresh to settle.
   *
   * Called when the host disposes the plugin: a refresh is up to a minute on the
   * price list and one request per vendor pricing page after that, and a socket
   * that outlives the plugin keeps the process alive and writes the cache after
   * the plugin was supposed to be gone. Aborting the run's controller makes
   * every request it has not finished fail as `cancelled` instead of hanging;
   * the promise settles when the refresh body has finished its bookkeeping.
   *
   * @returns {Promise<object|void>} the in-flight refresh's outcome, or an already-resolved promise when none is running.
   */
  const cancelRefresh = () => {
    inFlightController?.abort()
    return inFlight ?? Promise.resolve()
  }

  /** Schedule the periodic refresh; the timer must not hold the host open. */
  const start = () => {
    if (timer !== undefined) return
    timer = setInterval(() => {
      void refresh({ reason: 'timer' })
    }, intervalMs)
    timer.unref?.()
  }

  const stop = () => {
    if (timer === undefined) return
    clearInterval(timer)
    timer = undefined
  }

  /**
   * The effective state, with overrides applied and freshness attached.
   *
   * The payload stays small on purpose: it is also the price catalogue the bill
   * and the overview price from, so the whole list of every provider is not
   * published here. {@link readVendor} serves one provider's list when the page
   * asks for it.
   *
   * @returns {object} everything the rates page needs, in plain JSON.
   */
  const read = () => {
    const at = now()
    const catalogue = state.catalogue
    const { vendors, fx, overriddenModels, fxOverridden, pending } = applyOverrides({
      vendors: catalogue?.vendors ?? [],
      fx: state.fx,
      overrides: state.overrides,
    })
    return {
      plugin: 'token-ledger',
      generatedAt: at,
      refreshIntervalMs: intervalMs,
      perVendor,
      vendorLimit,
      priceSource: source,
      currency: PRICE_CURRENCY,
      quote: QUOTE_CURRENCY,
      catalogue: {
        available: catalogue !== undefined,
        fetchedAt: catalogue?.fetchedAt ?? null,
        ageMs: catalogue?.fetchedAt === undefined ? null : at - catalogue.fetchedAt,
        source: catalogue?.source ?? modelsUrl,
        sourceId: catalogue?.sourceId ?? source,
        totalAvailable: catalogue?.totalAvailable ?? null,
        modelCount: catalogue?.modelCount ?? 0,
        vendorCount: catalogue?.vendorCount ?? 0,
        availableVendorCount: catalogue?.availableVendorCount ?? null,
        // Which vendor pages were read, and which fell back. The page shows this
        // because "the vendor's own price" is a claim about where a number came
        // from, and a claim that is wrong is worse than no claim.
        vendorPages: catalogue?.vendorPages ?? [],
      },
      fx: {
        available: fx?.rate !== undefined && fx?.rate !== null,
        rate: fx?.rate ?? null,
        base: fx?.base ?? 'USD',
        quote: fx?.quote ?? QUOTE_CURRENCY,
        source: fx?.source ?? fxUrl,
        fetchedAt: fx?.fetchedAt ?? null,
        ageMs: typeof fx?.fetchedAt === 'number' ? at - fx.fetchedAt : null,
        overridden: fxOverridden,
      },
      overriddenModels,
      // Rows where what was typed disagrees with what the catalogue publishes, so
      // the page can ask which one to keep. Derived here rather than in the page
      // because only the host has both numbers.
      pending,
      lastRefresh: {
        at: state.lastRefresh?.at ?? null,
        ageMs: typeof state.lastRefresh?.at === 'number' ? at - state.lastRefresh.at : null,
        catalogue: state.lastRefresh?.catalogue ?? null,
        fx: state.lastRefresh?.fx ?? null,
      },
      // The published table stays small. Every provider's whole list lives in
      // the cache and is served one provider at a time, because the page asks
      // for this payload on every poll.
      vendors: vendors.map((entry) => {
        const published = { ...entry }
        const full = Array.isArray(entry.allModels) ? entry.allModels : (entry.models ?? [])
        delete published.allModels
        return {
          ...published,
          // Whether there is more to show, and how much: the page offers the
          // expander on the first and says what it will find on the second.
          expandable: full.length > (entry.models?.length ?? 0),
          expandedCount: full.length,
        }
      }),
    }
  }

  /**
   * The price catalogue the bill and the overview price from.
   *
   * The same payload the page reads, with every provider's whole list of priced
   * models instead of the few the table shows.
   *
   * The bill prices usage by model, and usage is not limited to the newest
   * model of each provider. With only the published head it could price a
   * fraction of the models the catalogue carries — a third of them, on the
   * dataset as it stands — and every other call was reported as unpriced,
   * which is honest but leaves most of a bill at zero.
   *
   * @returns {object} the catalogue, in plain JSON.
   */
  const readCatalogue = () => {
    const payload = read()
    const full = (state.catalogue?.vendors ?? []).map((entry) => ({
      ...entry,
      models: Array.isArray(entry.allModels) && entry.allModels.length > 0 ? entry.allModels : entry.models,
    }))
    // The hand-entered values are merged in the same way the published rows
    // are, so a typed price is the price the bill charges.
    const merged = applyOverrides({ vendors: full, fx: state.fx, overrides: state.overrides }).vendors
    return { ...payload, vendors: merged }
  }

  /**
   * One provider's whole list of priced models.
   *
   * The published table shows a few models per provider; this serves the rest
   * of them, on demand, so the page can expand a provider without every
   * reader paying for every model of every provider.
   *
   * The hand-entered prices are merged in the same way the published rows are,
   * so a model typed by hand reads the same in the expanded list as it does in
   * the table.
   *
   * @param {string} vendor - the vendor id.
   * @returns {{ vendor: string, modelCount: number, publishedCount: number, models: object[] }|undefined} the provider's list, or undefined when the catalogue does not carry that provider.
   */
  const readVendor = (vendor) => {
    if (typeof vendor !== 'string' || vendor === '') return undefined
    const entry = (state.catalogue?.vendors ?? []).find((candidate) => candidate.vendor === vendor)
    if (entry === undefined) return undefined
    const published = Array.isArray(entry.models) ? entry.models : []
    // A catalogue written by an older host carries no full list, so the
    // published rows are the whole of what can be served.
    const full = Array.isArray(entry.allModels) ? entry.allModels : published
    const overrides = state.overrides?.models ?? {}
    const models = full.map((model) => mergeModelOverride(model, overrides[model.id]).model)
    return { vendor: entry.vendor, modelCount: models.length, publishedCount: published.length, models }
  }

  /**
   * The prices the catalogue publishes for a model, if it describes one.
   *
   * The published head is not the whole catalogue: a model a reader expanded a
   * vendor to find is described by the same fetch, and a "keep mine" answer for
   * one of those rows has to record the same official number. The full list is
   * therefore searched as well as the head.
   *
   * @param {string} id - the model id.
   * @returns {object|undefined} the published prices, or undefined when no fetched row carries the id.
   */
  const publishedPrices = (id) => {
    for (const entry of state.catalogue?.vendors ?? []) {
      const rows = Array.isArray(entry.allModels) && entry.allModels.length > 0 ? entry.allModels : (entry.models ?? [])
      for (const model of rows) {
        if (model.id === id) return model.prices
      }
    }
    return undefined
  }

  /**
   * Store hand-entered values, and the two answers to a disagreement with them.
   *
   * `adopt` deletes the typed value for the named buckets, which is what hands
   * those fields back to the catalogue: an override equal to the published number
   * would freeze the row at today's price instead of following it. `keep` writes
   * down the published numbers the user decided against, in the override's own
   * `ack`, so the same disagreement is not raised again until the catalogue
   * actually moves.
   *
   * @param {unknown} body - the request body.
   * @returns {{ ok: true, saved: object }|{ ok: false, error: string }} the outcome. A write that cannot reach the disk is a failure, not a save: the values would be gone after a restart.
   */
  const saveOverrides = (body) => {
    const validated = validateOverrides(body)
    if (!validated.ok) return validated
    const patch = validated.patch
    if (patch.fx !== undefined) state.overrides.fx = patch.fx
    if (patch.models !== undefined) {
      for (const [id, value] of Object.entries(patch.models)) {
        if (value === null) delete state.overrides.models[id]
        else state.overrides.models[id] = value
      }
    }
    let adopted = 0
    if (patch.adopt !== undefined) {
      for (const [id, keys] of Object.entries(patch.adopt)) {
        const current = state.overrides.models[id]
        if (current === undefined || current === null || typeof current !== 'object') continue
        for (const key of keys) delete current[key]
        adopted += 1
        // Something with no typed price left is not an override, and its record of
        // what was reviewed goes with it.
        if (!PRICE_KEYS.some((key) => key in current)) delete state.overrides.models[id]
      }
    }
    let kept = 0
    if (patch.keep !== undefined) {
      for (const [id, keys] of Object.entries(patch.keep)) {
        const current = state.overrides.models[id]
        if (current === undefined || current === null || typeof current !== 'object') continue
        const published = publishedPrices(id)
        if (published === undefined) continue
        const ack = current.ack !== undefined && current.ack !== null && typeof current.ack === 'object' ? { ...current.ack } : {}
        for (const key of keys) ack[key] = published[key] ?? null
        current.ack = ack
        kept += 1
      }
    }
    if (persist() === false) return { ok: false, error: 'could not store the price overrides' }
    return {
      ok: true,
      saved: { models: Object.keys(state.overrides.models).length, fx: state.overrides.fx !== null, adopted, kept },
    }
  }

  return { refresh, start, stop, cancelRefresh, read, readCatalogue, readVendor, saveOverrides, statePath: path }
}
