'use strict'

const { parseFilename, parseAnimeFilename } = require('./parser')
const { resolveToImdbId } = require('./resolver')
const { resolveToKitsuId } = require('./kitsu')
const { getDb } = require('../db')
const logger = require('../logger')

/** Video extensions that are worth indexing. */
const VIDEO_EXTS = new Set(['.mkv', '.mp4', '.avi', '.mov', '.wmv', '.m4v', '.ts', '.mpg', '.mpeg', '.webm'])

/**
 * Index a list of MEGA file entries into the SQLite database.
 *
 * For each video file the function:
 *   1. Detects whether the file is anime (folder path match OR title-less SxxExx filename)
 *   2. Parses the filename into title / year / season / episode
 *   3. Resolves to an ID via Cinemeta (regular) or Kitsu (anime)
 *   4. Upserts the record into the `files` table
 *   5. On any failure, writes to `unmatched_files` and continues
 *
 * @param {import('../crawler').FileEntry[]} files  Output from crawlMega()
 * @param {{ animeFolder?: string|null }} [opts]
 *   animeFolder — MEGA folder name whose contents are treated as anime (e.g. "Anime")
 * @returns {Promise<{ matched: number, unmatched: number, skipped: number }>}
 */
async function indexFiles (files, { animeFolder = null } = {}) {
  const db = getDb()

  const insertFile = db.prepare(`
    INSERT OR REPLACE INTO files (imdb_id, season, episode, filename, mega_handle)
    VALUES (@imdb_id, @season, @episode, @filename, @mega_handle)
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

    // Determine whether this file should be indexed as anime.
    // Primary: explicit folder match via MEGA_ANIME_FOLDER.
    // Secondary: filename starts with SxxExx with no series title prefix
    //   (e.g. "S02E01-Episode Title [hash].mkv") — a pattern virtually
    //   exclusive to anime distributions where the series name is only
    //   in the parent folder.
    const inAnimeFolder = Boolean(
      animeFolder &&
      file.path &&
      file.path.split('/').includes(animeFolder)
    )
    const fileBase = file.name.replace(/\.[^.]+$/, '')
    const isTitlelessEpisode = /^[Ss]\d{1,2}[Ee]\d{1,2}[-\s]/.test(fileBase)
    const isAnime = inAnimeFolder || isTitlelessEpisode

    if (isAnime) {
      await indexAnimeFile(file, animeFolder, insertFile, insertUnmatched, stats)
    } else {
      await indexRegularFile(file, insertFile, insertUnmatched, stats)
    }
  }

  return stats
}

/**
 * Index a regular (non-anime) file using Cinemeta / IMDb metadata.
 */
async function indexRegularFile (file, insertFile, insertUnmatched, stats) {
  const parsed = parseFilename(file.name)

  let imdbId
  try {
    imdbId = await resolveToImdbId({ title: parsed.title, year: parsed.year, type: parsed.type })
  } catch (err) {
    const reason = err.message
    logger.warn('indexer', 'Cinemeta resolve failed', { filename: file.name, reason })
    insertUnmatched.run({ filename: file.name, mega_handle: file.handle, reason })
    stats.unmatched++
    return
  }

  if (!imdbId) {
    const reason = `No match found on Cinemeta for "${parsed.title}"${parsed.year ? ` (${parsed.year})` : ''}`
    logger.warn('indexer', 'no Cinemeta match', { filename: file.name, reason })
    insertUnmatched.run({ filename: file.name, mega_handle: file.handle, reason })
    stats.unmatched++
    return
  }

  insertFile.run({
    imdb_id: imdbId,
    season: parsed.season ?? 0,
    episode: parsed.episode ?? 0,
    filename: file.name,
    mega_handle: file.handle
  })

  const epLabel = parsed.season != null
    ? ` S${String(parsed.season).padStart(2, '0')}E${String(parsed.episode).padStart(2, '0')}`
    : ''
  logger.info('indexer', 'file indexed', { filename: file.name, imdbId, episode: epLabel || null })
  stats.matched++
}

// Matches a SxxExx code at the very start of a filename base (no title prefix).
// e.g. "S02E01-Episode Title [hash]" or "S02E01 Episode Title"
const LEADING_EP_RE = /^[Ss](\d{1,2})[Ee](\d{1,2})/

// Folder names that indicate a season subdivision, not the series title.
const SEASON_FOLDER_RE = /^[Ss]eason\s*\d+$|^[Ss]\d+$/

/**
 * Derive the anime series title from the file's MEGA folder path.
 *
 * When animeFolderName is provided, returns the path segment immediately
 * after that folder (e.g. "Anime/Solo Leveling" → "Solo Leveling").
 *
 * Without animeFolderName, walks path segments deepest-first and returns
 * the first segment that does not look like a season folder, so both
 * "Solo Leveling" and "Anime/Solo Leveling/Season 2" yield "Solo Leveling".
 */
function extractAnimeTitleFromPath (filePath, animeFolderName) {
  if (!filePath) return null
  const segments = filePath.split('/').filter(Boolean)
  if (!segments.length) return null

  if (animeFolderName) {
    const idx = segments.indexOf(animeFolderName)
    return (idx !== -1 && idx + 1 < segments.length) ? segments[idx + 1] : null
  }

  // No anime folder configured — use the deepest non-season folder segment.
  for (let i = segments.length - 1; i >= 0; i--) {
    if (!SEASON_FOLDER_RE.test(segments[i])) {
      return segments[i]
    }
  }
  return segments[0]
}

/**
 * Index an anime file using Kitsu metadata.
 * Stores the entry with a "kitsu:{id}" value in the imdb_id column.
 */
async function indexAnimeFile (file, animeFolder, insertFile, insertUnmatched, stats) {
  let parsed = parseAnimeFilename(file.name)

  // Filenames like "S02E01-Episode Title [hash].mkv" contain no anime title —
  // only an episode code followed by the episode title. Detect this by checking
  // whether the extracted title itself begins with a SxxExx marker, then
  // override with the folder-derived anime title.
  if (/^[Ss]\d{1,2}[Ee]\d{1,2}(\s|$)/.test(parsed.title)) {
    const folderTitle = extractAnimeTitleFromPath(file.path, animeFolder)
    const epMatch = LEADING_EP_RE.exec(file.name.replace(/\.[^.]+$/, ''))
    if (folderTitle && epMatch) {
      logger.info('indexer', 'anime title derived from folder', { filename: file.name, folderTitle })
      parsed = {
        type: 'series',
        title: folderTitle,
        year: null,
        season: parseInt(epMatch[1], 10),
        episode: parseInt(epMatch[2], 10),
        raw: file.name
      }
    }
  }

  let kitsuId
  try {
    kitsuId = await resolveToKitsuId({ title: parsed.title, year: parsed.year, type: parsed.type })
  } catch (err) {
    const reason = err.message
    logger.warn('indexer', 'Kitsu resolve failed', { filename: file.name, reason })
    insertUnmatched.run({ filename: file.name, mega_handle: file.handle, reason })
    stats.unmatched++
    return
  }

  if (!kitsuId) {
    const reason = `No match found on Kitsu for "${parsed.title}"${parsed.year ? ` (${parsed.year})` : ''}`
    logger.warn('indexer', 'no Kitsu match', { filename: file.name, reason })
    insertUnmatched.run({ filename: file.name, mega_handle: file.handle, reason })
    stats.unmatched++
    return
  }

  insertFile.run({
    imdb_id: kitsuId,
    season: parsed.season ?? 0,
    episode: parsed.episode ?? 0,
    filename: file.name,
    mega_handle: file.handle
  })

  const epLabel = parsed.season != null
    ? ` S${String(parsed.season).padStart(2, '0')}E${String(parsed.episode).padStart(2, '0')}`
    : ''
  logger.info('indexer', 'anime file indexed', { filename: file.name, kitsuId, episode: epLabel || null })
  stats.matched++
}

/** Return the lowercased extension of a filename (e.g. ".mkv"), or "" if none. */
function extOf (filename) {
  const dot = filename.lastIndexOf('.')
  return dot === -1 ? '' : filename.slice(dot).toLowerCase()
}

module.exports = { indexFiles }
