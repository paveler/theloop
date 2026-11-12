/**
 * Preload for the no-egress test (SPEC §14): records every outbound connection attempt and
 * every name lookup the process makes, then fails it. Loaded with --require before the engine.
 */
const fs = require('node:fs')
const net = require('node:net')
const dns = require('node:dns')

const out = process.env.NO_EGRESS_LOG
function record(kind, target) {
  fs.appendFileSync(out, `${kind} ${target}\n`)
}

const connect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (...args) {
  // net.connect passes its normalized [options, callback] array as the first argument
  const first = Array.isArray(args[0]) ? args[0][0] : args[0]
  const opts = typeof first === 'object' && first !== null ? first : { port: first, host: args[1] }
  // IPC pipes (path) are local plumbing of the tooling, not network egress
  if (!opts.path) record('connect', `${opts.host ?? 'localhost'}:${opts.port}`)
  return connect.apply(this, args)
}

for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny']) {
  const original = dns[name]
  dns[name] = function (host, ...rest) {
    record(`dns.${name}`, host)
    return original.call(this, host, ...rest)
  }
}
const promiseLookup = dns.promises.lookup
dns.promises.lookup = function (host, ...rest) {
  record('dns.promises.lookup', host)
  return promiseLookup.call(this, host, ...rest)
}
