const { addonBuilder } = require('stremio-addon-sdk')
const manifest = require('./manifest')
const { getDb } = require('./db')

const builder = new addonBuilder(manifest)

builder.defineCatalogHandler(({ type, id }) =>
  Promise.resolve({ metas: [] })
)

builder.defineMetaHandler(({ type, id }) =>
  Promise.resolve({ meta: null })
)

builder.defineStreamHandler(({ type, id }) => {
  const token = process.env.USER_TOKEN
  const baseUrl = process.env.BASE_URL ||
    `http://localhost:${process.env.PORT || '7000'}`

  if (!token) {
    console.error('USER_TOKEN not set, cannot generate stream URLs')
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
    return Promise.resolve({ streams: [] })
  }

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
