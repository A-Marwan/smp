'use strict'

const CINEMETA_BASE = 'https://v3-cinemeta.strem.io'

/** Pause execution for `ms` milliseconds. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Fetch a URL with exponential backoff and rate-limit handling.
 *
 * @param {string} url
 * @param {{ retries?: number, baseDelayMs?: number }} [opts]
 * @returns {Promise<object>}
 */
async function fetchWithRetry (url, { retries = 3, baseDelayMs = 1000 } = {}) {
  let lastError

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const delay = baseDelayMs * Math.pow(2, attempt - 1)
      await sleep(delay)
    }

    let res
    try {
      res = await fetch(url, { headers: { 'User-Agent': 'stremio-mega-proxy/0.1' } })
    } catch (err) {
      lastError = err
      continue
    }

    if (res.status === 429) {
      // Respect Retry-After header if present, otherwise back off
      const retryAfterSec = parseInt(res.headers.get('retry-after') || '0', 10)
      const waitMs = retryAfterSec > 0 ? retryAfterSec * 1000 : baseDelayMs * Math.pow(2, attempt)
      await sleep(waitMs)
      lastError = new Error(`Rate limited (HTTP 429)`)
      continue
    }

    if (!res.ok) {
      lastError = new Error(`HTTP ${res.status} from ${url}`)
      continue
    }

    return res.json()
  }

  throw lastError || new Error(`Failed to fetch ${url}`)
}

/**
 * Search Cinemeta for a title and return the best-matching IMDb ID.
 *
 * Cinemeta search endpoint:
 *   GET https://v3-cinemeta.strem.io/catalog/{movie|series}/top/search={query}.json
 *
 * Response: { metas: [{ id: 'tt...', name: '...', year: '...' }, ...] }
 *
 * Year matching uses a ±1 tolerance to handle production-year vs release-year
 * discrepancies common in filenames.
 *
 * @param {{ title: string, year: number|null, type: 'movie'|'series' }} params
 * @returns {Promise<string|null>}  IMDb ID (e.g. "tt1234567") or null if not found
 */
async function resolveToImdbId ({ title, year, type }) {
  const cinemetaType = type === 'series' ? 'series' : 'movie'
  const query = encodeURIComponent(title)
  const url = `${CINEMETA_BASE}/catalog/${cinemetaType}/top/search=${query}.json`

  let data
  try {
    data = await fetchWithRetry(url)
  } catch (err) {
    throw new Error(`Cinemeta lookup failed for "${title}": ${err.message}`)
  }

  const metas = Array.isArray(data?.metas) ? data.metas : []
  if (metas.length === 0) return null

  // Year-aware: prefer the result whose year is within ±1 of the parsed year
  if (year) {
    const yearMatch = metas.find((m) => {
      const metaYear = parseInt(m.year, 10)
      return !isNaN(metaYear) && Math.abs(metaYear - year) <= 1
    })
    if (yearMatch) return yearMatch.id
  }

  // Best-effort: first result from Cinemeta's ranked list
  return metas[0].id
}

module.exports = { resolveToImdbId, fetchWithRetry }
