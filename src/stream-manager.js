'use strict'

const logger = require('./logger')

// Per-handle concurrency state
// Map<handle, { queue: Function[], active: number, aborts: Array<{fn, start}>, idleTimer: NodeJS.Timeout | null }>
const handleState = new Map()

const MAX_CONCURRENT_PER_HANDLE = 1
const CLEANUP_DELAY_MS = 30000
// If a new request's start offset differs from the active stream's start by more than this,
// treat it as a seek and preempt the active stream immediately to avoid deadlock.
const SEEK_PREEMPT_THRESHOLD = 10 * 1024 * 1024 // 10 MB

function getState (handle) {
  if (!handleState.has(handle)) {
    handleState.set(handle, { queue: [], active: 0, aborts: [], idleTimer: null })
  }
  const state = handleState.get(handle)
  clearTimeout(state.idleTimer)
  state.idleTimer = null
  return state
}

function makeRelease (handle, abortEntry) {
  let released = false
  return function release () {
    if (released) return
    released = true
    const state = handleState.get(handle)
    if (!state) return
    // Remove this slot's abort entry
    if (abortEntry) {
      const idx = state.aborts.indexOf(abortEntry)
      if (idx !== -1) state.aborts.splice(idx, 1)
    }
    state.active--
    if (state.queue.length > 0) {
      const next = state.queue.shift()
      state.active++
      next()
    } else if (state.active === 0) {
      state.idleTimer = setTimeout(() => handleState.delete(handle), CLEANUP_DELAY_MS)
    }
  }
}

/**
 * Acquire a concurrency slot for the given file handle.
 *
 * @param {string}   handle   - file handle
 * @param {Function} abortFn  - called when this stream should be aborted (preempted by a seek)
 * @param {number}   start    - byte offset this stream starts at (used for seek detection)
 * @returns {Promise<Function>} resolves with release() — MUST be called when done
 */
function acquireSlot (handle, abortFn, start = 0) {
  const state = getState(handle)

  if (state.active < MAX_CONCURRENT_PER_HANDLE) {
    state.active++
    const abortEntry = abortFn ? { fn: abortFn, start } : null
    if (abortEntry) state.aborts.push(abortEntry)
    logger.info('stream-mgr', 'slot acquired', { handle, active: state.active, queued: state.queue.length })
    return Promise.resolve(makeRelease(handle, abortEntry))
  }

  // Check if this is a seek — new start is far from any active stream's start
  const isSeek = state.aborts.some(a => Math.abs(a.start - start) > SEEK_PREEMPT_THRESHOLD)

  if (isSeek) {
    // Preempt active streams so the seek can start promptly
    const toAbort = state.aborts.splice(0)
    logger.info('stream-mgr', 'seek detected — preempting active streams', {
      handle, active: state.active, preempting: toAbort.length, seekStart: start
    })
    for (const entry of toAbort) {
      try { entry.fn() } catch (_) {}
    }
    // Aborted streams will call release() → decrement active → dequeue next
    // Put this seek request at the front so it's served as soon as the slot opens
    return new Promise((resolve) => {
      state.queue.unshift(() => {
        const abortEntry = abortFn ? { fn: abortFn, start } : null
        if (abortEntry) state.aborts.push(abortEntry)
        logger.info('stream-mgr', 'queued slot acquired', { handle, active: state.active, queued: state.queue.length })
        resolve(makeRelease(handle, abortEntry))
      })
    })
  }

  return new Promise((resolve) => {
    logger.info('stream-mgr', 'request queued', { handle, active: state.active, queued: state.queue.length + 1 })
    state.queue.push(() => {
      const abortEntry = abortFn ? { fn: abortFn, start } : null
      if (abortEntry) state.aborts.push(abortEntry)
      logger.info('stream-mgr', 'queued slot acquired', { handle, active: state.active, queued: state.queue.length })
      resolve(makeRelease(handle, abortEntry))
    })
  })
}

module.exports = { acquireSlot }
