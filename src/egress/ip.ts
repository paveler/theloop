/**
 * Address "privacy" check (SPEC §11.4): loopback / private / link-local /
 * CGNAT / multicast / reserved are forbidden, otherwise a tool with a foreign host could
 * reach the internal network.
 */

function ipv4Parts(ip: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip)
  if (!m) return null
  const parts = m.slice(1, 5).map(Number)
  return parts.every((n) => n >= 0 && n <= 255) ? parts : null
}

function isPrivateIpv4(ip: string): boolean {
  const p = ipv4Parts(ip)
  if (!p) return true // could not parse: treat as unsafe
  const [a = 0, b = 0, c = 0] = p
  if (a === 0) return true // 0.0.0.0/8
  if (a === 10) return true // 10/8
  if (a === 127) return true // loopback
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64/10
  if (a === 169 && b === 254) return true // link-local
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16/12
  if (a === 192 && b === 0 && c === 0) return true // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return true // TEST-NET-1
  if (a === 192 && b === 168) return true // 192.168/16
  if (a === 198 && (b === 18 || b === 19)) return true // benchmarking
  if (a === 198 && b === 51 && c === 100) return true // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true // TEST-NET-3
  if (a >= 224) return true // multicast + reserved + broadcast
  return false
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase().split('%')[0] ?? ''
  if (lower === '::' || lower === '::1') return true
  // IPv4-mapped / IPv4-compatible: check the embedded address
  const mapped = /^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower)
  if (mapped?.[1]) return isPrivateIpv4(mapped[1])
  // the same in hex form: URL normalizes [::ffff:127.0.0.1] to [::ffff:7f00:1]
  const mappedHex = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower)
  if (mappedHex?.[1] && mappedHex[2]) {
    const hi = parseInt(mappedHex[1], 16)
    const lo = parseInt(mappedHex[2], 16)
    return isPrivateIpv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
  }
  const head = lower.split(':')[0] ?? ''
  const first = parseInt(head.padStart(4, '0').slice(0, 4), 16)
  if (Number.isNaN(first)) return true
  if ((first & 0xfe00) === 0xfc00) return true // fc00::/7 unique-local
  if ((first & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true // ff00::/8 multicast
  if (lower.startsWith('2001:db8')) return true // documentation
  if (lower.startsWith('64:ff9b')) return true // NAT64
  return false
}

export function isPrivateAddress(ip: string, family?: number): boolean {
  if (family === 4) return isPrivateIpv4(ip)
  if (family === 6) return isPrivateIpv6(ip)
  return ip.includes(':') ? isPrivateIpv6(ip) : isPrivateIpv4(ip)
}

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

export function isLocalHostname(hostname: string): boolean {
  return LOCAL_HOSTNAMES.has(hostname.toLowerCase())
}
