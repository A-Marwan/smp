'use strict'

/**
 * MEGA file crawler.
 * Recursively traverses a MEGA folder tree and collects file metadata.
 *
 * @param {import('megajs').Storage} storage  Authenticated megajs Storage instance
 * @returns {Promise<CrawlResult>}
 *
 * @typedef {{ name: string, size: number, handle: string, path: string, isFolder: boolean }} FileEntry
 * @typedef {{ success: boolean, error: string|null, files: FileEntry[], totalFiles: number, totalSize: number }} CrawlResult
 */
async function crawlMega (storage) {
  // Determine starting node
  const rootFolderName = process.env.MEGA_ROOT_FOLDER

  let startNode
  if (rootFolderName) {
    startNode = storage.root.children
      ? storage.root.children.find(
          (n) => n.directory && n.name === rootFolderName
        )
      : null

    if (!startNode) {
      return {
        success: false,
        error: `Root folder "${rootFolderName}" not found in MEGA account`,
        files: [],
        totalFiles: 0,
        totalSize: 0
      }
    }
  } else {
    startNode = storage.root
  }

  const files = []

  try {
    walkNode(startNode, rootFolderName || '', files)
  } catch (err) {
    return buildErrorResult(err)
  }

  const fileNodes = files.filter((f) => !f.isFolder)

  return {
    success: true,
    error: null,
    files,
    totalFiles: fileNodes.length,
    totalSize: fileNodes.reduce((sum, f) => sum + f.size, 0)
  }
}

/**
 * Recursively walks a MEGA folder node, appending entries to `out`.
 *
 * @param {object} node   megajs file/folder node
 * @param {string} path   current path string (for display)
 * @param {FileEntry[]} out  accumulator
 */
function walkNode (node, path, out) {
  if (!node) return

  const entry = {
    name: node.name,
    size: node.size || 0,
    handle: node.nodeId || '',
    path,
    isFolder: !!node.directory
  }

  out.push(entry)

  if (node.directory && Array.isArray(node.children)) {
    const childPath = path ? `${path}/${node.name}` : node.name
    for (const child of node.children) {
      walkNode(child, childPath, out)
    }
  }
}

/**
 * Maps a megajs error to a user-facing result, handling quota and auth errors.
 *
 * @param {Error} err
 * @returns {CrawlResult}
 */
function buildErrorResult (err) {
  const msg = err.message || String(err)

  // MEGA error codes surfaced as error messages by megajs
  if (msg.includes('EOVERQUOTA') || msg.includes('509')) {
    return {
      success: false,
      error: 'Transfer quota exceeded on this MEGA account. Please try again later.',
      files: [],
      totalFiles: 0,
      totalSize: 0
    }
  }

  if (msg.includes('EACCESS') || msg.includes('ENOENT') || msg.includes('EARGS')) {
    return {
      success: false,
      error: `MEGA access error: ${msg}`,
      files: [],
      totalFiles: 0,
      totalSize: 0
    }
  }

  return {
    success: false,
    error: `MEGA crawler error: ${msg}`,
    files: [],
    totalFiles: 0,
    totalSize: 0
  }
}

module.exports = { crawlMega }
