'use strict'

const { Storage } = require('megajs')

/**
 * Authenticates to MEGA using credentials from environment variables.
 * Returns a logged-in Storage instance.
 *
 * Required env vars: MEGA_EMAIL, MEGA_PASSWORD
 *
 * @returns {Promise<Storage>}
 */
async function createMegaClient () {
  const email = process.env.MEGA_EMAIL
  const password = process.env.MEGA_PASSWORD

  if (!email || !password) {
    throw new Error(
      'MEGA credentials missing: set MEGA_EMAIL and MEGA_PASSWORD environment variables'
    )
  }

  const storage = new Storage({ email, password })

  await new Promise((resolve, reject) => {
    storage.login((err) => {
      if (err) reject(err)
      else resolve()
    })
  })

  return storage
}

module.exports = { createMegaClient }
