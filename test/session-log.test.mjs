/**
 * Session log decoding tests.
 *
 * The frame walker is the one piece of this package that parses a binary
 * format, so it gets structural tests: exact round trips, several frames per
 * file, and a killed writer's torn final frame — which the frame walker refuses
 * while the reader keeps the committed prefix before it.
 *
 * @module dsh-token-ledger/test/session-log.test
 */

import assert from 'node:assert/strict'
import { zstdCompressSync } from 'node:zlib'
import { test } from 'node:test'

import { decodeSessionLogBuffer, frameLengthAt, parseJsonLines, splitZstdFrames } from '../lib/session-log.js'
import { ALPHA_EVENTS, encodeSessionLog, withSeq } from './fixtures.mjs'

test('splits concatenated frames and covers every byte', () => {
  const events = withSeq(ALPHA_EVENTS)
  for (const eventsPerFrame of [1, 2, 3, 7, events.length]) {
    const buffer = encodeSessionLog(events, { eventsPerFrame })
    const frames = splitZstdFrames(buffer)
    assert.equal(frames.length, Math.ceil(events.length / eventsPerFrame), `eventsPerFrame=${eventsPerFrame}`)
    const covered = frames.reduce((sum, frame) => sum + frame.length, 0)
    assert.equal(covered, buffer.length)
    assert.deepEqual(decodeSessionLogBuffer(buffer), events)
  }
})

test('reads a single frame carrying many lines', () => {
  const events = withSeq(ALPHA_EVENTS)
  const buffer = encodeSessionLog(events, { eventsPerFrame: events.length })
  assert.equal(splitZstdFrames(buffer).length, 1)
  assert.equal(decodeSessionLogBuffer(buffer).length, events.length)
})

test('frameLengthAt reports the exact length of the frame at an offset', () => {
  const events = withSeq(ALPHA_EVENTS)
  const first = encodeSessionLog(events.slice(0, 2), { eventsPerFrame: 2 })
  const rest = encodeSessionLog(events.slice(2), { eventsPerFrame: 2 })
  const buffer = Buffer.concat([first, rest])

  const frames = splitZstdFrames(buffer)
  // Two events in the first frame, the remaining sixteen in frames of two.
  assert.equal(frames.length, 1 + Math.ceil((events.length - 2) / 2))
  assert.equal(frames[0].length, first.length)
  // Walking to any frame's offset must report that frame's length exactly.
  for (const frame of frames) {
    assert.equal(frameLengthAt(buffer, frame.offset), frame.length, `offset ${frame.offset}`)
  }
  assert.equal(frames.reduce((sum, frame) => sum + frame.length, 0), buffer.length)
})

test('rejects a buffer that does not start with a frame', () => {
  assert.throws(() => frameLengthAt(Buffer.from('not zstd at all'), 0), /no zstd magic/)
  assert.throws(() => splitZstdFrames(Buffer.from([1, 2, 3, 4, 5])), /no zstd magic/)
})

/**
 * A killed writer leaves a file whose last frame was never finished. The file
 * walker stays strict about its own contract, but the reader keeps the frames
 * that were completed: those events are committed and counted, and dropping the
 * whole session over the tail is the loss this tolerance exists to prevent.
 */
test('a torn final frame is dropped and the frames before it still decode', () => {
  const events = withSeq(ALPHA_EVENTS)
  const buffer = encodeSessionLog(events, { eventsPerFrame: 2 })
  const frames = splitZstdFrames(buffer)
  const last = frames[frames.length - 1]
  const torn = buffer.subarray(0, buffer.length - 5)

  // `frameLengthAt` and `splitZstdFrames` keep their strict semantics: a caller
  // that asked for the frames is told the file does not end on a boundary.
  assert.throws(() => frameLengthAt(torn, last.offset), /truncated/)
  assert.throws(() => splitZstdFrames(torn), /truncated/)

  // The reader keeps the complete prefix: only the torn frame's two events are
  // missing, rather than the whole log failing.
  assert.deepEqual(decodeSessionLogBuffer(torn), events.slice(0, events.length - 2))

  // A buffer that holds no complete frame decodes to nothing — the writer never
  // finished anything — instead of failing the session.
  assert.deepEqual(decodeSessionLogBuffer(buffer.subarray(0, 4)), [])
})

test('structurally invalid bytes are still refused, not read as a short log', () => {
  assert.throws(() => decodeSessionLogBuffer(Buffer.from('not zstd at all')), /no zstd magic/)
  // Garbage after complete frames is not a torn tail: a torn tail is unfinished,
  // and a frame that never starts is a different file.
  const good = encodeSessionLog(withSeq(ALPHA_EVENTS.slice(0, 2)), { eventsPerFrame: 2 })
  assert.throws(() => decodeSessionLogBuffer(Buffer.concat([good, Buffer.from([1, 2, 3, 4, 5])])), /no zstd magic/)
})

test('parseJsonLines skips the torn trailing line a killed writer leaves', () => {
  const text = '{"a":1}\n{"b":2}\n{"c":'
  assert.deepEqual(parseJsonLines(text), [{ a: 1 }, { b: 2 }])
  assert.deepEqual(parseJsonLines(''), [])
  assert.deepEqual(parseJsonLines('\n\n'), [])
})

test('an empty log decodes to no events', () => {
  const empty = zstdCompressSync(Buffer.from(''))
  assert.deepEqual(decodeSessionLogBuffer(empty), [])
})
