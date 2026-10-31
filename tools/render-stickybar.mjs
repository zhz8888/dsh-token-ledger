#!/usr/bin/env node
/**
 * Render the settings section inside the host's own settings panel, so the
 * pinned view switcher can be watched while the page scrolls under it.
 *
 * The panel is rebuilt from `@deepseek-ai/dsh-client-ui-settings-general`:
 * the nav column, the fixed header, and the options column that scrolls. The
 * section is the plugin's own markup, and the body under the switcher is a
 * stack of cards tall enough to scroll.
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
const options = [
  { value: 'overview', label: '概览' },
  { value: 'rates', label: '费率' },
  { value: 'bill', label: '账单' },
  { value: 'backup', label: '备份' },
]

const markup = (value) =>
  server.renderToStaticMarkup(
    react.createElement(client.ViewTabs, { value, label: '账本视图', options, onChange: () => {} }),
  )

/** The backup page, as the browser half renders it. */
const dictionaries = {
  zh: JSON.parse(readFileSync(join(root, 'locale/zh.json'), 'utf8')),
  en: JSON.parse(readFileSync(join(root, 'locale/en.json'), 'utf8')),
}
const backupMarkup = (locale) =>
  server.renderToStaticMarkup(
    react.createElement(client.BackupView, {
      t: (key) => dictionaries[locale][key] ?? key,
      state: { status: 'ready', data: { ledgerUpdatedAt: new Date(2026, 9, 31, 12, 0, 0).getTime() }, error: null },
      databases: {
        status: 'ready',
        connections: [
          { id: 'gitea', name: 'Gitea', type: 'mariadb', host: '127.0.0.1', port: 3306, database: 'gitea', user: 'gitea', hasPassword: true },
          { id: 'telegram-files', name: 'Telegram Files', type: 'postgres', host: '192.168.78.10', port: 5432, database: 'telegram-files', user: 'telegram-files', hasPassword: true },
        ],
        backups: [
          { name: 'gitea-2026-10-31T12-00-00-000Z.sql', bytes: 6_082_944, at: 1 },
          { name: 'telegram-files-2026-10-30T03-12-00-000Z.sql', bytes: 1_073_741_824, at: 2 },
        ],
        busy: null,
        notice: null,
      },
      onDatabase: () => {},
    }),
  )

/** The panel chrome, as the host's settings shell draws it. */
const panelCss = `
.panel { width: 800px; height: min(800px, calc(100vh - 48px)); border-radius: var(--dsw-radius-panel); background: var(--dsw-alias-bg-layer-2); box-shadow: var(--dsw-elevation-prominent); display: flex; position: relative; overflow: hidden; }
.nav { box-sizing: border-box; flex-direction: column; flex: none; gap: 18px; width: 188px; padding: 22px 12px 0; display: flex; }
.navTitle { color: var(--dsw-alias-label-primary); padding: 0 12px; font-size: 16px; font-weight: 500; line-height: 24px; }
.navList { flex-direction: column; gap: 4px; display: flex; }
.navCell { border-radius: var(--dsw-radius-md); height: 40px; color: var(--dsw-alias-label-primary); text-align: left; padding: 9px 16px 9px 12px; font-size: 14px; line-height: 22px; display: flex; align-items: center; }
.navCell.active { background: var(--dsw-specific-sidebar-nav-item-active); }
.content { flex-direction: column; flex: 1; min-width: 0; display: flex; }
.header { box-sizing: border-box; flex: none; justify-content: space-between; align-items: flex-start; gap: 8px; height: 54px; padding: 20px 14px 8px 10px; display: flex; }
.options { flex: 1; min-height: 0; padding: 0 24px 24px; overflow-y: auto; }
`

/** The host's design tokens, for both of its themes. */
const tokens = `
:root {
  --dsw-radius-xs: 4px; --dsw-radius-sm: 8px; --dsw-radius-md: 12px; --dsw-radius-lg: 16px; --dsw-radius-xl: 20px; --dsw-radius-panel: 28px;
  --dsw-alias-bg-base: #ffffff;
  --dsw-alias-bg-layer-1: #ffffff;
  --dsw-alias-bg-layer-2: #ffffff;
  --dsw-alias-bg-layer-3: #ffffff;
  --dsw-alias-bg-module-platform: #f5f6f7;
  --dsw-alias-border-l3: #0000001f;
  --dsw-alias-border-l4: #00000029;
  --dsw-alias-interactive-bg-hover: #2631480f;
  --dsw-alias-label-primary: #0f1115;
  --dsw-alias-label-secondary: #61666b;
  --dsw-alias-label-tertiary: #81858c;
  --dsw-specific-sidebar-nav-item-active: #ebeef2;
  --dsw-elevation-prominent: 0 24px 64px rgba(0,0,0,.18);
}
body[data-ds-dark-theme] {
  --dsw-alias-bg-base: #151517;
  --dsw-alias-bg-layer-1: #232324;
  --dsw-alias-bg-layer-2: #2c2c2e;
  --dsw-alias-bg-layer-3: #353638;
  --dsw-alias-bg-module-platform: #353638;
  --dsw-alias-border-l3: #ffffff29;
  --dsw-alias-border-l4: #ffffff3d;
  --dsw-alias-interactive-bg-hover: #ffffff14;
  --dsw-alias-label-primary: #f9fafb;
  --dsw-alias-label-secondary: #cfd3d6;
  --dsw-alias-label-tertiary: #adb5bd;
  --dsw-specific-sidebar-nav-item-active: #353638;
  --dsw-elevation-prominent: 0 24px 64px rgba(0,0,0,.5);
}
`

/** A tall body, so the options column really scrolls. */
const body = Array.from({ length: 14 }, (_, index) => `
  <div class="tl-card" style="min-height: 96px">
    <div class="tl-card-title">账单分组 ${index + 1}</div>
    <div class="tl-note">工作区 / 会话 / 模型 / 供应商 —— 每个分组各有自己的时间段。</div>
  </div>`).join('')

const page = (theme) => {
  const locale = theme === 'dark' ? 'zh' : 'zh'
  return `<!doctype html>
<html><head><meta charset="utf-8">
<style>${tokens}${panelCss}${pluginCss()}
body { margin: 0; padding: 24px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
</style></head>
<body${theme === 'dark' ? ' data-ds-dark-theme="true"' : ''}>
<div class="panel">
  <div class="nav">
    <div class="navTitle">设置</div>
    <div class="navList">
      <div class="navCell">通用</div>
      <div class="navCell">模型</div>
      <div class="navCell active">用量账本</div>
    </div>
  </div>
  <div class="content">
    <div class="header"><div style="margin-left:auto">×</div></div>
    <div class="options" id="options">
      <div class="tl-root">
        <div class="tl-row tl-view-bar">${markup('backup')}</div>
        <div class="tl-panel">${backupMarkup(locale)}${body}</div>
      </div>
    </div>
  </div>
</div>
</body></html>`
}

mkdirSync(join(root, '.tmp'), { recursive: true })
writeFileSync(join(root, '.tmp/stickybar-light.html'), page('light'))
writeFileSync(join(root, '.tmp/stickybar-dark.html'), page('dark'))
console.log('wrote .tmp/stickybar-light.html and .tmp/stickybar-dark.html')
