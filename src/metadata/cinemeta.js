'use strict'

const { fetchWithRetry } = require('./resolver')

const CINEMETA_BASE = 'https://v3-cinemeta.strem.io'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

/** @type {Map<string, { meta: object, ts: number }>} */
const cache = new Map()

/**
 * Fetch full metadata for a title from Cinemeta, with in-memory caching.
 *
 * @param {'movie'|'series'} type
 * @param {string} imdbId  e.g. "tt1234567"
 * @returns {Promise<object|null>}  Cinemeta meta object or null
 */
async function getMetadata (type, imdbId) {
  const key = `${type}:${imdbId}`
  const cached = cache.get(key)
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.meta
  }

  const url = `${CINEMETA_BASE}/meta/${type}/${imdbId}.json`

  let data
  try {
    data = await fetchWithRetry(url)
  } catch (err) {
    console.warn(`[cinemeta] Failed to fetch ${type}/${imdbId}: ${err.message}`)
    return null
  }

  const meta = data?.meta || null
  if (meta) {
    cache.set(key, { meta, ts: Date.now() })
  }

  return meta
}

module.exports = { getMetadata }
