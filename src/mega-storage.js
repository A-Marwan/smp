'use strict'

const { createMegaClient } = require('./mega-client')

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
  if (_storage) return Promise.resolve(_storage)
  if (_readyPromise) return _readyPromise

  _readyPromise = createMegaClient(opts)
    .then((storage) => {
      _storage = storage
      _readyPromise = null
      return storage
    })
    .catch((err) => {
      _readyPromise = null
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
    try { _storage.close() } catch (_) {}
  }
  _storage = null
  _readyPromise = null
}

module.exports = { getStorage, isStorageReady, clearStorage }
