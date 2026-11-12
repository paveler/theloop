/**
 * Addresses and CIDR ranges for private-network egress (SPEC §11.4).
 *
 * Every check normalizes first: IPv4-mapped / IPv4-compatible IPv6 become the embedded IPv4;
 * NAT64 and 6to4 carry an embedded IPv4 that the deny check sees too. Unconditional denies
 * (unspecified, link-local incl. cloud metadata, multicast / reserved) win over any range.
 */
import { isIP } from 'node:net'

export interface Addr {
  family: 4 | 6
  bytes: number[]
}

export interface Cidr {
  family: 4 | 6
  bytes: number[]
  prefix: number
  /** As written, for logs. */
  text: string
}

function parseV4(text: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text)
  if (!m) return null
  const parts = m.slice(1, 5).map(Number)
  return parts.every((n) => n >= 0 && n <= 255) ? parts : null
}

function parseV6(raw: string): number[] | null {
  let text = raw.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0] ?? ''
  // a dotted IPv4 tail: ::ffff:1.2.3.4
  const tail = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text)
  let tailBytes: number[] = []
  if (tail?.[1]) {
    const v4 = parseV4(tail[1])
    if (!v4) return null
    tailBytes = v4
    text = text.slice(0, -tail[1].length) + '0:0'
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - rest.length
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...rest]
  const bytes: number[] = []
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null
    const n = parseInt(g, 16)
    bytes.push(n >> 8, n & 255)
  }
  if (tailBytes.length === 4) bytes.splice(12, 4, ...tailBytes)
  return bytes.length === 16 ? bytes : null
}

export function parseAddr(text: string): Addr | null {
  const bare = text.replace(/^\[|\]$/g, '')
  const family = isIP(bare)
  if (family === 4) {
    const bytes = parseV4(bare)
    return bytes ? { family: 4, bytes } : null
  }
  if (family === 6) {
    const bytes = parseV6(bare)
    return bytes ? { family: 6, bytes } : null
  }
  return null
}

function startsWith(bytes: number[], prefix: number[]): boolean {
  return prefix.every((b, i) => bytes[i] === b)
}

const ZERO10 = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]

/** IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) → the IPv4 itself. */
export function normalize(addr: Addr): Addr {
  if (addr.family === 4) return addr
  const b = addr.bytes
  if (startsWith(b, [...ZERO10, 0xff, 0xff])) return { family: 4, bytes: b.slice(12) }
  const low = b.slice(12)
  if (startsWith(b, [...ZERO10, 0, 0]) && !(low[0] === 0 && low[1] === 0 && low[2] === 0 && (low[3] ?? 0) <= 1)) {
    return { family: 4, bytes: low }
  }
  return addr
}

/** The IPv4 a NAT64 (64:ff9b::/96, 64:ff9b:1::/48) or 6to4 (2002::/16) address carries. */
function embeddedV4(addr: Addr): Addr | null {
  if (addr.family !== 6) return null
  const b = addr.bytes
  if (startsWith(b, [0, 0x64, 0xff, 0x9b])) return { family: 4, bytes: b.slice(12) }
  if (startsWith(b, [0x20, 0x02])) return { family: 4, bytes: b.slice(2, 6) }
  return null
}

function parseCidrText(text: string): Cidr | null {
  const [ip, len, ...extra] = text.trim().split('/')
  if (!ip || extra.length > 0) return null
  const addr = parseAddr(ip)
  if (!addr) return null
  const max = addr.family === 4 ? 32 : 128
  const prefix = len == null ? max : Number(len)
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max || (len != null && !/^\d+$/.test(len))) return null
  return { family: addr.family, bytes: addr.bytes, prefix, text: text.trim() }
}

export function cidrContains(cidr: Cidr, addr: Addr): boolean {
  if (cidr.family !== addr.family) return false
  let bits = cidr.prefix
  for (let i = 0; bits > 0; i++, bits -= 8) {
    const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff
    if (((cidr.bytes[i] ?? 0) & mask) !== ((addr.bytes[i] ?? 0) & mask)) return false
  }
  return true
}

function overlaps(a: Cidr, b: Cidr): boolean {
  if (a.family !== b.family) return false
  return a.prefix <= b.prefix ? cidrContains(a, b) : cidrContains(b, a)
}

const deny = (text: string) => parseCidrText(text)!

/** Never reachable, whatever the env says (SPEC §11.4). */
const ALWAYS_DENY: Cidr[] = [
  deny('0.0.0.0/8'),
  deny('169.254.0.0/16'),
  deny('224.0.0.0/3'),
  deny('::/128'),
  deny('fe80::/10'),
  deny('ff00::/8'),
]

/** Translation ranges cannot be listed: they would smuggle IPv4 past the IPv4 checks. */
const TRANSLATION: Cidr[] = [
  deny('::ffff:0:0/96'),
  deny('::/96'),
  deny('64:ff9b::/96'),
  deny('64:ff9b:1::/48'),
  deny('2002::/16'),
]

/** Private, loopback, CGNAT, documentation and reserved ranges (SPEC §11.4). */
const PRIVATE: Cidr[] = [
  deny('0.0.0.0/8'),
  deny('10.0.0.0/8'),
  deny('100.64.0.0/10'),
  deny('127.0.0.0/8'),
  deny('169.254.0.0/16'),
  deny('172.16.0.0/12'),
  deny('192.0.0.0/24'),
  deny('192.0.2.0/24'),
  deny('192.168.0.0/16'),
  deny('198.18.0.0/15'),
  deny('198.51.100.0/24'),
  deny('203.0.113.0/24'),
  deny('224.0.0.0/3'),
  deny('::/127'),
  deny('fc00::/7'),
  deny('fe80::/10'),
  deny('ff00::/8'),
  deny('2001:db8::/32'),
  deny('64:ff9b::/96'),
  deny('64:ff9b:1::/48'),
]

/**
 * Private by its bytes, not by its spelling: the normalized form, and for NAT64 / 6to4 the
 * IPv4 it carries, are checked too — `[2002:7f00:1::1]` is loopback in disguise.
 */
export function isPrivateAddr(raw: Addr): boolean {
  const forms = [raw, normalize(raw), embeddedV4(raw)].filter((a): a is Addr => a !== null)
  return forms.some((a) => PRIVATE.some((p) => cidrContains(p, a)))
}

/**
 * Egress decision for one address: never an always-denied one; a public one yes; a private
 * one only inside a listed range, and never when the private IPv4 is carried by a translation
 * (NAT64 / 6to4) form.
 */
export function addressAllowed(raw: Addr, cidrs: readonly Cidr[]): boolean {
  if (alwaysDenied(raw)) return false
  if (!isPrivateAddr(raw)) return true
  if (embeddedV4(raw)) return false
  return inListedRange(raw, cidrs)
}

export function alwaysDenied(raw: Addr): boolean {
  const forms = [raw, normalize(raw), embeddedV4(raw)].filter((a): a is Addr => a !== null)
  return forms.some((a) => ALWAYS_DENY.some((d) => cidrContains(d, a)))
}

/** EGRESS_PRIVATE_CIDRS; a malformed or forbidden range stops the engine. */
export function parseCidrList(raw: string | undefined): Cidr[] {
  if (!raw?.trim()) return []
  const out: Cidr[] = []
  for (const item of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const cidr = parseCidrText(item)
    if (!cidr) throw new Error(`env EGRESS_PRIVATE_CIDRS: "${item}" is not a CIDR range`)
    // ::1/128 sits inside ::/96 but is IPv6 loopback, not a translated address
    const loopback6 = cidr.family === 6 && cidr.prefix === 128 && cidr.bytes.every((v, i) => v === (i === 15 ? 1 : 0))
    if (cidr.family === 6 && !loopback6 && TRANSLATION.some((t) => overlaps(t, cidr))) {
      throw new Error(`env EGRESS_PRIVATE_CIDRS: "${item}" overlaps an IPv4 translation range (mapped / NAT64 / 6to4)`)
    }
    if (ALWAYS_DENY.some((d) => overlaps(d, cidr))) {
      throw new Error(
        `env EGRESS_PRIVATE_CIDRS: "${item}" overlaps a range that is never allowed (unspecified, link-local, multicast / reserved)`,
      )
    }
    out.push(cidr)
  }
  return out
}

/** A private address inside a listed range (mapped / compatible forms normalized first). */
export function inListedRange(raw: Addr, cidrs: readonly Cidr[]): boolean {
  if (alwaysDenied(raw)) return false
  const addr = normalize(raw)
  return cidrs.some((c) => cidrContains(c, addr))
}
