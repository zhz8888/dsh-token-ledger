#!/usr/bin/env node
/**
 * Check the plugin's models.dev integration against the live price list.
 *
 * The price list is someone else's data, and it moves: vendors retire models,
 * rename them, add platforms, and publish a pointer under a second name. This
 * script fetches the live list, runs the plugin's own parser over it, and
 * prints what the plugin would publish — so the assumptions in `lib/rates.js`
 * (the provider ids, the shapes, the counts) are checked against the source
 * rather than against a reading of it.
 *
 * It needs the network, and it prints; it changes nothing.
 *
 * Run it from the repository root: `node tools/models-dev-check.mjs`.
 *
 * @module dsh-token-ledger/tools/models-dev-check
 */

import { readFileSync } from 'node:fs'

import { MAINSTREAM_VENDORS, MODELS_PER_VENDOR, VENDOR_LIMIT, parseModelsDev } from '../lib/rates.js'

const source = readFileSync(new URL('../lib/rates.js', import.meta.url), 'utf8')
const mapping = /const MODELSDEV_PROVIDER = \{([\s\S]*?)\n\}/.exec(source)
const MODELSDEV_PROVIDER = Object.fromEntries(
  [...mapping[1].matchAll(/'?([a-z-]+)'?:\s*'([a-z0-9-]+)'/g)].map((match) => [match[1], match[2]]),
)

const controller = new AbortController()
const timer = setTimeout(() => controller.abort(), 120000)
let text
try {
  const response = await fetch('https://models.dev/api.json', {
    headers: { accept: 'application/json', 'user-agent': 'dsh-token-ledger' },
    signal: controller.signal,
  })
  text = await response.text()
} catch (error) {
  console.error(`could not read the price list: ${error.message}${error.cause?.code === undefined ? '' : ` (${error.cause.code})`}`)
  console.error('The source is reachable from a browser; the plugin keeps the last good catalogue when it is not.')
  process.exit(1)
} finally {
  clearTimeout(timer)
}
const payload = JSON.parse(text)
const providers = Object.keys(payload)

let models = 0
let priced = 0
let tiers = 0
let deprecated = 0
for (const provider of Object.values(payload)) {
  for (const model of Object.values(provider?.models ?? {})) {
    models += 1
    if (model?.cost === null || typeof model?.cost !== 'object') continue
    priced += 1
    if (Array.isArray(model.cost.tiers)) tiers += 1
    if (model.status === 'deprecated') deprecated += 1
  }
}

console.log(`models.dev: ${providers.length} providers, ${models} models, ${priced} priced, ${deprecated} retired`)
console.log(`response: ${(text.length / 1024 / 1024).toFixed(1)} MB`)
console.log(`cost blocks carrying tiers: ${tiers}`)

console.log('\nthe curated vendors:')
for (const vendor of MAINSTREAM_VENDORS) {
  const providerId = MODELSDEV_PROVIDER[vendor]
  const provider = providerId === undefined ? undefined : payload[providerId]
  const list = Object.values(provider?.models ?? {})
  const withPrice = list.filter((model) => model?.cost !== null && typeof model?.cost === 'object' && (model.cost.input !== undefined || model.cost.output !== undefined))
  const retired = withPrice.filter((model) => model.status === 'deprecated')
  console.log(
    `  ${vendor.padEnd(11)} -> ${String(providerId).padEnd(18)} ${provider === undefined ? 'MISSING FROM THE SOURCE' : `models=${String(list.length).padStart(3)} priced=${String(withPrice.length).padStart(3)} retired=${String(retired.length).padStart(3)}`}`,
  )
}

const parsed = parseModelsDev(payload, { perVendor: MODELS_PER_VENDOR, vendorLimit: VENDOR_LIMIT })
console.log(`\nwhat the page publishes: ${parsed.vendors.length} vendors of ${parsed.availableVendorCount}, ${parsed.selected} rows of ${parsed.total}`)
for (const entry of parsed.vendors) {
  console.log(`  ${entry.vendor.padEnd(11)} ${String(entry.modelCount).padStart(3)} models → ${entry.models.map((model) => model.id).join(', ')}`)
}

console.log('\nthe whole list of each vendor, and what it holds:')
for (const entry of parsed.vendors) {
  const retired = entry.allModels.filter((model) => model.retired === true)
  console.log(`  ${entry.vendor.padEnd(11)} ${entry.allModels.length} rows, ${retired.length} retired`)
}
