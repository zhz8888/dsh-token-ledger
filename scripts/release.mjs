#!/usr/bin/env node
/**
 * The local release driver.
 *
 * This is what the Release workflow used to do, and it is now a script you run
 * on the machine that is doing the releasing. Nothing here talks to a CI
 * runner: the tests, the packaging checks, the pack, the publish, the registry
 * assertion and the release itself all happen locally, in order, in front of
 * you.
 *
 *   node scripts/release.mjs --dry-run     # check everything, publish nothing
 *   node scripts/release.mjs                # publish
 *
 * The order is the point. Each step refuses to run until the one before it
 * passed, so a failed release stops at the step that failed instead of
 * publishing something untested.
 *
 * @module dsh-token-ledger/scripts/release
 */

import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run, npm } from './lib/shell.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = manifest.version
const packageName = manifest.name

const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
const DEFAULT_GITEA = 'http://100.113.42.54:3088'
const DEFAULT_NOTES = 'See [CHANGELOG.md](CHANGELOG.md) for what changed.'

const options = {
  dryRun: false,
  notes: null,
  otp: null,
  registry: DEFAULT_REGISTRY,
  skipTests: false,
  allowDirty: false,
  force: false,
  mirrorGitea: false,
  gitea: DEFAULT_GITEA,
  giteaRepo: 'zhz8888/dsh-token-ledger',
  verifyAttempts: 24,
  verifyDelayMs: 10000,
}

for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i]
  const next = () => {
    const value = process.argv[++i]
    if (value === undefined) {
      console.error(arg + ' needs a value')
      process.exit(2)
    }
    return value
  }
  switch (arg) {
    case '--dry-run':
      options.dryRun = true
      break
    case '--notes':
      options.notes = next()
      break
    case '--otp':
      options.otp = next()
      break
    case '--registry':
      options.registry = next()
      break
    case '--skip-tests':
      options.skipTests = true
      break
    case '--allow-dirty':
      options.allowDirty = true
      break
    case '--force':
      options.force = true
      break
    case '--mirror-gitea':
      options.mirrorGitea = true
      break
    case '--gitea':
      options.gitea = next()
      break
    case '--gitea-repo':
      options.giteaRepo = next()
      break
    case '--verify-attempts':
      options.verifyAttempts = Number(next())
      break
    case '--help':
    case '-h':
      console.log(
        [
          'usage: node scripts/release.mjs [options]',
          '',
          '  --dry-run            check everything, publish nothing',
          '  --notes <file>       release notes file (default: a pointer to CHANGELOG.md)',
          '  --otp <code>         one-time code for npm publish',
          '  --registry <url>     npm registry (default: ' + DEFAULT_REGISTRY + ')',
          '  --skip-tests         skip the test and packaging gate',
          '  --allow-dirty        do not insist on a clean working tree',
          '  --force              publish even if the version is already on the registry',
          '  --mirror-gitea       also mirror the release to the Gitea mirror',
          '  --gitea <url>        Gitea base URL (default: ' + DEFAULT_GITEA + ')',
          '  --gitea-repo <o/r>   Gitea repository (default: ' + options.giteaRepo + ')',
        ].join('\n'),
      )
      process.exit(0)
      break
    default:
      console.error('unknown option: ' + arg)
      process.exit(2)
  }
}

const step = (name) => console.log('\n\n=== ' + name + ' ===')
const ok = (message) => console.log('  ok    ' + message)
const warn = (message) => console.log('  warn  ' + message)
const fail = (message) => {
  console.error('  FAIL  ' + message)
  process.exit(1)
}

const tag = 'v' + version
const work = mkdtempSync(join(tmpdir(), 'dsh-token-ledger-release-'))
let tarball = null

/**
 * Read the release notes.
 *
 * @returns {string} the notes text.
 */
function releaseNotes() {
  if (!options.notes) return DEFAULT_NOTES
  const path = join(root, options.notes)
  if (!existsSync(path)) fail('the notes file ' + options.notes + ' does not exist')
  return readFileSync(path, 'utf8')
}

/**
 * Ask npm whether a version is already on the registry.
 *
 * @param {string} registry - the registry to ask.
 * @param {string} name - the package name.
 * @param {string} at - the version.
 * @returns {boolean} whether the registry knows it.
 */
function published(registry, name, at) {
  const result = npm(['view', name + '@' + at, 'version', '--registry=' + registry])
  return result.status === 0 && result.stdout.trim() === at
}

try {
  // ------------------------------------------------------------------ preflight
  step('preflight')

  // These two hold in a dry run too: a dirty tree or a missing pnpm would
  // make the real run fail, and there is nothing to learn from pretending
  // otherwise.
  const dirty = run('git', ['status', '--short'], { cwd: root }).stdout.trim()
  if (dirty !== '' && !options.allowDirty) {
    console.error(dirty)
    fail('the working tree is not clean; commit or stash it, or pass --allow-dirty')
  }
  ok('the working tree is ' + (dirty === '' ? 'clean' : 'dirty (allowed)'))

  const pnpmVersion = run('pnpm', ['--version'], { cwd: root, shell: true })
  if (pnpmVersion.status !== 0) {
    console.error(
      'The manifest runs prepublishOnly as "pnpm run verify && pnpm test", so npm\n' +
        'cannot publish without pnpm on the PATH. Install pnpm, or run this script\n' +
        'from a shell where it resolves.',
    )
    fail('pnpm is not on the PATH')
  }
  ok('pnpm ' + pnpmVersion.stdout.trim() + ' is on the PATH (prepublishOnly needs it)')

  // These describe the release state. A dry run reports them; a real run
  // refuses to continue when one of them is wrong.
  const head = run('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim()
  const tagged = run('git', ['rev-list', '-n', '1', tag], { cwd: root }).stdout.trim()
  const already = published(options.registry, packageName, version)

  if (tagged === '') {
    const message = 'the tag ' + tag + ' does not exist; a release is made from a tag'
    if (options.dryRun) warn(message)
    else fail(message)
  } else if (tagged !== head) {
    const message =
      'the tag ' + tag + ' points at ' + tagged.slice(0, 8) + ', not at HEAD ' + head.slice(0, 8)
    if (options.dryRun) warn(message)
    else fail(message)
  } else {
    ok(tag + ' points at HEAD ' + head.slice(0, 8))
  }
  ok('package.json says ' + version + ', and the tag says ' + version)

  if (already) {
    const message =
      packageName + '@' + version + ' is already on ' + options.registry +
      '; bump the version or pass --force'
    if (options.dryRun) warn(message)
    else if (!options.force) fail(message)
    else warn(message)
  } else {
    ok(packageName + '@' + version + ' is not on ' + options.registry)
  }

  if (options.dryRun) {
    step('dry run')
    console.log('The preflight passed. A dry run stops here: nothing is packed,')
    console.log('nothing is published and no release is created.')
    process.exit(0)
  }

  // ------------------------------------------------------------------ gate
  step('tests and packaging invariants')
  if (options.skipTests) {
    console.log('  skipped (--skip-tests)')
  } else {
    const verify = npm(['run', 'verify'], { cwd: root, stdio: 'inherit' })
    if (verify.status !== 0) fail('the packaging invariants did not hold')
    ok('the packaging invariants hold')
    const test = npm(['test'], { cwd: root, stdio: 'inherit' })
    if (test.status !== 0) fail('the tests did not pass')
    ok('the tests pass')
  }

  // ------------------------------------------------------------------ pack
  step('pack')
  const packed = npm(['pack', '--pack-destination', work, '--silent'], { cwd: root })
  if (packed.status !== 0) {
    console.error(packed.stdout + packed.stderr)
    fail('npm pack failed')
  }
  tarball = join(work, packed.stdout.trim().split(/\r?\n/).filter(Boolean).pop())
  ok('packed ' + tarball)

  // ------------------------------------------------------------------ publish
  step('publish')
  const publishArgs = ['publish', '--access', 'public', '--registry=' + options.registry]
  if (options.otp) publishArgs.push('--otp=' + options.otp)
  const result = npm(publishArgs, { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) {
    const version_ = npm(['--version'], { cwd: root })
    console.error('npm ' + version_.stdout.trim() + ' could not publish ' + packageName + '@' + version)
    fail('the publish failed')
  }
  ok(packageName + '@' + version + ' was published to ' + options.registry)

  // The registry's read side is not instantly consistent: straight after a
  // successful publish, npm view can still answer E404 for a minute or two.
  // Asserting once made releases that had worked perfectly look failed, which
  // is the same class of false alarm this step exists to remove.
  step('the version really is on the registry')
  let live = false
  for (let attempt = 1; attempt <= options.verifyAttempts; attempt++) {
    if (published(options.registry, packageName, version)) {
      ok(packageName + '@' + version + ' is on the registry (visible after ' + attempt + ' check(s))')
      live = true
      break
    }
    console.log('  check ' + attempt + ': the registry may still be propagating')
    await new Promise((resolve) => setTimeout(resolve, options.verifyDelayMs))
  }
  if (!live) fail(packageName + '@' + version + ' is still not on the registry; the publish published nothing')

  // ------------------------------------------------------------------ release
  step('the GitHub release')
  const notes = releaseNotes()
  const notesFile = join(work, 'notes.md')
  writeFileSync(notesFile, notes)
  const ghView = run('gh', ['release', 'view', tag], { cwd: root })
  if (ghView.status !== 0) {
    const created = run(
      'gh',
      ['release', 'create', tag, '--title', tag, '--notes-file', notesFile, tarball],
      { cwd: root, stdio: 'inherit' },
    )
    if (created.status !== 0) fail('the GitHub release ' + tag + ' could not be created')
    ok('created the GitHub release ' + tag)
  } else {
    const uploaded = run('gh', ['release', 'upload', tag, tarball, '--clobber'], { cwd: root, stdio: 'inherit' })
    if (uploaded.status !== 0) fail('the tarball could not be attached to ' + tag)
    ok(tag + ' already had a release; the tarball was attached to it')
  }

  // ------------------------------------------------------------------ mirror
  if (options.mirrorGitea) {
    step('the Gitea mirror')
    const { mirrorRelease } = await import('./lib/gitea.mjs')
    const summary = await mirrorRelease({
      base: options.gitea,
      repo: options.giteaRepo,
      tag,
      name: tag,
      body: notes,
      tarball,
      tarballName: tarball.split(/[\\/]/).pop(),
    })
    ok(summary)
  }

  console.log('\n\n' + packageName + '@' + version + ' is released.')
} finally {
  rmSync(work, { recursive: true, force: true })
}
