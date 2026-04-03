// Load .env first with override so local config takes precedence over inherited env vars
require('dotenv').config({ override: true })

const path = require('path')
const PORT = parseInt(process.env.PORT || '7000', 10)
const express = require('express')
const { getRouter } = require('stremio-addon-sdk')
const addonInterface = require('./addon')
const { getStorage } = require('./mega-storage')

const app = express()
const router = getRouter(addonInterface)

const MIME_TYPES = {
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
  '.m4v': 'video/x-m4v',
  '.ts': 'video/mp2t',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg'
}

/**
 * Recursively search the MEGA file tree for a node matching the given handle.
 */
function findInTree (node, handle) {
  if (!node) return null
  if (node.nodeId === handle) return node
  if (node.children) {
    for (const child of node.children) {
      const found = findInTree(child, handle)
      if (found) return found
    }
  }
  return null
}

// --- Proxy streaming endpoint (must be registered before the Stremio SDK catch-all) ---
app.get('/:token/stream/:handle', async (req, res) => {
  const expectedToken = process.env.USER_TOKEN
  if (!expectedToken || req.params.token !== expectedToken) {
    return res.status(403).json({ error: 'Forbidden' })
  }

  const handle = req.params.handle

  try {
    const storage = await getStorage()

    const file = findInTree(storage.root, handle)
    if (!file) {
      return res.status(404).json({ error: 'File not found in MEGA' })
    }

    const ext = path.extname(file.name || '').toLowerCase()
    const contentType = MIME_TYPES[ext] || 'application/octet-stream'

    res.setHeader('Content-Type', contentType)
    res.setHeader('Accept-Ranges', 'bytes')

    const range = req.headers.range
    let downloadStream

    if (range && file.size) {
      const parts = range.replace(/bytes=/, '').split('-')
      const start = parseInt(parts[0], 10)
      const end = parts[1] ? parseInt(parts[1], 10) : file.size - 1
      const chunkSize = end - start + 1

      if (start >= file.size || end >= file.size || start > end || isNaN(start)) {
        return res.status(416)
          .setHeader('Content-Range', `bytes */${file.size}`)
          .end()
      }

      res.status(206)
      res.setHeader('Content-Range', `bytes ${start}-${end}/${file.size}`)
      res.setHeader('Content-Length', chunkSize)

      downloadStream = file.download({ start, end: end + 1 })
    } else {
      if (file.size) {
        res.setHeader('Content-Length', file.size)
      }
      downloadStream = file.download()
    }

    downloadStream.on('error', (err) => {
      const msg = err.message || ''
      console.error(`MEGA download error for ${handle}:`, msg)

      if (!res.headersSent) {
        if (msg.includes('EOVERQUOTA') || msg.includes('over quota')) {
          return res.status(429).json({ error: 'MEGA transfer quota exceeded. Try again later.' })
        }
        return res.status(502).json({ error: 'MEGA download failed' })
      }
      res.destroy()
    })

    req.on('close', () => {
      downloadStream.destroy()
    })

    downloadStream.pipe(res)
  } catch (err) {
    console.error(`Stream proxy error for ${handle}:`, err.message)
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' })
    }
  }
})

// Token-prefixed routing: /:token/manifest.json, /:token/stream/:type/:id.json, etc.
// Express strips the matched prefix before passing to the router, so the router
// sees clean paths like /manifest.json regardless of the token segment.
app.use('/:token', (req, res, next) => {
  req.userToken = req.params.token
  next()
}, router)

// Root fallback (no token)
app.use('/', router)

// Eager MEGA login on startup to preload the file tree and avoid cold-start delay
if (process.env.USER_TOKEN) {
  getStorage()
    .then(() => console.log('MEGA storage ready'))
    .catch((err) => console.error('MEGA storage init failed:', err.message))
}

app.listen(PORT, () => {
  console.log(`Addon running at http://localhost:${PORT}`)
  console.log(`Manifest:        http://localhost:${PORT}/manifest.json`)
  console.log(`Token-prefixed:  http://localhost:${PORT}/YOUR_TOKEN/manifest.json`)
})
