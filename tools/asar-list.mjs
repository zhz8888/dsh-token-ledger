#!/usr/bin/env node
/**
 * List (or search) files inside an Electron `.asar` archive without unpacking it.
 *
 * The archive header is: 4 bytes (pickle size), 4 bytes (header size),
 * 4 bytes (header string length), 4 bytes (header string length again), then
 * the JSON header. File contents follow the header, each at an offset that is
 * relative to the end of the header block.
 *
 * @param {string} archive - the `.asar` path.
 * @param {string} [pattern] - a substring the path must contain.
 * @param {boolean} [showOffset] - print the content offset and size.
 * @returns {void}
 */
import { openSync, readSync, closeSync } from 'node:fs'

const [archive, pattern = '', showOffset = ''] = process.argv.slice(2)

const fd = openSync(archive, 'r')
const prefix = Buffer.alloc(16)
readSync(fd, prefix, 0, 16, 0)
const headerSize = prefix.readUInt32LE(4)
const headerLength = prefix.readUInt32LE(12)
const header = Buffer.alloc(headerLength)
readSync(fd, header, 0, headerLength, 16)
const tree = JSON.parse(header.toString('utf8'))
const base = 16 + headerSize

/** @type {string[]} */
const out = []
/**
 * Walk one directory node.
 *
 * @param {object} node - an asar header node.
 * @param {string} prefixPath - the path built so far.
 * @returns {void}
 */
function walk(node, prefixPath) {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const path = prefixPath ? `${prefixPath}/${name}` : name
    if (child.files) walk(child, path)
    else out.push({ path, offset: base + Number(child.offset ?? 0), size: Number(child.size ?? 0) })
  }
}
walk(tree, '')

for (const entry of out) {
  if (pattern && !entry.path.toLowerCase().includes(pattern.toLowerCase())) continue
  if (showOffset === 'offset') console.log(`${entry.offset}\t${entry.size}\t${entry.path}`)
  else console.log(entry.path)
}
closeSync(fd)
