'use strict'

function log (level, component, message, data) {
  const ts = new Date().toISOString()
  let suffix = ''
  if (data && typeof data === 'object') {
    const pairs = Object.entries(data)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')
    if (pairs) suffix = ' | ' + pairs
  }
  const out = `[${ts}] ${level.padEnd(5)} [${component}] ${message}${suffix}`
  if (level === 'ERROR') {
    console.error(out)
  } else if (level === 'WARN') {
    console.warn(out)
  } else {
    console.log(out)
  }
}

module.exports = {
  info: (component, msg, data) => log('INFO', component, msg, data),
  warn: (component, msg, data) => log('WARN', component, msg, data),
  error: (component, msg, data) => log('ERROR', component, msg, data)
}
