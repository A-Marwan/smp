#!/usr/bin/env node
'use strict'

/**
 * Standalone MEGA file scanner.
 * Usage: node src/scripts/scan-mega.js
 *
 * Required env vars: MEGA_EMAIL, MEGA_PASSWORD
 * Optional env vars: MEGA_ROOT_FOLDER
 */

require('dotenv').config({ override: true })

const { createMegaClient } = require('../mega-client')
const { crawlMega } = require('../crawler')

function formatBytes (bytes) {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`
}

async function main () {
  console.log('Connecting to MEGA...')

  let storage
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      storage = await createMegaClient()
      break
    } catch (err) {
      const isExpired = err.message && err.message.includes('EEXPIRED')
      if (isExpired && attempt < 2) {
        console.warn(`MEGA session expired, retrying (attempt ${attempt + 2}/3)...`)
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
        continue
      }
      console.error('Authentication failed:', err.message)
      process.exit(1)
    }
  }

  console.log('Authenticated. Starting file scan...\n')

  const result = await crawlMega(storage)

  if (!result.success) {
    console.error('Crawler error:', result.error)
    await storage.close()
    process.exit(1)
  }

  console.log('=== MEGA File Listing ===\n')
  for (const file of result.files) {
    if (file.isFolder) {
      console.log(`[DIR]  ${file.path}/${file.name}  (handle: ${file.handle})`)
    } else {
      console.log(
        `[FILE] ${file.path}/${file.name}  size: ${formatBytes(file.size)}  handle: ${file.handle}`
      )
    }
  }

  console.log(`\n=== Summary ===`)
  console.log(`Total files : ${result.totalFiles}`)
  console.log(`Total size  : ${formatBytes(result.totalSize)}`)
  console.log(`Total nodes : ${result.files.length}`)

  await storage.close()
}

main()
