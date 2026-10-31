#!/usr/bin/env node
/**
 * Render the section's view switcher next to the plugin market's own, so the
 * two can be compared by eye.
 *
 * The market's bar is rebuilt from the host's own markup and CSS — the
 * `SegmentedTabs` primitive of `@deepseek-ai/dsh-client-ui-primitives` and the
 * `PluginManagerPage` placement around it — so the reference is the real thing
 * and not a sketch of it.
 *
 * @returns {void}
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const react = require('react')
const server = require('react-dom/server')

/** Load the browser half, giving its factory the real React. */
function loadClient() {
  let registration
  globalThis.window = { __ModuleLoader__: { load: (definition) => (registration = definition) } }
  globalThis.document = {
    head: { appendChild: () => {} },
    getElementById: () => null,
    createElement: () => ({ dataset: {}, remove: () => {}, textContent: '', id: '' }),
  }
  const source = readFileSync(join(root, 'lib/client.js'), 'utf8')
  new Function('require', source)((name) => {
    if (name === 'react') return react
    throw new Error(`unexpected require("${name}")`)
  })
  return registration.factory((name) => (name === 'react' ? react : undefined))
}

/** The plugin's own stylesheet, read out of the source it lives in. */
function pluginCss() {
  const source = readFileSync(join(root, 'lib/client.js'), 'utf8')
  const start = source.indexOf('const CSS = `')
  if (start < 0) throw new Error('the stylesheet was not found in lib/client.js')
  const from = start + 'const CSS = `'.length
  const end = source.indexOf('\n`', from)
  return source.slice(from, end)
}

const client = loadClient()
const labels = { overview: '概览', rates: '费率', bill: '账单' }
const options = [
  { value: 'overview', label: labels.overview },
  { value: 'rates', label: labels.rates },
  { value: 'bill', label: labels.bill },
]

const markup = (value) =>
  server.renderToStaticMarkup(
    react.createElement(client.ViewTabs, {
      value,
      label: '账本视图',
      options,
      onChange: () => {},
    }),
  )

/** The host's own bar: the `SegmentedTabs` primitive, as the market renders it. */
const marketCss = `
/* The Pill the primitive builds every tab on. The host injects this stylesheet
   before the tab stylesheet, so the tab rules win — the order matters here too. */
.market-pill { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 8px; border: none; border-radius: 999px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); }
.market-interactive { cursor: pointer; }
.market-interactive:hover { background: var(--dsw-alias-interactive-bg-hover); }
.market-tabs { position: relative; display: grid; padding: 4px; border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-bg-module-platform); }
.market-indicator { position: absolute; inset: 4px auto 4px 4px; box-sizing: border-box; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-3); transition: transform 180ms ease; pointer-events: none; }
.market-tab { position: relative; justify-content: center; height: 34px; padding: 0 12px; border-radius: var(--dsw-radius-md); font-size: 14px; line-height: 20px; background: transparent; color: var(--dsw-alias-label-secondary); transition: color 180ms ease; }
.market-tab:hover, .market-tab[aria-selected='true'] { background: transparent; color: var(--dsw-alias-label-primary); }
.market-tab[aria-selected='true'] { font-weight: 600; }
.market-tab:focus-visible { outline: none; text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 4px; }
.market-pageTabs { margin-top: -16px; display: flex; }
.market-pageTabList { width: fit-content; min-width: 240px; }
`

const marketMarkup = (selected) => `
<div class="market-pageTabs">
  <div role="tablist" aria-label="插件视图" class="market-tabs market-pageTabList" style="grid-template-columns: repeat(3, minmax(0, 1fr))">
    <span class="market-indicator" aria-hidden="true" style="width: calc((100% - 8px) / 3); transform: translateX(${selected * 100}%)"></span>
    ${['已安装', '发现', '社区']
      .map(
        (label, index) =>
          `<button id="market-tab-${index}" type="button" role="tab" class="market-pill market-interactive market-tab" aria-selected="${index === selected}" aria-controls="market-panel-${index}" tabindex="${index === selected ? 0 : -1}">${label}</button>`,
      )
      .join('')}
  </div>
</div>`

/** The design tokens the host's own theme defines, for both of its themes. */
const tokens = `
:root {
  --dsw-radius-xs: 4px; --dsw-radius-sm: 8px; --dsw-radius-md: 12px; --dsw-radius-lg: 16px; --dsw-radius-xl: 20px;
  --dsw-alias-bg-module-platform: #f5f6f7;
  --dsw-alias-bg-layer-2: #ffffff;
  --dsw-alias-bg-layer-3: #ffffff;
  --dsw-alias-border-l3: #0000001f;
  --dsw-alias-interactive-bg-hover: #2631480f;
  --dsw-alias-label-primary: #0f1115;
  --dsw-alias-label-secondary: #61666b;
  --dsw-alias-label-tertiary: #81858c;
}
body[data-ds-dark-theme] {
  --dsw-alias-bg-module-platform: #353638;
  --dsw-alias-bg-layer-2: #2c2c2e;
  --dsw-alias-bg-layer-3: #353638;
  --dsw-alias-border-l3: #ffffff29;
  --dsw-alias-interactive-bg-hover: #ffffff14;
  --dsw-alias-label-primary: #f9fafb;
  --dsw-alias-label-secondary: #cfd3d6;
  --dsw-alias-label-tertiary: #adb5bd;
}
`

const page = (theme) => `<!doctype html>
<html><head><meta charset="utf-8">
<style>${tokens}${marketCss}${pluginCss()}
body { margin: 0; padding: 28px; background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-primary); font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
.row { margin-bottom: 26px; }
.caption { font-size: 12px; color: var(--dsw-alias-label-tertiary); margin-bottom: 8px; }
.panel { display: block; width: 560px; padding: 14px 16px; border-radius: 12px; background: var(--dsw-alias-bg-layer-2); border: .5px solid var(--dsw-alias-border-l3); }
</style></head>
<body${theme === 'dark' ? ' data-ds-dark-theme="true"' : ''}>
<div class="row">
  <div class="caption">插件市场 · PluginManagerPage（宿主自带，参考）</div>
  <div class="panel">${marketMarkup(1)}</div>
</div>
<div class="row">
  <div class="caption">改动后 · token-ledger 顶部视图切换（选中「费率」）</div>
  <div class="panel"><div class="tl-root"><div class="tl-row">${markup('rates')}</div></div></div>
</div>
<div class="row">
  <div class="caption">改动后 · token-ledger 顶部视图切换（选中「概览」）</div>
  <div class="panel"><div class="tl-root"><div class="tl-row">${markup('overview')}</div></div></div>
</div>
</body></html>`

mkdirSync(join(root, '.tmp'), { recursive: true })
writeFileSync(join(root, '.tmp/viewtabs-light.html'), page('light'))
writeFileSync(join(root, '.tmp/viewtabs-dark.html'), page('dark'))
console.log('wrote .tmp/viewtabs-light.html and .tmp/viewtabs-dark.html')
