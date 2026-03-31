// Load .env first with override so local config takes precedence over inherited env vars
require('dotenv').config({ override: true })

const PORT = parseInt(process.env.PORT || '7000', 10)
const express = require('express')
const { getRouter } = require('stremio-addon-sdk')
const addonInterface = require('./addon')
const app = express()
const router = getRouter(addonInterface)

// Token-prefixed routing: /:token/manifest.json, /:token/stream/:type/:id.json, etc.
// Express strips the matched prefix before passing to the router, so the router
// sees clean paths like /manifest.json regardless of the token segment.
app.use('/:token', (req, res, next) => {
  req.userToken = req.params.token
  next()
}, router)

// Root fallback (no token)
app.use('/', router)

app.listen(PORT, () => {
  console.log(`Addon running at http://localhost:${PORT}`)
  console.log(`Manifest:        http://localhost:${PORT}/manifest.json`)
  console.log(`Token-prefixed:  http://localhost:${PORT}/YOUR_TOKEN/manifest.json`)
})
