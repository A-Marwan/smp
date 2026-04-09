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

/**
 * Absolute-episode pattern common in anime releases.
 *
 * Handles:
 *   [SubsPlease] Chainsaw Man - 01 (1080p).mkv
 *   Naruto - 001 [720p].mkv
 *   One.Piece.1000.mkv
 *   Anime Name EP42.mkv
 *   Anime.Name.E42.mkv
 *
 * Captures (title)(episode_number).
 * An optional leading fansub group tag like "[SubsPlease] " is stripped before
 * extraction so it does not bleed into the title.
 */
const ANIME_ABSOLUTE_EP_RE = new RegExp(
  // Optional leading [Group] tag
  '^(?:\\[[^\\]]+\\]\\s*)?' +
  // Title — stop before the episode marker
  '(.+?)' +
  // Separator then optional marker (-, EP, E, #) then episode number
  `${SEP}(?:[-\\u2013]\\s*)?(?:EP?|#)?\\s*0*(\\d+)\\s*(?:v\\d+)?\\s*(?:[\\[(]|$)`,
  'i'
)

/**
 * Parse a video filename that is known to be anime.
 *
 * Tries formats in order:
 *  1. Standard SxxExx  (Attack.on.Titan.S04E01.mkv)
 *  2. Absolute episode  ([Group] Anime - 01 [720p].mkv)
 *  3. Falls back to parseFilename (movie/unknown)
 *
 * @param {string} filename
 * @returns {{
 *   type: 'series'|'movie',
 *   title: string,
 *   year: number|null,
 *   season: number|null,
 *   episode: number|null,
 *   raw: string
 * }}
 */
function parseAnimeFilename (filename) {
  const base = filename.replace(/\.[^.]+$/, '')

  // 1. Standard SxxExx — already handled perfectly by the existing regex
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

  // 2. Absolute episode number — season defaults to 1
  const animeMatch = ANIME_ABSOLUTE_EP_RE.exec(base)
  if (animeMatch) {
    return {
      type: 'series',
      title: normaliseTitle(animeMatch[1]),
      year: null,
      season: 1,
      episode: parseInt(animeMatch[2], 10),
      raw: filename
    }
  }

  // 3. Delegate to standard parser (handles year-based movies and bare names)
  return parseFilename(filename)
}

module.exports = { parseFilename, parseAnimeFilename }
