// Load .env first with override so local config takes precedence over inherited env vars
require('dotenv').config({ override: true })

const path = require('path')
const PORT = parseInt(process.env.PORT || '7000', 10)
const express = require('express')
const { getRouter } = require('stremio-addon-sdk')
const addonInterface = require('./addon')
const { getStorage, clearStorage } = require('./mega-storage')

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

app.use(express.json())

// --- Admin MFA endpoint ---
app.post('/:token/admin/mfa', async (req, res) => {
  const expectedToken = process.env.USER_TOKEN
  if (!expectedToken || req.params.token !== expectedToken) {
    return res.status(403).json({ ok: false, error: 'Forbidden' })
  }

  const code = req.body && req.body.code
  if (!code || typeof code !== 'string') {
    return res.status(400).json({ ok: false, error: 'Missing "code" in request body' })
  }

  try {
    clearStorage()
    await getStorage({ mfaCode: code })
    console.log('MEGA re-authenticated via admin MFA endpoint')
    res.json({ ok: true })
  } catch (err) {
    console.error('Admin MFA failed:', err.message)
    res.status(500).json({ ok: false, error: err.message })
  }
})

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
    if (file.size) {
      res.setHeader('Content-Length', file.size)
    }

    const downloadStream = file.download()

    downloadStream.on('error', (err) => {
      const msg = err.message || ''
      console.error(`MEGA download error for ${handle}:`, msg)

      if (msg.includes('EEXPIRED')) {
        clearStorage()
        console.error('MEGA session expired during download — admin must POST a fresh MFA code to /:token/admin/mfa')
        if (!res.headersSent) {
          return res.status(503).json({ error: 'MEGA session expired — admin must re-authenticate via POST /:token/admin/mfa' })
        }
        return res.destroy()
      }

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
    const msg = err.message || ''
    console.error(`Stream proxy error for ${handle}:`, msg)

    if (msg.includes('EEXPIRED')) {
      clearStorage()
      console.error('MEGA session expired — admin must POST a fresh MFA code to /:token/admin/mfa')
    }

    if (!res.headersSent) {
      if (msg.includes('MFA') || msg.includes('EEXPIRED') || msg.includes('EMFAREQUIRED')) {
        return res.status(503).json({ error: 'MEGA session expired — admin must re-authenticate via POST /:token/admin/mfa' })
      }
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

// Eager MEGA login on startup to preload the file tree and avoid cold-start delay.
// If MFA is required and no code is available, the server still starts — admin can
// POST a TOTP code to /:token/admin/mfa later.
if (process.env.USER_TOKEN) {
  getStorage()
    .then(() => console.log('MEGA storage ready'))
    .catch((err) => {
      console.error('MEGA storage init failed:', err.message)
      console.error('Server is running but MEGA is not authenticated. Use POST /:token/admin/mfa to provide a TOTP code.')
    })
}

app.listen(PORT, () => {
  console.log(`Addon running at http://localhost:${PORT}`)
  console.log(`Manifest:        http://localhost:${PORT}/manifest.json`)
  console.log(`Token-prefixed:  http://localhost:${PORT}/YOUR_TOKEN/manifest.json`)
})
