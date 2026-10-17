import DOMPurify from 'dompurify';

// Email is untrusted. Preserve document structure, but never import its scripts,
// forms, styles, IDs, remote images or navigation behavior into the app shell.
export function renderEmailBody(html: string | null | undefined, text: string, openLink: (url: string) => Promise<void>) {
  const body = document.createElement('div');
  body.className = html ? 'body rich-body' : 'body plain-body';
  if (!html) {
    body.textContent = text || 'This email has no displayable content.';
    return body;
  }
  const content = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['p', 'br', 'div', 'span', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'blockquote', 'pre', 'code', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'a', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'img', 'sup', 'sub'],
    ALLOWED_ATTR: ['href', 'title', 'alt', 'colspan', 'rowspan'],
    ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false, RETURN_DOM_FRAGMENT: true,
  });
  for (const image of Array.from(content.querySelectorAll('img'))) {
    const label = document.createElement('span');
    label.className = 'image-placeholder';
    label.textContent = image.getAttribute('alt') ? `[Image: ${image.getAttribute('alt')}]` : '[Image not loaded]';
    image.replaceWith(label);
  }
  for (const anchor of Array.from(content.querySelectorAll('a'))) {
    const href = anchor.getAttribute('href') ?? '';
    anchor.removeAttribute('href');
    if (!/^https?:\/\//i.test(href) && !/^mailto:/i.test(href)) continue;
    // Keep native link semantics, but let the MCP host handle every navigation.
    anchor.href = href;
    anchor.addEventListener('click', (event) => { event.preventDefault(); void openLink(href); });
    anchor.addEventListener('auxclick', (event) => event.preventDefault());
  }
  body.append(content);
  return body;
}
