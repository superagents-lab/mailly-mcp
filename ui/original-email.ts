import DOMPurify from 'dompurify';

// Preserve mail layout inside a shadow tree. Only presentation CSS is allowed:
// no scripts, forms, frames, imports, CSS URLs, host selectors or positioned UI.
const properties = /^(color|background-color|background|font(-family|-size|-weight|-style|-variant)?|line-height|letter-spacing|text-(align|decoration|transform|indent)|white-space|word-(break|spacing)|overflow-wrap|display|visibility|width|min-width|max-width|height|min-height|max-height|margin(-top|-right|-bottom|-left)?|padding(-top|-right|-bottom|-left)?|border(-[a-z-]+)?|border-collapse|border-spacing|table-layout|vertical-align|list-style(-type|-position)?|float|clear|box-sizing)$/;
function safeDeclarations(style: CSSStyleDeclaration) {
  const output: string[] = [];
  for (const name of Array.from(style)) {
    const value = style.getPropertyValue(name);
    if (properties.test(name) && !/url\s*\(|expression\s*\(|var\s*\(|[\\@]/i.test(value)) output.push(`${name}:${value}`);
  }
  return output.join(';');
}
function safeStyles(css: string) {
  const sheet = new CSSStyleSheet();
  // Constructed stylesheets never fetch @import rules. Only ordinary style rules
  // survive the next pass; all imports, font faces and other at-rules are dropped.
  sheet.replaceSync(css.replace(/@import[^;]*(?:;|$)/gi, ''));
  const rules = (list: CSSRuleList): string => Array.from(list).flatMap((rule): string[] => {
    if (rule instanceof CSSMediaRule) return [`@media ${rule.conditionText}{${rules(rule.cssRules)}}`];
    if (!(rule instanceof CSSStyleRule) || /:host|::slotted|\\/i.test(rule.selectorText)) return [];
    const declarations = safeDeclarations(rule.style);
    const selector = rule.selectorText.replace(/\b(?:html|body)\b|:root/g, '.email-document');
    return declarations ? [`${selector}{${declarations}}`] : [];
  }).join('\n');
  return rules(sheet.cssRules);
}
export function originalEmail(html: string, openLink: (url: string) => Promise<void>, loadInline?: (cid: string) => Promise<string>, loadRemote?: (url: string) => Promise<string>) {
  const container = document.createElement('div');
  container.className = 'original-email';
  const shadow = container.attachShadow({ mode: 'open' });
  const fragment = DOMPurify.sanitize(html, {
    WHOLE_DOCUMENT: true, RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: ['html', 'head', 'body', 'style', 'p', 'br', 'div', 'span', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'blockquote', 'pre', 'code', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'a', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'img', 'sup', 'sub', 'center'],
    ALLOWED_ATTR: ['style', 'class', 'id', 'href', 'src', 'alt', 'title', 'width', 'height', 'align', 'valign', 'bgcolor', 'cellpadding', 'cellspacing', 'border', 'colspan', 'rowspan'],
    ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
  });
  const styles = document.createElement('style');
  styles.textContent = ':host{display:block;contain:layout paint;max-width:100%;background:white;color:#202020} .email-document{display:flow-root;font:14px/1.6 Arial,sans-serif;overflow-wrap:anywhere} .email-document>:first-child{margin-top:0} .email-document>:last-child{margin-bottom:0} img,table{max-width:100%} img{height:auto} pre{white-space:pre-wrap} a{overflow-wrap:anywhere}';
  for (const style of Array.from(fragment.querySelectorAll('style'))) {
    try { styles.textContent += safeStyles(style.textContent ?? ''); } catch { /* Malformed mail CSS is optional. */ }
    style.remove();
  }
  for (const node of Array.from(fragment.querySelectorAll<HTMLElement>('[style]'))) {
    const declarations = safeDeclarations(node.style);
    node.removeAttribute('style');
    if (declarations) node.setAttribute('style', declarations);
  }
  const wrapper = document.createElement('div'); wrapper.className = 'original-wrapper';
  const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'btn btn-ghost cursor-interaction load-images';
  const failed = new Set<() => void>();
  const updateStatus = () => { retry.hidden = !failed.size; retry.textContent = `${failed.size} images failed to load. Retry`; };
  retry.onclick = () => { for (const load of [...failed]) load(); };
  updateStatus(); wrapper.append(retry);
  for (const image of Array.from(fragment.querySelectorAll('img'))) {
    const src = image.getAttribute('src') ?? '';
    image.removeAttribute('src');
    image.referrerPolicy = 'no-referrer'; image.decoding = 'async';
    const load = () => {
      failed.delete(load); updateStatus();
      const fail = () => { failed.add(load); updateStatus(); };
      image.onerror = fail;
      image.onload = () => { failed.delete(load); updateStatus(); };
      if (/^data:image\/(?:png|jpeg|gif|webp|avif|bmp);base64,[a-z\d+/=\s]+$/i.test(src)) image.src = src;
      else if (/^(?:https?:)?\/\//i.test(src)) {
        const url = src.startsWith('//') ? `https:${src}` : src;
        if (loadRemote) void loadRemote(url).then(data => {
          if (!/^data:image\/(?:png|jpeg|gif|webp|avif|bmp);base64,[a-z\d+/=\s]+$/i.test(data)) throw new Error('Invalid image data');
          image.src = data;
        }).catch(error => { image.title = (error as Error).message; fail(); });
        else image.src = url;
      }
      else if (/^cid:/i.test(src) && loadInline) {
        void loadInline(src.slice(4)).then(url => {
          if (!/^data:image\/(?:png|jpeg|gif|webp|avif|bmp);base64,[a-z\d+/=\s]+$/i.test(url)) throw new Error('Invalid image data');
          image.src = url;
        }).catch(fail);
      } else { image.alt = image.alt || 'Image unavailable'; fail(); }
    };
    load();
  }
  for (const anchor of Array.from(fragment.querySelectorAll('a'))) {
    const href = anchor.getAttribute('href') ?? '';
    anchor.removeAttribute('href');
    if (!/^https?:\/\//i.test(href) && !/^mailto:/i.test(href)) continue;
    anchor.href = href;
    anchor.addEventListener('click', event => { event.preventDefault(); void openLink(href); });
    anchor.addEventListener('auxclick', event => event.preventDefault());
  }
  const content = document.createElement('div'); content.className = 'email-document';
  const sourceBody = fragment.querySelector('body');
  if (sourceBody) {
    // Body-level presentation often sets the email's brand background and font.
    content.style.cssText = sourceBody.getAttribute('style') ?? '';
    content.className += ` ${sourceBody.className}`;
    if (sourceBody.id) content.id = sourceBody.id;
    content.append(...Array.from(sourceBody.childNodes));
  } else content.append(fragment);
  shadow.append(styles, content);
  wrapper.append(container);
  return wrapper;
}
