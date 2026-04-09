'use strict'

const { parseFilename } = require('./parser')
const { resolveToImdbId, fetchWithRetry } = require('./resolver')
const { getDb } = require('../db')
const logger = require('../logger')

const CINEMETA_BASE = 'https://v3-cinemeta.strem.io'

const VIDEO_EXTS = new Set(['.mkv', '.mp4', '.avi', '.mov', '.wmv', '.m4v', '.ts', '.mpg', '.mpeg', '.webm'])

const ANIME_PATTERNS = [
  /\[HorribleSubs\]/i,
  /\[Erai-?Raws\]/i,
  /\[SubsPlease\]/i,
  /\[ShinOPROD\]/i,
  /\[KRP\]/i,
  /\[ASW\]/i,
  /\[Judas\]/i,
  /\[Neko?Ware\]/i,
  /\[Vipap?\]/i,
  /\[Dubs?\]/i,
  /\[Cleo\]/i,
  /\[Froopy\]/i,
  /\bSakuraCircle\b/i,
  /\bAnimeRG\b/i,
  /720p\s*\[/i,
  /1080p\s*\[/i,
  /\(\s*\d+\s*bit\)/i
]

/**
 * Index a list of MEGA file entries into the SQLite database.
 *
 * For each video file the function:
 *   1. Parses the filename into title / year / season / episode
 *   2. Calls the Cinemeta API to resolve to an IMDb ID
 *   3. Upserts the record into the `files` table
 *   4. On any failure, writes to `unmatched_files` and continues
 *
 * @param {import('../crawler').FileEntry[]} files  Output from crawlMega()
 * @returns {Promise<{ matched: number, unmatched: number, skipped: number }>}
 */
async function indexFiles (files) {
  const db = getDb()

  const insertFile = db.prepare(`
    INSERT OR REPLACE INTO files (imdb_id, season, episode, is_anime, filename, mega_handle)
    VALUES (@imdb_id, @season, @episode, @is_anime, @filename, @mega_handle)
  `)

  const insertUnmatched = db.prepare(`
    INSERT INTO unmatched_files (filename, mega_handle, reason)
    VALUES (@filename, @mega_handle, @reason)
  `)

  const stats = { matched: 0, unmatched: 0, skipped: 0 }

  for (const file of files) {
    if (file.isFolder) continue

    const ext = extOf(file.name)
    if (!VIDEO_EXTS.has(ext)) {
      stats.skipped++
      continue
    }

    const parsed = parseFilename(file.name)
    const isAnimeByFilename = ANIME_PATTERNS.some((p) => p.test(file.name))

    let imdbId
    try {
      imdbId = await resolveToImdbId({ title: parsed.title, year: parsed.year, type: parsed.type })
    } catch (err) {
      const reason = err.message
      logger.warn('indexer', 'resolve failed', { filename: file.name, reason })
      insertUnmatched.run({ filename: file.name, mega_handle: file.handle, reason })
      stats.unmatched++
      continue
    }

    if (!imdbId) {
      const reason = `No match found on Cinemeta for "${parsed.title}"${parsed.year ? ` (${parsed.year})` : ''}`
      logger.warn('indexer', 'no Cinemeta match', { filename: file.name, reason })
      insertUnmatched.run({ filename: file.name, mega_handle: file.handle, reason })
      stats.unmatched++
      continue
    }

    let isAnime = isAnimeByFilename ? 1 : 0

    if (!isAnime && parsed.type === 'series') {
      try {
        const meta = await fetchWithRetry(`${CINEMETA_BASE}/meta/series/${imdbId}.json`)
        const genres = meta?.meta?.genres || []
        if (genres.some((g) => g.toLowerCase().includes('animation'))) {
          isAnime = 1
          logger.info('indexer', 'detected anime via genre', { title: parsed.title, imdbId })
        }
      } catch (err) {
        logger.warn('indexer', 'anime genre check failed', { imdbId, error: err.message })
      }
    }

    insertFile.run({
      imdb_id: imdbId,
      season: parsed.season ?? 0,
      episode: parsed.episode ?? 0,
      is_anime: isAnime,
      filename: file.name,
      mega_handle: file.handle
    })

    const epLabel = parsed.season != null
      ? ` S${String(parsed.season).padStart(2, '0')}E${String(parsed.episode).padStart(2, '0')}`
      : ''
    logger.info('indexer', 'file indexed', { filename: file.name, imdbId, episode: epLabel || null, isAnime })
    stats.matched++
  }

  return stats
}

/** Return the lowercased extension of a filename (e.g. ".mkv"), or "" if none. */
function extOf (filename) {
  const dot = filename.lastIndexOf('.')
  return dot === -1 ? '' : filename.slice(dot).toLowerCase()
}

module.exports = { indexFiles }
