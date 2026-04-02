'use strict'

const readline = require('readline')
const { Storage } = require('megajs')

/**
 * Prompt the user for a value on stderr/stdin (so stdout stays clean for piping).
 *
 * @param {string} question
 * @returns {Promise<string>}
 */
function prompt (question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

/**
 * Attempt one MEGA login and return the authenticated Storage instance.
 *
 * @param {{ email: string, password: string, mfaCode?: string }} opts
 * @returns {Promise<Storage>}
 */
function loginOnce ({ email, password, mfaCode }) {
  const storageOpts = { email, password, keepalive: true, autologin: false }
  if (mfaCode) storageOpts.secondFactorCode = mfaCode

  const storage = new Storage(storageOpts)

  return new Promise((resolve, reject) => {
    storage.login((err) => {
      if (!err) return resolve(storage)
      reject(err)
    })
  })
}

/**
 * Authenticates to MEGA and returns a logged-in Storage instance.
 *
 * If the account has MFA enabled the function will:
 *   1. Use MEGA_MFA_CODE from the environment if present.
 *   2. Prompt the user interactively on subsequent attempts when the code is
 *      missing or has expired (EEXPIRED / EMFAREQUIRED).
 *
 * Required env vars: MEGA_EMAIL, MEGA_PASSWORD
 * Optional env vars: MEGA_MFA_CODE  (6-digit TOTP — valid for ~30 s only)
 *
 * @returns {Promise<import('megajs').Storage>}
 */
async function createMegaClient () {
  const email = process.env.MEGA_EMAIL
  const password = process.env.MEGA_PASSWORD

  if (!email || !password) {
    throw new Error(
      'MEGA credentials missing: set MEGA_EMAIL and MEGA_PASSWORD environment variables'
    )
  }

  // First attempt: use env var if available
  let mfaCode = process.env.MEGA_MFA_CODE || undefined

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await loginOnce({ email, password, mfaCode })
    } catch (err) {
      const msg = err.message || ''

      const needsMfa = msg.includes('EMFAREQUIRED')
      const isExpired = msg.includes('EEXPIRED')
      const mfaExpired = isExpired && mfaCode

      if (needsMfa || mfaExpired) {
        if (needsMfa) {
          process.stderr.write('MEGA account requires Multi-Factor Authentication.\n')
        } else {
          process.stderr.write('Code expired — please open your authenticator app and enter a fresh 6-digit code immediately.\n')
        }

        if (!process.stdin.isTTY) {
          // Non-interactive: can't prompt — fail with a helpful message
          throw new Error(
            'MEGA MFA code required but stdin is not a terminal. ' +
            'Set a fresh MEGA_MFA_CODE in your .env and re-run immediately.'
          )
        }

        mfaCode = await prompt('Enter your current MEGA TOTP code: ')
        attempt = 0 // reset counter for interactive attempts
        continue
      }

      if (isExpired) {
        // Non-MFA EEXPIRED (stale session): retry with a fresh Storage instance
        continue
      }

      // Any other error is not recoverable by retrying
      throw err
    }
  }

  throw new Error('MEGA authentication failed after multiple attempts')
}

module.exports = { createMegaClient }
