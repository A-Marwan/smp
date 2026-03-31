'use strict'

const path = require('path')
const Database = require('better-sqlite3')

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data.db')

let _db = null

/**
 * Returns a singleton SQLite database connection.
 * Creates and migrates the schema on first call.
 *
 * @returns {import('better-sqlite3').Database}
 */
function getDb () {
  if (_db) return _db

  _db = new Database(DB_PATH)
  _db.pragma('journal_mode = WAL')

  _db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      imdb_id     TEXT    NOT NULL,
      season      INTEGER NOT NULL DEFAULT 0,
      episode     INTEGER NOT NULL DEFAULT 0,
      filename    TEXT,
      mega_handle TEXT,
      PRIMARY KEY (imdb_id, season, episode)
    );

    CREATE TABLE IF NOT EXISTS unmatched_files (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      filename    TEXT    NOT NULL,
      mega_handle TEXT,
      reason      TEXT,
      created_at  TEXT    DEFAULT (datetime('now'))
    );
  `)

  return _db
}

module.exports = { getDb, DB_PATH }
