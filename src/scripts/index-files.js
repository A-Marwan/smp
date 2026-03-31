#!/usr/bin/env node
'use strict'

/**
 * Metadata indexing script.
 * Crawls MEGA, parses filenames, resolves IMDb IDs via Cinemeta,
 * and populates the local SQLite database.
 *
 * Usage:
 *   node src/scripts/index-files.js
 *
 * Required env vars: MEGA_EMAIL, MEGA_PASSWORD
 * Optional env vars: MEGA_ROOT_FOLDER, DB_PATH
 */

require('dotenv').config({ override: true })

const { createMegaClient } = require('../mega-client')
const { crawlMega } = require('../crawler')
const { indexFiles } = require('../metadata/indexer')
const { DB_PATH } = require('../db')

async function main () {
  console.log('Connecting to MEGA...')

  // MEGA occasionally returns EEXPIRED (-8) on the first login attempt when a
  // previous session was recently closed.  Retrying with a brand-new call to
  // createMegaClient() (which always constructs a fresh Storage instance) is
  // sufficient to recover without touching mega-client.js internals.
  let storage
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      storage = await createMegaClient()
      break
    } catch (err) {
      const isExpired = err.message && err.message.includes('EEXPIRED')
      if (isExpired && attempt < 2) {
        console.warn(`MEGA session expired, retrying (attempt ${attempt + 2}/3)...`)
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
        continue
      }
      console.error('Authentication failed:', err.message)
      process.exit(1)
    }
  }

  console.log('Authenticated. Crawling MEGA file tree...\n')

  const result = await crawlMega(storage)

  if (!result.success) {
    console.error('Crawler error:', result.error)
    await storage.close()
    process.exit(1)
  }

  console.log(`Found ${result.totalFiles} video-candidate file(s). Starting metadata lookup...\n`)

  const stats = await indexFiles(result.files)

  console.log('\n=== Indexing Complete ===')
  console.log(`Matched   : ${stats.matched}`)
  console.log(`Unmatched : ${stats.unmatched}  (logged to unmatched_files table)`)
  console.log(`Skipped   : ${stats.skipped}  (non-video files)`)
  console.log(`Database  : ${DB_PATH}`)

  await storage.close()
}

main().catch((err) => {
  console.error('Fatal error:', err.message)
  process.exit(1)
})
