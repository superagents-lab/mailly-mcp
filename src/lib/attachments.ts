import * as z from 'zod';
import { normalizeRemoteImageUrl } from './inbox-image-proxy';

// Outbound attachments for MCP sends. A remote MCP server cannot read the user's files, and a model
// cannot realistically emit megabytes of base64, so each attachment is either a public URL this
// Worker downloads (with the same host checks as the inbox image proxy, re-applied on every redirect)
// or a small base64 payload. Both become the REST API's { filename, mimeType, contentBase64, contentId }.

// Mirrors the API: at most 10 attachments, 6 MB in total after decoding.
export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_TOTAL_BYTES = 6 * 1024 * 1024;
const MAX_INLINE_BASE64 = Math.ceil(MAX_ATTACHMENT_TOTAL_BYTES / 3) * 4;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const noBreaks = (s: string) => !/[\r\n]/.test(s);

export const attachmentSchema = z.object({
  url: z.string().max(8192).optional().describe('Public http(s) URL of the file; Mailly downloads it when sending'),
  content_base64: z.string().min(1).max(MAX_INLINE_BASE64).optional().describe('File bytes as base64, for small generated files only'),
  filename: z.string().min(1).max(255).refine(noBreaks, 'No line breaks').optional().describe('Defaults to the name from the URL or the server'),
  mime_type: z.string().regex(/^[\w.+-]+\/[\w.+-]+$/).optional().describe('Defaults to the type the URL serves, else application/octet-stream'),
  content_id: z.string().min(1).max(200).regex(/^[^\s<>]+$/).optional()
    .describe('Makes this an inline image: reference it in html as <img src="cid:CONTENT_ID">'),
}).refine(v => Boolean(v.url) !== Boolean(v.content_base64), 'Give exactly one of url or content_base64');

export const attachmentsSchema = z.array(attachmentSchema).min(1).max(MAX_ATTACHMENTS)
  .describe('Up to 10 files, 6 MB in total. Direct sends to a single recipient, replies and forwards only; campaigns accept inline images (content_id) only.');

export type AttachmentInput = z.infer<typeof attachmentSchema>;
export interface ApiAttachment { filename: string; mimeType: string; contentBase64: string; contentId?: string }

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(binary);
}

function base64Bytes(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return Math.floor(value.length / 4) * 3 - padding;
}

function filenameFrom(response: Response, url: string): string | undefined {
  const disposition = response.headers.get('content-disposition') ?? '';
  const encoded = disposition.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/)?.[1];
  if (encoded) {
    try { return decodeURIComponent(encoded.trim().replace(/^"|"$/g, '')); } catch { /* fall through */ }
  }
  const plain = disposition.match(/filename\s*=\s*"?([^";]+)"?/)?.[1]?.trim();
  if (plain) return plain;
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : undefined;
  } catch { return undefined; }
}

async function download(raw: string, budget: number, fetchImpl: FetchLike, label: string) {
  let current = normalizeRemoteImageUrl(raw);
  if (!current) throw new Error(`${label}: url must be a public http(s) address`);
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const response = await fetchImpl(current, {
        method: 'GET', redirect: 'manual', signal,
        headers: { Accept: '*/*', 'User-Agent': 'Mailly-Attachment-Fetcher/1.0 (+https://mailly.site)' },
      });
      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        let next: string | null = null;
        try { next = location ? normalizeRemoteImageUrl(new URL(location, current).href) : null; } catch { next = null; }
        if (!next) throw new Error(`${label}: the url redirects to an address that is not allowed`);
        current = next;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`${label}: downloading the url failed (HTTP ${response.status})`);
      }
      const tooLarge = () => new Error(`${label}: attachments exceed the 6MB total size limit`);
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > budget) { await response.body?.cancel(); throw tooLarge(); }
      const parts: Uint8Array[] = [];
      let size = 0;
      const reader = response.body?.getReader();
      if (reader) {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > budget) throw tooLarge();
            parts.push(value);
          }
        } finally { await reader.cancel().catch(() => {}); }
      }
      if (size === 0) throw new Error(`${label}: the url returned an empty file`);
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
      const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      return { bytes, mimeType: /^[\w.+-]+\/[\w.+-]+$/.test(type) ? type : undefined, filename: filenameFrom(response, current) };
    }
    throw new Error(`${label}: the url redirects too many times`);
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new Error(`${label}: downloading the url timed out`);
    }
    if (error instanceof Error && error.message.startsWith(label)) throw error;
    throw new Error(`${label}: downloading the url failed`);
  }
}

/** Turns tool attachment inputs into the REST API shape, downloading url entries within the shared size budget. */
export async function resolveAttachments(inputs: AttachmentInput[] | undefined, fetchImpl: FetchLike = fetch): Promise<ApiAttachment[] | undefined> {
  if (!inputs?.length) return undefined;
  let used = 0;
  const resolved: ApiAttachment[] = [];
  for (const [index, input] of inputs.entries()) {
    const label = `attachments[${index}]`;
    let contentBase64: string;
    let filename = input.filename;
    let mimeType = input.mime_type;
    if (input.url) {
      const file = await download(input.url, MAX_ATTACHMENT_TOTAL_BYTES - used, fetchImpl, label);
      used += file.bytes.byteLength;
      contentBase64 = bytesToBase64(file.bytes);
      filename ??= file.filename;
      mimeType ??= file.mimeType;
    } else {
      contentBase64 = input.content_base64!.replace(/\s+/g, '');
      used += base64Bytes(contentBase64);
      if (used > MAX_ATTACHMENT_TOTAL_BYTES) throw new Error(`${label}: attachments exceed the 6MB total size limit`);
    }
    resolved.push({
      filename: (filename ?? 'attachment').replace(/[\r\n]/g, ' ').slice(0, 255),
      mimeType: mimeType ?? 'application/octet-stream',
      contentBase64,
      ...(input.content_id ? { contentId: input.content_id } : {}),
    });
  }
  return resolved;
}
