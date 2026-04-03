'use strict'

const { EventEmitter } = require('events')

const DEFAULT_TTL = 30_000 // 30 seconds idle before cleanup
const MAX_BUFFER = 10 * 1024 * 1024 // 10 MB sliding window

class MegaRelay extends EventEmitter {
  /**
   * @param {object} file - megajs File node (.download(), .size, .nodeId)
   */
  constructor (file) {
    super()
    this.file = file
    this.fileSize = file.size

    this._megaStream = null
    this._downloadOffset = 0 // byte where current stream started
    this._downloadCursor = 0 // next byte MEGA will deliver
    this._chunks = [] // { offset, data } ordered
    this._bufferedBytes = 0
    this._activeConsumers = 0
    this._error = null
    this._ttlTimer = null
    this._destroyed = false
    this._ended = false
  }

  get alive () {
    return !this._destroyed && !this._error
  }

  /**
   * Serve bytes [start, end] (inclusive) to an Express response.
   */
  async serve (start, end, res, req) {
    if (this._destroyed) throw new Error('Relay destroyed')

    this._clearTtl()
    this._activeConsumers++

    const needed = end + 1 // exclusive upper bound
    let cursor = start
    let aborted = false

    const onClose = () => { aborted = true }
    req.on('close', onClose)

    try {
      this._ensureStream(start)

      while (cursor < needed && !aborted && !this._destroyed) {
        // Try reading from buffer
        const slice = this._readFromBuffer(cursor, needed)
        if (slice) {
          const ok = res.write(slice)
          cursor += slice.length
          if (cursor >= needed) break
          if (!ok && !aborted) {
            await new Promise(resolve => res.once('drain', resolve))
          }
          continue
        }

        // If there's an error, throw it
        if (this._error) throw this._error

        // If stream ended but we haven't got enough data, end early
        if (this._ended && !this._megaStream) break

        // Data not buffered yet — wait for progress
        if (this._downloadCursor <= cursor && this._megaStream) {
          await new Promise(resolve => {
            const check = () => {
              if (this._downloadCursor > cursor || this._error || this._destroyed || this._ended) {
                this.removeListener('progress', check)
                this.removeListener('megaEnd', check)
                resolve()
              }
            }
            this.on('progress', check)
            this.on('megaEnd', check)
          })
          if (this._error) throw this._error
          continue
        }

        // Data was trimmed from buffer — restart stream from cursor
        this._ensureStream(cursor)
      }

      if (!aborted && !res.destroyed) res.end()
    } finally {
      req.removeListener('close', onClose)
      this._activeConsumers--
      if (this._activeConsumers === 0) this._startTtl()
    }
  }

  destroy () {
    if (this._destroyed) return
    this._destroyed = true
    this._clearTtl()
    this._teardownStream()
    this._chunks = []
    this._bufferedBytes = 0
    this.emit('destroy')
    this.removeAllListeners()
  }

  // --- internal ---

  _ensureStream (fromByte) {
    if (this._megaStream && !this._error) {
      const isBackward = fromByte < this._downloadOffset
      const isFarForward = fromByte > this._downloadCursor + MAX_BUFFER

      if (!isBackward && !isFarForward) return // stream is usable
    }

    // Restart from fromByte
    this._teardownStream()
    this._chunks = []
    this._bufferedBytes = 0
    this._downloadOffset = fromByte
    this._downloadCursor = fromByte
    this._error = null
    this._ended = false

    this._megaStream = this.file.download({ start: fromByte })

    this._megaStream.on('data', (chunk) => {
      this._chunks.push({ offset: this._downloadCursor, data: chunk })
      this._downloadCursor += chunk.length
      this._bufferedBytes += chunk.length
      this._trimExcess()
      this.emit('progress', this._downloadCursor)
    })

    this._megaStream.on('end', () => {
      this._megaStream = null
      this._ended = true
      this.emit('megaEnd')
    })

    this._megaStream.on('error', (err) => {
      this._error = err
      this._teardownStream()
      const msg = err.message || ''
      if (msg.includes('EEXPIRED') || msg.includes('EOVERQUOTA')) {
        this.destroy()
      }
      this.emit('progress', this._downloadCursor)
    })
  }

  _readFromBuffer (start, end) {
    for (let i = 0; i < this._chunks.length; i++) {
      const chunk = this._chunks[i]
      const chunkEnd = chunk.offset + chunk.data.length

      if (chunk.offset <= start && chunkEnd > start) {
        const sliceStart = start - chunk.offset
        const sliceEnd = Math.min(chunk.data.length, sliceStart + (end - start))
        return chunk.data.subarray(sliceStart, sliceEnd)
      }
    }
    return null
  }

  _trimExcess () {
    while (this._bufferedBytes > MAX_BUFFER && this._chunks.length > 1) {
      const oldest = this._chunks.shift()
      this._bufferedBytes -= oldest.data.length
    }
  }

  _teardownStream () {
    if (this._megaStream) {
      this._megaStream.removeAllListeners()
      this._megaStream.destroy()
      this._megaStream = null
    }
  }

  _startTtl () {
    this._clearTtl()
    this._ttlTimer = setTimeout(() => this.destroy(), DEFAULT_TTL)
  }

  _clearTtl () {
    if (this._ttlTimer) {
      clearTimeout(this._ttlTimer)
      this._ttlTimer = null
    }
  }
}

// --- Relay registry ---

const _relays = new Map()

function getRelay (file) {
  const key = file.nodeId
  let relay = _relays.get(key)

  if (relay && relay.alive) return relay

  if (relay) _relays.delete(key)

  relay = new MegaRelay(file)
  relay.on('destroy', () => _relays.delete(key))
  _relays.set(key, relay)
  return relay
}

function clearRelays () {
  for (const relay of _relays.values()) {
    relay.destroy()
  }
  _relays.clear()
}

module.exports = { MegaRelay, getRelay, clearRelays }
