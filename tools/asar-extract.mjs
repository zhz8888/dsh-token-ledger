#!/usr/bin/env node
/**
 * Extract one file out of an Electron `.asar` archive to a local path.
 *
 * @param {string} archive - the `.asar` path.
 * @param {string} entry - the archive-relative path of the file.
 * @param {string} out - where to write it.
 * @returns {void}
 */
import { openSync, readSync, closeSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const [archive, entry, out] = process.argv.slice(2)

const fd = openSync(archive, 'r')
const prefix = Buffer.alloc(16)
readSync(fd, prefix, 0, 16, 0)
const headerSize = prefix.readUInt32LE(4)
const headerLength = prefix.readUInt32LE(12)
const header = Buffer.alloc(headerLength)
readSync(fd, header, 0, headerLength, 16)
const tree = JSON.parse(header.toString('utf8'))
const base = 16 + headerSize

let node = tree
for (const part of entry.split('/')) {
  node = node?.files?.[part]
  if (!node) throw new Error(`not found: ${entry}`)
}

const body = Buffer.alloc(Number(node.size))
readSync(fd, body, 0, Number(node.size), base + Number(node.offset))
closeSync(fd)

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, body)
console.log(`wrote ${out} (${node.size} bytes)`)
