// Remote images inside inbox mail are loaded through a same-origin proxy, the
// way Gmail routes everything via googleusercontent.com. Two reasons:
//
// 1. Senders increasingly ship `Cross-Origin-Resource-Policy: same-origin` on
//    their image hosts (claude.ai does). The browser then refuses to embed the
//    image in any other origin's document — including our sandboxed iframe —
//    and there is nothing the client can do about it. A server-side fetch is
//    not subject to CORP.
// 2. The reader's IP address and user agent stay hidden from tracking pixels.
//
// This module is shared by the HTML rewriter (client) and the proxy route
// (server). It has no imports so tests can load it straight from Node.

export const INBOX_IMAGE_PROXY_PATH = "/api/inbox/images"

export function inboxImageProxyUrl(url: string) {
  return `${INBOX_IMAGE_PROXY_PATH}?url=${encodeURIComponent(url)}`
}

// Hostnames that can never be a public image host. Single-label names such as
// `intranet` are refused as well: a public mail image always has a dotted FQDN.
const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".in-addr.arpa", ".ip6.arpa"]

function isBlockedIPv4(host: string) {
  const parts = host.split(".").map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b] = parts
  return (
    a === 0 || // 0.0.0.0/8 "this network"
    a === 10 || // 10/8 private
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12 private
    (a === 192 && b === 168) || // 192.168/16 private
    (a === 100 && b >= 64 && b <= 127) || // 100.64/10 carrier NAT
    a >= 224 // multicast, reserved, broadcast
  )
}

function isBlockedIPv6(host: string) {
  const address = host.replace(/^\[|\]$/g, "").toLowerCase()
  if (address === "::" || address === "::1") return true
  // IPv4-mapped / compatible addresses inherit the IPv4 rules. The WHATWG
  // parser has already turned `::ffff:127.0.0.1` into `::ffff:7f00:1`.
  const dotted = address.match(/^(?:::ffff:|::)(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) return isBlockedIPv4(dotted[1])
  const hex = address.match(/^(?:::ffff:|::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (hex) {
    const hi = Number.parseInt(hex[1], 16)
    const lo = Number.parseInt(hex[2], 16)
    return isBlockedIPv4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`)
  }
  const head = Number.parseInt(address.split(":")[0] || "0", 16)
  return (
    (head & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (head & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (head & 0xff00) === 0xff00 // ff00::/8 multicast
  )
}

export function isBlockedImageHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/\.$/, "")
  if (!host) return true
  if (host.startsWith("[") || host.includes(":")) return isBlockedIPv6(host)
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return isBlockedIPv4(host)
  if (host === "localhost" || !host.includes(".")) return true
  return BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
}

// Returns the canonical absolute URL the proxy may fetch, or null for anything
// that must be left alone: relative paths (already same-origin), data:/cid:,
// non-HTTP schemes, credentials in the URL, or a host we refuse to reach.
// The WHATWG parser canonicalises hosts (`0x7f.1`, `2130706433`, trailing dots)
// before the blocklist sees them, so obfuscated loopback spellings are covered.
export function normalizeRemoteImageUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const candidate = trimmed.startsWith("//") ? `https:${trimmed}` : trimmed
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return null
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null
  if (url.username || url.password) return null
  if (isBlockedImageHost(url.hostname)) return null
  // A trailing dot is a valid FQDN spelling but would give the same image two
  // proxy URLs; canonicalise it away.
  url.hostname = url.hostname.replace(/\.$/, "")
  url.hash = ""
  return url.href
}

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
}

function decodeHtmlEntities(value: string) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1]?.toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return HTML_ENTITIES[entity.toLowerCase()] ?? match
  })
}

function escapeAttribute(value: string) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")
}

function proxied(rawUrl: string) {
  const target = normalizeRemoteImageUrl(decodeHtmlEntities(rawUrl))
  return target ? inboxImageProxyUrl(target) : null
}

function rewriteSrcset(value: string) {
  // Candidates are `url [descriptor]` separated by commas. A raw comma inside a
  // URL is not handled; that candidate simply stays as-is.
  return value.replace(/(^|,)(\s*)([^\s,]+)/g, (match, separator: string, space: string, url: string) => {
    const next = proxied(url)
    return next ? `${separator}${space}${next}` : match
  })
}

const CSS_URL_PATTERN = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s"']*))\s*\)/gi

function rewriteCssUrls(css: string) {
  return css.replace(CSS_URL_PATTERN, (match, dq?: string, sq?: string, bare?: string) => {
    const next = proxied(dq ?? sq ?? bare ?? "")
    return next ? `url("${next}")` : match
  })
}

const ATTRIBUTE_PATTERN = /(\s)([a-zA-Z-]+)(\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g
const SRC_TAGS = new Set(["img", "source", "input", "v:image", "v:fill"])

function rewriteTag(tag: string, tagName: string) {
  return tag.replace(ATTRIBUTE_PATTERN, (match, space: string, name: string, equals: string, dq?: string, sq?: string, bare?: string) => {
    const value = dq ?? sq ?? bare ?? ""
    const attribute = name.toLowerCase()
    let next: string | null = null
    if (attribute === "src" && SRC_TAGS.has(tagName)) next = proxied(value)
    else if (attribute === "srcset") next = rewriteSrcset(value)
    else if (attribute === "background") next = proxied(value)
    else if (attribute === "style") next = rewriteCssUrls(decodeHtmlEntities(value))
    if (next === null || next === value) return match
    return `${space}${name}${equals}"${escapeAttribute(next)}"`
  })
}

// Rewrites every remote image reference we know how to find — <img src>,
// srcset, legacy background="" attributes, and url() inside inline styles or
// <style> blocks — to go through the proxy. Same-origin, data:, and cid:
// references are untouched, so run this after the cid rewrite.
export function rewriteRemoteImageSources(html: string) {
  const withTags = html.replace(/<([a-zA-Z][\w:-]*)\b[^>]*>/g, (tag, name: string) => rewriteTag(tag, name.toLowerCase()))
  return withTags.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_match, open: string, css: string, close: string) => (
    `${open}${rewriteCssUrls(css)}${close}`
  ))
}
