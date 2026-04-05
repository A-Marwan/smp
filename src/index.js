// Load .env first with override so local config takes precedence over inherited env vars
require('dotenv').config({ override: true })

const path = require('path')
const PORT = parseInt(process.env.PORT || '7000', 10)
const express = require('express')
const https = require('https')
https.globalAgent.maxSockets = 100 // Prevent connection pool exhaustion

const { getRouter } = require('stremio-addon-sdk')
const addonInterface = require('./addon')
const { getStorage, clearStorage } = require('./mega-storage')
const logger = require('./logger')
const { acquireSlot } = require('./stream-manager')

const app = express()
const router = getRouter(addonInterface)

const SMALL_REQUEST_THRESHOLD = 2 * 1024 * 1024 // 2 MB — bypass concurrency limiter

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

// --- HTTP access log ---
app.use((req, res, next) => {
  const start = Date.now()
  res.on('finish', () => {
    logger.info('http', 'request', {
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      latencyMs: Date.now() - start
    })
  })
  next()
})

// --- Admin MFA endpoint ---
app.post('/:token/admin/mfa', async (req, res) => {
  const expectedToken = process.env.USER_TOKEN
  if (!expectedToken || req.params.token !== expectedToken) {
    logger.warn('admin-mfa', 'auth failure — invalid or missing token', { ip: req.ip })
    return res.status(403).json({ ok: false, error: 'Forbidden' })
  }

  const code = req.body && req.body.code
  if (!code || typeof code !== 'string') {
    return res.status(400).json({ ok: false, error: 'Missing "code" in request body' })
  }

  try {
    clearStorage()
    await getStorage({ mfaCode: code })
    logger.info('admin-mfa', 'MFA re-authentication succeeded')
    res.json({ ok: true })
  } catch (err) {
    logger.error('admin-mfa', 'MFA re-authentication failed', { error: err.message })
    res.status(500).json({ ok: false, error: err.message })
  }
})

// --- HEAD handler: return headers only, no MEGA download ---
app.head('/:token/stream/:handle', async (req, res) => {
  const expectedToken = process.env.USER_TOKEN
  if (!expectedToken || req.params.token !== expectedToken) {
    return res.status(403).end()
  }

  const handle = req.params.handle
  try {
    const storage = await getStorage()
    const file = findInTree(storage.root, handle)
    if (!file) return res.status(404).end()

    const ext = path.extname(file.name || '').toLowerCase()
    res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream')
    res.setHeader('Accept-Ranges', 'bytes')
    if (file.size) res.setHeader('Content-Length', file.size)

    logger.info('stream', 'HEAD served', { handle, filename: file.name, size: file.size })
    res.status(200).end()
  } catch (err) {
    logger.error('stream', 'HEAD error', { handle, error: err.message })
    if (!res.headersSent) res.status(500).end()
  }
})

// --- Proxy streaming endpoint (must be registered before the Stremio SDK catch-all) ---
app.get('/:token/stream/:handle', async (req, res) => {
  const expectedToken = process.env.USER_TOKEN
  if (!expectedToken || req.params.token !== expectedToken) {
    logger.warn('stream', 'auth failure — invalid or missing token', { handle: req.params.handle, ip: req.ip })
    return res.status(403).json({ error: 'Forbidden' })
  }

  const handle = req.params.handle
  let release = null
  let streamDestroyed = false

  try {
    const storage = await getStorage()

    const file = findInTree(storage.root, handle)
    if (!file) {
      logger.warn('stream', 'file not found in MEGA tree', { handle })
      return res.status(404).json({ error: 'File not found in MEGA' })
    }

    const ext = path.extname(file.name || '').toLowerCase()
    const contentType = MIME_TYPES[ext] || 'application/octet-stream'

    logger.info('stream', 'stream request', { handle, filename: file.name, size: file.size, range: req.headers.range || null })

    res.setHeader('Content-Type', contentType)
    res.setHeader('Accept-Ranges', 'bytes')

    const range = req.headers.range
    let downloadStream
    // abortRef is populated after the download stream is created;
    // used by the stream manager to preempt this stream on a seek.
    const abortRef = {}
    const abortSelf = () => {
      streamDestroyed = true
      if (abortRef.stream) { abortRef.stream.destroy(); abortRef.stream = null }
      if (release) { release(); release = null }
      if (!res.headersSent) res.destroy()
      else if (!res.writableEnded) res.destroy()
    }

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

      if (chunkSize < SMALL_REQUEST_THRESHOLD) {
        logger.info('stream', 'small range — bypassing concurrency limiter', { handle, start, end, chunkSize })
      } else {
        // Acquire concurrency slot before starting MEGA download
        release = await acquireSlot(handle, abortSelf, start, file.size)
        if (req.destroyed || streamDestroyed) { if (release) { release(); release = null } return }
      }

      logger.info('stream', 'serving range request', { handle, start, end, chunkSize })
      downloadStream = file.download({ start, end: end + 1 })
      logger.info('stream', 'download stream created (range)', { handle })
      abortRef.stream = downloadStream
    } else {
      // Acquire concurrency slot before starting MEGA download
      release = await acquireSlot(handle, abortSelf, 0, file.size)
      if (req.destroyed || streamDestroyed) { if (release) { release(); release = null } return }

      logger.info('stream', 'serving full file', { handle, size: file.size })
      if (file.size) {
        res.setHeader('Content-Length', file.size)
      }
      downloadStream = file.download()
      logger.info('stream', 'download stream created (full)', { handle })
      abortRef.stream = downloadStream
    }

    downloadStream.on('error', (err) => {
      // Suppress errors after intentional destroy (race condition fix)
      if (streamDestroyed) return

      const msg = err.message || ''
      logger.error('stream', 'MEGA download stream error', { handle, error: msg })

      if (msg.includes('EEXPIRED')) {
        clearStorage()
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

    const firstDataTimeout = setTimeout(() => {
      if (!streamDestroyed) {
        logger.error('stream', 'timeout waiting for first data chunk', { handle })
        streamDestroyed = true
        if (downloadStream) {
          try { downloadStream.destroy() } catch (_) {}
        }
        if (release) { release(); release = null }
        if (!res.headersSent) res.status(504).end()
        else res.destroy()
      }
    }, 30000)

    req.on('close', () => {
      clearTimeout(firstDataTimeout)
      logger.info('stream', 'client disconnected', { handle })
      streamDestroyed = true
      abortRef.stream = null
      if (downloadStream) {
        try { downloadStream.destroy() } catch (_) {}
      }
      if (release) { release(); release = null }
    })

    downloadStream.on('end', () => {
      clearTimeout(firstDataTimeout)
      logger.info('stream', 'download stream ended', { handle })
      abortRef.stream = null
      if (release) { release(); release = null }
    })

    downloadStream.once('data', () => {
      clearTimeout(firstDataTimeout)
      logger.info('stream', 'first data chunk received', { handle })
    })

    logger.info('stream', 'piping to response', { handle })
    downloadStream.pipe(res)
  } catch (err) {
    if (release) { release(); release = null }

    const msg = err.message || ''

    if (msg.includes('EEXPIRED')) {
      clearStorage()
      logger.error('stream', 'MEGA session expired', { handle })
    } else if (msg.includes('EMFAREQUIRED')) {
      logger.error('stream', 'MEGA MFA required', { handle })
    } else {
      logger.error('stream', 'stream proxy error', { handle, error: msg })
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

// Startup diagnostics
logger.info('startup', 'server initializing', {
  port: PORT,
  baseUrl: process.env.BASE_URL || `http://localhost:${PORT}`,
  hasUserToken: !!process.env.USER_TOKEN
})

// Eager MEGA login on startup to preload the file tree and avoid cold-start delay.
// If MFA is required and no code is available, the server still starts — admin can
// POST a TOTP code to /:token/admin/mfa later.
if (process.env.USER_TOKEN) {
  getStorage()
    .then(() => logger.info('startup', 'MEGA storage ready'))
    .catch((err) => {
      logger.error('startup', 'MEGA storage init failed — server running without MEGA auth', { error: err.message })
    })
} else {
  logger.warn('startup', 'USER_TOKEN not set — stream proxy and admin endpoints are disabled')
}

app.listen(PORT, () => {
  logger.info('startup', 'listening', {
    url: `http://localhost:${PORT}`,
    manifest: `http://localhost:${PORT}/manifest.json`
  })
})
