#!/usr/bin/env node
/**
 * The local replacement for the CI job that checked what the published tarball
 * actually contains.
 *
 * `pnpm run verify` proves the manifest's promises hold. This proves the
 * *artifact* does:
 *
 * 1. `npm pack` produces a tarball carrying every file an installer needs;
 * 2. nothing test-only leaks into it — no test files, no CI files, and only
 *    Markdown under `docs/`;
 * 3. the CLI runs from the *installed* copy, not from the checkout;
 * 4. the CLI can rebuild and audit a ledger from a real session log.
 *
 * This used to be a GitHub Actions job. It is a script now, so it runs on the
 * machine that is about to publish, against the tarball that machine produced.
 *
 * Run with `pnpm run check:tarball`.
 *
 * @module dsh-token-ledger/scripts/check-tarball
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'
import { run, npm } from './lib/shell.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const failures = []
const notes = []

/**
 * Record a check result.
 *
 * @param {boolean} ok - whether the check passed.
 * @param {string} label - the human-readable check.
 * @param {string} [detail] - extra context on failure.
 * @returns {void}
 */
function check(ok, label, detail = '') {
  if (ok) notes.push(`  ok    ${label}`)
  else failures.push(`  FAIL  ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

const work = mkdtempSync(join(tmpdir(), 'dsh-token-ledger-tarball-'))

try {
  // ---------------------------------------------------------------- pack
  const packed = npm(['pack', '--pack-destination', work, '--silent'], { cwd: root })
  if (packed.status !== 0) {
    console.error(packed.stdout + packed.stderr)
    throw new Error('npm pack failed')
  }
  const tarballName = packed.stdout.trim().split(/\r?\n/).filter(Boolean).pop()
  const tarball = join(work, tarballName)
  check(existsSync(tarball), 'npm pack produced a tarball', tarballName)

  // ---------------------------------------------------------------- contents
  const listing = run('tar', ['-tzf', tarball], { cwd: root })
  if (listing.status !== 0) {
    console.error(listing.stderr)
    throw new Error('cannot read the tarball')
  }
  const files = listing.stdout.split(/\r?\n/).filter(Boolean)

  const required = [
    'package/package.json',
    'package/lib/index.js',
    'package/lib/cli.js',
    'package/lib/ledger.js',
    'package/lib/session-log.js',
    'package/lib/store.js',
    'package/bin/dsh-token-ledger.mjs',
    'package/cordis.patch.yml',
    'package/README.md',
    'package/README.zh.md',
    'package/LICENSE',
  ]
  for (const name of required) {
    check(files.includes(name), `the tarball carries ${name}`)
  }
  check(files.includes('package/docs/VERIFICATION.md'), 'the tarball carries the verification document')
  // The docs index has to travel with the package: the READMEs link into
  // docs/, and npm resolves those links against the repository.
  check(files.includes('package/docs/README.md'), 'the tarball carries the docs index')

  // Everything shipped under docs/ has to be Markdown. `docs/` is listed in
  // `files` wholesale, so any other file lands in the tarball too — that is
  // how a scratch HTML preview of the vendor marks got published.
  const strayDocs = files.filter((f) => f.startsWith('package/docs/') && !f.endsWith('.md'))
  check(strayDocs.length === 0, 'docs/ ships Markdown only', strayDocs.join(', '))

  // No test or CI files should ship.
  const leaked = files.filter((f) => /^package\/(test|\.github)\//.test(f))
  check(leaked.length === 0, 'no tests or CI files leak into the tarball', leaked.join(', '))

  // ---------------------------------------------------------------- install
  const consumer = join(work, 'consumer')
  mkdirSync(consumer, { recursive: true })
  const init = npm(['init', '-y'], { cwd: consumer })
  check(init.status === 0, 'the throwaway consumer project is created')
  const install = npm(
    ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--prefer-offline', tarball],
    { cwd: consumer },
  )
  if (install.status !== 0) console.error(install.stdout + install.stderr)
  check(install.status === 0, 'the tarball installs into a throwaway project')

  const cli = join(consumer, 'node_modules', ...manifest.name.split('/'), 'bin', 'dsh-token-ledger.mjs')
  check(existsSync(cli), 'the installed copy carries the CLI', cli)

  if (existsSync(cli)) {
    const version = run(process.execPath, [cli, '--version'], { cwd: consumer })
    check(
      version.status === 0 && version.stdout.trim() === manifest.version,
      'the installed CLI reports the manifest version',
      version.stdout.trim() || version.stderr.trim(),
    )
    const help = run(process.execPath, [cli, '--help'], { cwd: consumer })
    check(help.status === 0 && help.stdout.includes('audit'), 'the installed CLI lists the audit command')

    // -------------------------------------------------- end-to-end ledger
    const home = join(work, 'fake-home')
    const dir = join(home, 'sessions', '--ws--', 'sess-demo')
    mkdirSync(dir, { recursive: true })
    const events = [
      { type: 'session', version: 0, id: 'sess-demo', createdAt: 1, cwd: '/ws' },
      {
        type: 'request/header',
        seq: 1,
        time: Date.now(),
        data: { header: { config: { provider: 'p', model: 'm' } } },
      },
      {
        type: 'assistant/message',
        seq: 2,
        time: Date.now(),
        data: {
          turn: 1,
          step: 1,
          usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30 },
        },
      },
    ]
    const frames = events.map((e) => zstdCompressSync(Buffer.from(JSON.stringify(e) + '\n')))
    writeFileSync(join(dir, 'session.jsonl.zstd'), Buffer.concat(frames))

    const rebuild = run(process.execPath, [cli, 'rebuild', '--home', home, '--write'], { cwd: consumer })
    check(
      rebuild.status === 0,
      'the installed CLI rebuilds a ledger from a session log',
      (rebuild.stdout + rebuild.stderr).trim().slice(0, 300),
    )

    const audit = run(process.execPath, [cli, 'audit', '--home', home], { cwd: consumer })
    check(
      audit.status === 0,
      'the installed CLI audits the rebuilt ledger',
      (audit.stdout + audit.stderr).trim().slice(0, 300),
    )

    const summary = run(process.execPath, [cli, 'summary', '--home', home, '--json'], { cwd: consumer })
    check(
      summary.status === 0 && summary.stdout.includes('"totalTokens": 150'),
      'the rebuilt ledger totals the expected tokens',
      summary.stdout.trim().slice(0, 300),
    )
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}

console.log(notes.join('\n'))
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:\n${failures.join('\n')}`)
  process.exit(1)
}
console.log(`\nall ${notes.filter((n) => n.startsWith('  ok')).length} checks passed`)
