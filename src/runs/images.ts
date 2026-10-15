/**
 * Images (SPEC §5.3): a data: URL or https from a host in EGRESS_ALLOWLIST.
 * The engine downloads them with its own egress client; SDK adapters never fetch URLs.
 */
import type { Config } from '../config.js'
import type { ProviderId, StoredMessage } from '../contracts.js'
import type { EgressClient } from '../egress/client.js'
import { EngineError } from '../errors.js'
import { texts, type Texts } from '../i18n.js'

export const ALLOWED_IMAGE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/**
 * GigaChat accepts an image only as a file via POST /files, and there webp and gif get
 * "File format is not supported" (verified live). Refused at request validation, not
 * mid-run.
 */
const PROVIDER_IMAGE_TYPES: Partial<Record<ProviderId, ReadonlySet<string>>> = {
  gigachat: new Set(['image/png', 'image/jpeg']),
  glm: new Set(['image/png', 'image/jpeg']), // z.ai: "jpg, png, jpeg"
}

export function imageTypesFor(provider: ProviderId): ReadonlySet<string> {
  return PROVIDER_IMAGE_TYPES[provider] ?? ALLOWED_IMAGE_TYPES
}

function unsupportedType(mediaType: string, types: ReadonlySet<string>): string {
  return `MIME ${mediaType || '?'} is not supported (allowed: ${[...types].join(', ')})`
}

export interface ResolvedImage {
  data: Uint8Array
  mediaType: string
}

export function parseDataUrl(
  url: string,
  maxBytes: number,
  types: ReadonlySet<string> = ALLOWED_IMAGE_TYPES,
): ResolvedImage {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(url)
  if (!match) throw new EngineError('bad_request', 'invalid data: URL of an image')
  const mediaType = (match[1] ?? '').toLowerCase()
  if (!types.has(mediaType)) {
    throw new EngineError('unsupported_media_type', unsupportedType(mediaType, types))
  }
  const payload = match[3] ?? ''
  const data = match[2]
    ? new Uint8Array(Buffer.from(payload, 'base64'))
    : new Uint8Array(Buffer.from(decodeURIComponent(payload), 'utf8'))
  if (data.byteLength > maxBytes) {
    throw new EngineError('image_too_large', `image is larger than ${maxBytes} bytes`)
  }
  return { data, mediaType }
}

/**
 * Check at request validation: host and MIME — a 400 before the run is created
 * (SPEC §5.3). The image itself is downloaded inside the run.
 */
export function validateImages(
  messages: readonly StoredMessage[],
  egress: EgressClient,
  config: Config,
  provider: ProviderId,
): void {
  const types = imageTypesFor(provider)
  for (const message of messages) {
    if (message.role !== 'user') continue
    for (const part of message.content) {
      if (part.type !== 'image') continue
      if (part.url.startsWith('data:')) {
        parseDataUrl(part.url, config.imageMaxBytes, types)
      } else {
        egress.assertAllowed(part.url, 'image')
      }
    }
  }
}

export function createImageResolver(
  egress: EgressClient,
  config: Config,
  signal: AbortSignal,
  provider: ProviderId,
  t: Texts = texts(),
): (url: string) => Promise<ResolvedImage> {
  const types = imageTypesFor(provider)
  const cache = new Map<string, Promise<ResolvedImage>>()
  return (url: string) => {
    const hit = cache.get(url)
    if (hit) return hit
    const task = (async () => {
      if (url.startsWith('data:')) return parseDataUrl(url, config.imageMaxBytes, types)
      try {
        const { bytes, mediaType } = await egress.fetchImage(url, signal)
        if (!types.has(mediaType)) {
          throw new EngineError('image_fetch_failed', unsupportedType(mediaType, types))
        }
        return { data: bytes, mediaType }
      } catch (err) {
        if (err instanceof EngineError && err.code === 'image_fetch_failed') throw err
        throw new EngineError('image_fetch_failed', t.imageFetchFailed(err instanceof Error ? err.message : String(err)))
      }
    })()
    cache.set(url, task)
    return task
  }
}
