'use strict'

const { fetchWithRetry } = require('./resolver')
const logger = require('../logger')

const KITSU_BASE = 'https://kitsu.app/api/edge'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

/** @type {Map<string, { data: object, ts: number }>} */
const searchCache = new Map()
/** @type {Map<string, { meta: object, ts: number }>} */
const metaCache = new Map()

// Kitsu subtypes that represent series-like content
const SERIES_SUBTYPES = new Set(['TV', 'ONA', 'OVA', 'special', 'music'])
// Kitsu subtypes that represent movie-like content
const MOVIE_SUBTYPES = new Set(['movie'])

/**
 * Search Kitsu for an anime title and return the best-matching kitsu ID string.
 *
 * @param {{ title: string, year?: number|null, type: 'series'|'movie' }} params
 * @returns {Promise<string|null>}  e.g. "kitsu:12345" or null
 */
async function resolveToKitsuId ({ title, year = null, type }) {
  const cacheKey = `search:${type}:${title}:${year ?? ''}`
  const cached = searchCache.get(cacheKey)
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.data
  }

  const query = encodeURIComponent(title)
  const url = `${KITSU_BASE}/anime?filter[text]=${query}&page[limit]=10&fields[anime]=id,canonicalTitle,subtype,startDate`

  logger.info('kitsu', 'searching for anime', { title, year: year ?? null, type })

  let data
  try {
    data = await fetchWithRetry(url, { retries: 3, baseDelayMs: 1000 })
  } catch (err) {
    logger.error('kitsu', 'search request failed', { title, error: err.message })
    throw new Error(`Kitsu search failed for "${title}": ${err.message}`)
  }

  const results = Array.isArray(data?.data) ? data.data : []
  if (results.length === 0) {
    logger.info('kitsu', 'no results', { title })
    searchCache.set(cacheKey, { data: null, ts: Date.now() })
    return null
  }

  // Determine preferred subtypes based on requested content type
  const preferredSubtypes = type === 'movie' ? MOVIE_SUBTYPES : SERIES_SUBTYPES

  // Year-aware matching within preferred subtypes
  if (year) {
    const yearMatch = results.find((r) => {
      const subtype = r.attributes?.subtype
      const startYear = r.attributes?.startDate
        ? parseInt(r.attributes.startDate.slice(0, 4), 10)
        : NaN
      return preferredSubtypes.has(subtype) && !isNaN(startYear) && Math.abs(startYear - year) <= 1
    })
    if (yearMatch) {
      const kitsuId = `kitsu:${yearMatch.id}`
      logger.info('kitsu', 'resolved (year+subtype match)', { title, year, kitsuId })
      searchCache.set(cacheKey, { data: kitsuId, ts: Date.now() })
      return kitsuId
    }
  }

  // Subtype match only (no year constraint)
  const subtypeMatch = results.find((r) => preferredSubtypes.has(r.attributes?.subtype))
  if (subtypeMatch) {
    const kitsuId = `kitsu:${subtypeMatch.id}`
    logger.info('kitsu', 'resolved (subtype match)', { title, kitsuId })
    searchCache.set(cacheKey, { data: kitsuId, ts: Date.now() })
    return kitsuId
  }

  // Best-effort: first result regardless of subtype
  const kitsuId = `kitsu:${results[0].id}`
  logger.info('kitsu', 'resolved (best-effort)', { title, kitsuId })
  searchCache.set(cacheKey, { data: kitsuId, ts: Date.now() })
  return kitsuId
}

/**
 * Fetch full metadata for an anime from Kitsu, with in-memory caching.
 *
 * @param {string} kitsuNumericId  The numeric Kitsu ID (without "kitsu:" prefix)
 * @returns {Promise<object|null>}  Normalised meta object or null
 */
async function getAnimeMetadata (kitsuNumericId) {
  const cacheKey = `meta:${kitsuNumericId}`
  const cached = metaCache.get(cacheKey)
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.meta
  }

  const url = `${KITSU_BASE}/anime/${kitsuNumericId}?include=genres&fields[anime]=canonicalTitle,synopsis,posterImage,coverImage,subtype,startDate,episodeCount`

  let data
  try {
    data = await fetchWithRetry(url)
  } catch (err) {
    logger.warn('kitsu', 'metadata fetch failed', { kitsuNumericId, error: err.message })
    return null
  }

  const attrs = data?.data?.attributes
  if (!attrs) {
    logger.warn('kitsu', 'metadata response missing attributes', { kitsuNumericId })
    return null
  }

  // Extract genre names from included data
  const included = Array.isArray(data.included) ? data.included : []
  const genres = included
    .filter((r) => r.type === 'genres')
    .map((r) => r.attributes?.name)
    .filter(Boolean)

  const year = attrs.startDate ? parseInt(attrs.startDate.slice(0, 4), 10) : null

  const meta = {
    id: `kitsu:${kitsuNumericId}`,
    name: attrs.canonicalTitle || null,
    poster: attrs.posterImage?.medium || attrs.posterImage?.small || null,
    background: attrs.coverImage?.large || attrs.coverImage?.small || null,
    description: attrs.synopsis || null,
    genres,
    year: isNaN(year) ? null : year
  }

  metaCache.set(cacheKey, { meta, ts: Date.now() })
  return meta
}

module.exports = { resolveToKitsuId, getAnimeMetadata }
