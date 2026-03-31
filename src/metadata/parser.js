'use strict'

/**
 * Regex patterns for common video naming conventions.
 *
 * Series:  Show.Name.S01E01.720p.mkv
 *          Show_Name_s1e1_HDTV.avi
 *          Show Name - S01E01 - Episode Title.mkv
 *          Show.Name.S01E01E02.mkv  (multi-episode)
 *
 * Movies:  Movie.Name.2021.1080p.mkv
 *          Movie Name (2021) [1080p].mkv
 *          Movie.Name.mkv  (no year — last resort)
 */

// Separators allowed between tokens
const SEP = '[\\s._-]+'
const OPT_SEP = '[\\s._-]*'

// Series: capture (title)(season)(episode)
// Tolerates optional separators around the SxxExx block
const SERIES_RE = new RegExp(
  `^(.+?)${SEP}[Ss](\\d{1,2})[Ee](\\d{1,2})(?:[Ee]\\d{1,2})*(?:${SEP}|$)`,
  'i'
)

// Movie with year in parens or bare: capture (title)(year)
const MOVIE_RE = new RegExp(
  `^(.+?)${SEP}\\(?((?:19|20)\\d{2})\\)?(?:${SEP}|$)`
)

// Characters / tokens that are noise after title extraction
const JUNK_TOKENS_RE = /[\s._-]+/g

/**
 * Normalise a raw title string extracted by regex:
 * replaces dots, underscores, hyphens with spaces and trims.
 *
 * @param {string} raw
 * @returns {string}
 */
function normaliseTitle (raw) {
  return raw
    .replace(JUNK_TOKENS_RE, ' ')
    .trim()
}

/**
 * Parse a video filename into structured metadata.
 *
 * @param {string} filename  e.g. "Show.Name.S01E01.720p.mkv"
 * @returns {{
 *   type: 'series'|'movie',
 *   title: string,
 *   year: number|null,
 *   season: number|null,
 *   episode: number|null,
 *   raw: string
 * }}
 */
function parseFilename (filename) {
  // Strip file extension
  const base = filename.replace(/\.[^.]+$/, '')

  // --- Series match ---
  const seriesMatch = SERIES_RE.exec(base)
  if (seriesMatch) {
    return {
      type: 'series',
      title: normaliseTitle(seriesMatch[1]),
      year: null,
      season: parseInt(seriesMatch[2], 10),
      episode: parseInt(seriesMatch[3], 10),
      raw: filename
    }
  }

  // --- Movie with year ---
  const movieMatch = MOVIE_RE.exec(base)
  if (movieMatch) {
    return {
      type: 'movie',
      title: normaliseTitle(movieMatch[1]),
      year: parseInt(movieMatch[2], 10),
      season: null,
      episode: null,
      raw: filename
    }
  }

  // --- Fallback: movie without year ---
  return {
    type: 'movie',
    title: normaliseTitle(base),
    year: null,
    season: null,
    episode: null,
    raw: filename
  }
}

module.exports = { parseFilename }
