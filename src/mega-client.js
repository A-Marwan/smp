'use strict'

const { Storage } = require('megajs')

/**
 * Authenticates to MEGA using credentials from environment variables.
 * Returns a logged-in Storage instance.
 *
 * Required env vars: MEGA_EMAIL, MEGA_PASSWORD
 * Optional env vars: MEGA_MFA_CODE (TOTP code if MFA is enabled on the account)
 *
 * @returns {Promise<Storage>}
 */
async function createMegaClient () {
  const email = process.env.MEGA_EMAIL
  const password = process.env.MEGA_PASSWORD
  const mfaCode = process.env.MEGA_MFA_CODE || undefined

  if (!email || !password) {
    throw new Error(
      'MEGA credentials missing: set MEGA_EMAIL and MEGA_PASSWORD environment variables'
    )
  }

  const storageOpts = { email, password }
  if (mfaCode) storageOpts.secondFactorCode = mfaCode

  const storage = new Storage(storageOpts)

  await new Promise((resolve, reject) => {
    storage.login((err) => {
      if (err) {
        if (err.message && err.message.includes('EMFAREQUIRED')) {
          reject(new Error(
            'MEGA account has Multi-Factor Authentication enabled. ' +
            'Set the MEGA_MFA_CODE environment variable to your current TOTP code and retry.'
          ))
        } else {
          reject(err)
        }
      } else {
        resolve()
      }
    })
  })

  return storage
}

module.exports = { createMegaClient }
