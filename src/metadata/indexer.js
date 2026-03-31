'use strict'

const { parseFilename } = require('./parser')
const { resolveToImdbId } = require('./resolver')
const { getDb } = require('../db')

/** Video extensions that are worth indexing. */
const VIDEO_EXTS = new Set(['.mkv', '.mp4', '.avi', '.mov', '.wmv', '.m4v', '.ts', '.mpg', '.mpeg', '.webm'])

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

    const parsed = parseFilename(file.name)

    let imdbId
    try {
      imdbId = await resolveToImdbId({ title: parsed.title, year: parsed.year, type: parsed.type })
    } catch (err) {
      const reason = err.message
      console.warn(`[WARN] resolve failed — ${file.name}: ${reason}`)
      insertUnmatched.run({ filename: file.name, mega_handle: file.handle, reason })
      stats.unmatched++
      continue
    }

    if (!imdbId) {
      const reason = `No match found on Cinemeta for "${parsed.title}"${parsed.year ? ` (${parsed.year})` : ''}`
      console.warn(`[WARN] ${reason} — ${file.name}`)
      insertUnmatched.run({ filename: file.name, mega_handle: file.handle, reason })
      stats.unmatched++
      continue
    }

    // Movies use season=0 / episode=0 so the composite PK stays stable
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
    console.log(`[OK]   ${file.name} → ${imdbId}${epLabel}`)
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
