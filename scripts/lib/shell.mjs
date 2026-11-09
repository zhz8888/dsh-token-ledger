/**
 * Running external commands from the release scripts.
 *
 * One thing here is not obvious. On Windows, npm ships as `npm.cmd`, and Node
 * refuses to spawn a `.cmd` without a shell — `spawnSync` answers EINVAL
 * instead. The wrapper's own entry point is a JavaScript file next to it, so
 * npm is invoked as `node <npm-cli.js>`: no shell, no quoting, and the same
 * code path on every platform.
 *
 * @module dsh-token-ledger/scripts/lib/shell
 */

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'

/**
 * Run a command and return its outcome without throwing.
 *
 * @param {string} cmd - the executable.
 * @param {string[]} args - its arguments.
 * @param {object} [options] - spawn options; `cwd` defaults to the current
 *   working directory and output is captured rather than inherited.
 * @returns {{status: number, stdout: string, stderr: string}} the outcome.
 */
export function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  })
  if (result.error) return { status: 127, stdout: '', stderr: String(result.error) }
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

/**
 * Work out how npm is invoked on this machine.
 *
 * @returns {{cmd: string, prefix: string[], shell: boolean}} the command, the
 *   arguments that must precede npm's own, and whether a shell is needed.
 */
export function npmInvocation() {
  const fromEnv = process.env.npm_execpath
  if (fromEnv && /npm-cli\.js$/.test(fromEnv) && existsSync(fromEnv)) {
    return { cmd: process.execPath, prefix: [fromEnv], shell: false }
  }
  const beside = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (existsSync(beside)) return { cmd: process.execPath, prefix: [beside], shell: false }
  if (process.platform === 'win32') return { cmd: 'npm.cmd', prefix: [], shell: true }
  return { cmd: 'npm', prefix: [], shell: false }
}

/**
 * Run npm.
 *
 * @param {string[]} args - npm's own arguments.
 * @param {object} [options] - spawn options.
 * @returns {{status: number, stdout: string, stderr: string}} the outcome.
 */
export function npm(args, options = {}) {
  const { cmd, prefix, shell } = npmInvocation()
  return run(cmd, [...prefix, ...args], { shell, ...options })
}
