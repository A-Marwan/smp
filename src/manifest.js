module.exports = {
  id: 'com.example.stremio-mega-proxy',
  version: '0.1.0',
  name: 'MEGA Proxy',
  description: 'Stream movies and series from MEGA cloud storage',
  resources: ['catalog', 'stream', 'meta'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [
    { type: 'movie', id: 'smp-movies', name: 'MEGA Movies' },
    { type: 'series', id: 'smp-series', name: 'MEGA Series' }
  ]
}
