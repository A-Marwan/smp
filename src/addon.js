const { addonBuilder } = require('stremio-addon-sdk')
const manifest = require('./manifest')

const builder = new addonBuilder(manifest)

builder.defineCatalogHandler(({ type, id }) =>
  Promise.resolve({ metas: [] })
)

builder.defineMetaHandler(({ type, id }) =>
  Promise.resolve({ meta: null })
)

builder.defineStreamHandler(({ type, id }) =>
  Promise.resolve({ streams: [] })
)

module.exports = builder.getInterface()
