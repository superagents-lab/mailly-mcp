// Relative import with an explicit extension so the Node test runner can load
// this module without the "@/" alias or a bundler.
import { normalizeRemoteImageUrl } from "./inbox-image-proxy"

// Server half of the inbox image proxy. Fetches one already-validated remote
// URL and returns it as an opaque image response. Every hop of a redirect goes
// through the same host validation as the original URL, so a public host
// cannot bounce us into a private network.

export const IMAGE_PROXY_MAX_BYTES = 10 * 1024 * 1024
export const IMAGE_PROXY_TIMEOUT_MS = 15_000
const MAX_REDIRECTS = 5
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

// No cookies, no referer, no identifying user agent: the sender's image host
// only ever sees the proxy.
const UPSTREAM_HEADERS = {
  Accept: "image/*,*/*;q=0.5",
  "User-Agent": "Mailly-Inbox-Image-Proxy/1.0 (+https://mailly.site)",
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

function detectImageType(bytes: Uint8Array): string | null {
  const startsWith = (...prefix: number[]) => prefix.every((byte, index) => bytes[index] === byte)
  if (startsWith(0x89, 0x50, 0x4e, 0x47)) return "image/png"
  if (startsWith(0xff, 0xd8, 0xff)) return "image/jpeg"
  if (startsWith(0x47, 0x49, 0x46, 0x38)) return "image/gif"
  if (startsWith(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp"
  if (startsWith(0x42, 0x4d)) return "image/bmp"
  if (bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11])
    if (brand === "avif" || brand === "avis") return "image/avif"
  }
  return null
}

function limitBytes(stream: ReadableStream<Uint8Array>, max: number) {
  let seen = 0
  return stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength
      if (seen > max) {
        controller.error(new Error("image exceeds size limit"))
        return
      }
      controller.enqueue(chunk)
    },
  }))
}

function failure(status: number, reason: string) {
  return new Response(reason, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "private, no-store" },
  })
}

async function discard(response: Response) {
  try {
    await response.body?.cancel()
  } catch {
    // The upstream body is irrelevant once we decided not to relay it.
  }
}

export async function fetchRemoteImage(target: string, fetchImpl: FetchLike = fetch): Promise<Response> {
  const signal = AbortSignal.timeout(IMAGE_PROXY_TIMEOUT_MS)
  let current = target

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const upstream = await fetchImpl(current, {
        method: "GET",
        redirect: "manual",
        headers: UPSTREAM_HEADERS,
        signal,
      })

      if (REDIRECT_STATUSES.has(upstream.status)) {
        const location = upstream.headers.get("location")
        await discard(upstream)
        let next: string | null = null
        if (location) {
          try {
            next = normalizeRemoteImageUrl(new URL(location, current).href)
          } catch {
            next = null
          }
        }
        if (!next) return failure(502, "redirect target not allowed")
        current = next
        continue
      }

      if (!upstream.ok) {
        await discard(upstream)
        return failure(502, `upstream responded ${upstream.status}`)
      }

      const declaredLength = Number(upstream.headers.get("content-length"))
      if (Number.isFinite(declaredLength) && declaredLength > IMAGE_PROXY_MAX_BYTES) {
        await discard(upstream)
        return failure(413, "image exceeds size limit")
      }

      let contentType = (upstream.headers.get("content-type") || "").split(";")[0].trim().toLowerCase()
      let body: ReadableStream<Uint8Array> | null = upstream.body

      if (!contentType.startsWith("image/")) {
        // Some hosts serve images as application/octet-stream or with no type
        // at all. Sniff the first bytes; anything unrecognisable is refused so
        // the proxy never relays HTML or scripts under our origin.
        if (!body) return failure(415, "upstream is not an image")
        const reader = body.getReader()
        const first = await reader.read()
        const head = first.value ?? new Uint8Array()
        const sniffed = detectImageType(head)
        if (!sniffed) {
          await reader.cancel()
          return failure(415, "upstream is not an image")
        }
        contentType = sniffed
        const rest = new ReadableStream<Uint8Array>({
          start(controller) {
            if (head.byteLength > 0) controller.enqueue(head)
          },
          async pull(controller) {
            const chunk = await reader.read()
            if (chunk.done) controller.close()
            else controller.enqueue(chunk.value)
          },
          cancel() {
            return reader.cancel()
          },
        })
        body = rest
      }

      const headers = new Headers({
        "Content-Type": contentType,
        "Content-Disposition": "inline",
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
        // If someone opens the proxy URL directly, an SVG must not run scripts
        // on our origin.
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cross-Origin-Resource-Policy": "same-origin",
      })
      return new Response(body ? limitBytes(body, IMAGE_PROXY_MAX_BYTES) : null, { status: 200, headers })
    }
    return failure(502, "too many redirects")
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? "upstream timed out" : "upstream fetch failed"
    return failure(502, reason)
  }
}
