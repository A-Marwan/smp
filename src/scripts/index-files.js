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

  let storage
  try {
    storage = await createMegaClient()
  } catch (err) {
    console.error('Authentication failed:', err.message)
    process.exit(1)
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
