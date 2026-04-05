'use strict'

const logger = require('./logger')

// Per-handle concurrency state
// Map<handle, { queue: Function[], active: number, aborts: Array<{fn, start}>, idleTimer: NodeJS.Timeout | null, lastDuplicatePreemptAt: number }>
const handleState = new Map()

const MAX_CONCURRENT_PER_HANDLE = 1
const CLEANUP_DELAY_MS = 30000
// After a duplicate-start preemption, suppress further preemptions for this long.
// Prevents an infinite kick-start loop when the player retries faster than MEGA
// can deliver the first bytes (~150–200 ms retry interval vs ~200–400 ms MEGA startup).
const DUPLICATE_PREEMPT_COOLDOWN_MS = 2000

function getState (handle) {
  if (!handleState.has(handle)) {
    handleState.set(handle, { queue: [], active: 0, aborts: [], idleTimer: null, lastDuplicatePreemptAt: 0 })
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
 * @param {number}   fileSize - total file size in bytes (used to compute seek threshold)
 * @returns {Promise<Function>} resolves with release() — MUST be called when done
 */
function acquireSlot (handle, abortFn, start = 0, fileSize = 0) {
  const state = getState(handle)

  if (state.active < MAX_CONCURRENT_PER_HANDLE) {
    state.active++
    const abortEntry = abortFn ? { fn: abortFn, start } : null
    if (abortEntry) state.aborts.push(abortEntry)
    logger.info('stream-mgr', 'slot acquired', { handle, active: state.active, queued: state.queue.length })
    return Promise.resolve(makeRelease(handle, abortEntry))
  }

  // Seek threshold: 2% of file size. Scales correctly across all file sizes — near-start
  // duplicate connections (always within the first few KB) never trigger it, while genuine
  // seeks to a different playback position always do.
  const seekThreshold = fileSize > 0 ? fileSize * 0.02 : Infinity

  // Check if this is a seek — new start is far from any active stream's start
  const isSeek = state.aborts.some(a => Math.abs(a.start - start) > seekThreshold)

  // Check if this is a duplicate — same start position as an active stream, and
  // enough time has passed since the last duplicate preemption. The cooldown prevents
  // an infinite retry loop: players retry ~150–200 ms after seeing no data, which is
  // faster than MEGA's startup latency. Without the cooldown every preemption restarts
  // the download, the player never gets data, and retries spiral indefinitely.
  const isDuplicate = state.aborts.some(a => a.start === start) &&
    (Date.now() - state.lastDuplicatePreemptAt) > DUPLICATE_PREEMPT_COOLDOWN_MS

  if (isSeek || isDuplicate) {
    if (isDuplicate) state.lastDuplicatePreemptAt = Date.now()
    const toAbort = state.aborts.splice(0)
    logger.info('stream-mgr', isSeek ? 'seek detected — preempting active streams' : 'duplicate start — preempting stale stream', {
      handle, active: state.active, preempting: toAbort.length, seekStart: start
    })

    // Enqueue the seek request BEFORE calling abort, so that when the aborted
    // stream's release() runs synchronously it finds the queue non-empty and
    // immediately hands the slot to the seek request.
    const promise = new Promise((resolve) => {
      state.queue.unshift(() => {
        const abortEntry = abortFn ? { fn: abortFn, start } : null
        if (abortEntry) state.aborts.push(abortEntry)
        logger.info('stream-mgr', 'queued slot acquired', { handle, active: state.active, queued: state.queue.length })
        resolve(makeRelease(handle, abortEntry))
      })
    })

    for (const entry of toAbort) {
      try { entry.fn() } catch (_) {}
    }

    return promise
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
