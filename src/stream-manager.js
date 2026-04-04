'use strict'

const logger = require('./logger')

// Per-handle concurrency state
// Map<handle, { queue: Function[], active: number, idleTimer: NodeJS.Timeout | null }>
const handleState = new Map()

const MAX_CONCURRENT_PER_HANDLE = 2
const CLEANUP_DELAY_MS = 30000

function getState (handle) {
  if (!handleState.has(handle)) {
    handleState.set(handle, { queue: [], active: 0, idleTimer: null })
  }
  const state = handleState.get(handle)
  clearTimeout(state.idleTimer)
  state.idleTimer = null
  return state
}

function makeRelease (handle) {
  let released = false
  return function release () {
    if (released) return
    released = true
    const state = handleState.get(handle)
    if (!state) return
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
 * Resolves with a release() function that MUST be called when done.
 * If at max concurrency, the promise waits until a slot opens.
 */
function acquireSlot (handle) {
  const state = getState(handle)

  if (state.active < MAX_CONCURRENT_PER_HANDLE) {
    state.active++
    logger.info('stream-mgr', 'slot acquired', { handle, active: state.active, queued: state.queue.length })
    return Promise.resolve(makeRelease(handle))
  }

  return new Promise((resolve) => {
    logger.info('stream-mgr', 'request queued', { handle, active: state.active, queued: state.queue.length + 1 })
    state.queue.push(() => {
      logger.info('stream-mgr', 'queued slot acquired', { handle, active: state.active, queued: state.queue.length })
      resolve(makeRelease(handle))
    })
  })
}

module.exports = { acquireSlot }
