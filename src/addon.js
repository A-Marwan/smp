const { addonBuilder } = require('stremio-addon-sdk')
const manifest = require('./manifest')
const { getDb } = require('./db')
const { getMetadata } = require('./metadata/cinemeta')
const logger = require('./logger')

const builder = new addonBuilder(manifest)

builder.defineCatalogHandler(async ({ type, id }) => {
  logger.info('addon', 'catalogHandler called', { type, id })
  const db = getDb()

  let rows
  if (type === 'movie') {
    rows = db.prepare(
      'SELECT DISTINCT imdb_id FROM files WHERE season = 0 AND episode = 0'
    ).all()
  } else {
    rows = db.prepare(
      'SELECT DISTINCT imdb_id FROM files WHERE season > 0'
    ).all()
  }

  logger.info('addon', 'catalog DB query complete', { type, rowCount: rows.length })

  const metas = []
  for (const row of rows) {
    const meta = await getMetadata(type, row.imdb_id)
    if (meta) {
      metas.push({
        id: meta.id || row.imdb_id,
        type,
        name: meta.name || row.imdb_id,
        poster: meta.poster || null,
        posterShape: 'poster',
        year: meta.year || null
      })
    }
  }

  logger.info('addon', 'catalog response ready', { type, metaCount: metas.length })
  return { metas }
})

builder.defineMetaHandler(async ({ type, id }) => {
  logger.info('addon', 'metaHandler called', { type, id })
  const meta = await getMetadata(type, id)
  if (!meta) {
    logger.warn('addon', 'metaHandler: Cinemeta returned null', { type, id })
    return { meta: null }
  }

  logger.info('addon', 'metaHandler: metadata fetched', { type, id, name: meta.name })

  const result = {
    id: meta.id || id,
    type,
    name: meta.name,
    poster: meta.poster || null,
    background: meta.background || null,
    description: meta.description || null,
    year: meta.year || null,
    genres: meta.genres || []
  }

  if (type === 'series') {
    const db = getDb()
    const episodes = db.prepare(
      'SELECT season, episode, filename FROM files WHERE imdb_id = ? AND season > 0 ORDER BY season, episode'
    ).all(id)

    logger.info('addon', 'metaHandler: episodes queried', { id, episodeCount: episodes.length })

    result.videos = episodes.map((ep) => ({
      id: `${id}:${ep.season}:${ep.episode}`,
      title: ep.filename || `S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')}`,
      season: ep.season,
      episode: ep.episode,
      released: new Date().toISOString()
    }))
  }

  return { meta: result }
})

builder.defineStreamHandler(({ type, id }) => {
  logger.info('addon', 'streamHandler called', { type, id })
  const token = process.env.USER_TOKEN
  const baseUrl = process.env.BASE_URL ||
    `http://localhost:${process.env.PORT || '7000'}`

  if (!token) {
    logger.error('addon', 'USER_TOKEN not set — cannot generate stream URLs')
    return Promise.resolve({ streams: [] })
  }

  // Parse id: "tt1234567" (movie) or "tt1234567:1:3" (series S01E03)
  const parts = id.split(':')
  const imdbId = parts[0]
  const season = parts.length >= 3 ? parseInt(parts[1], 10) : 0
  const episode = parts.length >= 3 ? parseInt(parts[2], 10) : 0

  const db = getDb()
  const row = db.prepare(
    'SELECT mega_handle, filename FROM files WHERE imdb_id = ? AND season = ? AND episode = ?'
  ).get(imdbId, season, episode)

  if (!row || !row.mega_handle) {
    logger.info('addon', 'streamHandler: no DB row found', { imdbId, season, episode })
    return Promise.resolve({ streams: [] })
  }

  logger.info('addon', 'streamHandler: DB row found', { imdbId, season, episode, handle: row.mega_handle })

  const streamUrl = `${baseUrl}/${token}/stream/${row.mega_handle}`

  const streams = [{
    url: streamUrl,
    name: 'MEGA',
    description: row.filename || 'Stream from MEGA',
    behaviorHints: {
      notWebReady: true,
      bingeGroup: type === 'series' ? `mega-${imdbId}` : undefined
    }
  }]

  return Promise.resolve({ streams })
})

module.exports = builder.getInterface()
