'use strict'

const { createMegaClient } = require('./mega-client')
const logger = require('./logger')

let _storage = null
let _readyPromise = null

/**
 * Returns a singleton, authenticated MEGA Storage instance.
 * On first call, logs in and loads the file tree.
 * Subsequent calls return the cached instance.
 *
 * @param {{ mfaCode?: string }} [opts]
 * @returns {Promise<import('megajs').Storage>}
 */
function getStorage (opts) {
  if (_storage) {
    logger.info('mega-storage', 'cache HIT — returning existing storage')
    return Promise.resolve(_storage)
  }
  if (_readyPromise) {
    logger.info('mega-storage', 'dedup — login already in flight, attaching to pending promise')
    return _readyPromise
  }

  logger.info('mega-storage', 'cache MISS — initiating MEGA login')

  _readyPromise = createMegaClient(opts)
    .then((storage) => {
      _storage = storage
      _readyPromise = null
      logger.info('mega-storage', 'login succeeded — storage cached')
      return storage
    })
    .catch((err) => {
      _readyPromise = null
      logger.error('mega-storage', 'login failed', { error: err.message })
      throw err
    })

  return _readyPromise
}

/**
 * Returns true if a cached MEGA Storage instance is available (no login attempt).
 */
function isStorageReady () {
  return _storage !== null
}

/**
 * Clears cached storage (for shutdown / reconnect).
 */
function clearStorage () {
  if (_storage) {
    logger.warn('mega-storage', 'clearStorage called — evicting cached storage')
    try { _storage.close() } catch (_) {}
  } else {
    logger.info('mega-storage', 'clearStorage called — no cached storage to evict')
  }
  _storage = null
  _readyPromise = null
}

module.exports = { getStorage, isStorageReady, clearStorage }
