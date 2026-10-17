// Small, consistent outline icons; the button retains an accessible name and tooltip.
const paths: Record<string, string> = {
  'Mark as read': 'm3 8 9-5 9 5v11H3V8Zm0 0 9 6 9-6',
  Reply: 'm9 5-6 6 6 6M3 11h10a8 8 0 0 1 8 8',
  'Attach to chat': 'm8 13 7-7a3 3 0 0 1 4 4l-9 9a5 5 0 0 1-7-7l9-9',
  'Ask assistant': 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z',
  Refresh: 'M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 2M18 18A8 8 0 0 1 5 16',
  Search: 'M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0Zm-2 4 7 7',
  Menu: 'M4 6h16M4 12h16M4 18h16',
  'Back to inbox': 'm12 5-7 7 7 7M5 12h15',
  'Back to list': 'm12 5-7 7 7 7M5 12h15',
  'Back to compose': 'm12 5-7 7 7 7M5 12h15',
  'Move to inbox': 'M4 13 6 4h12l2 9v7H4v-7Zm0 0h5l1 3h4l1-3h5',
  'Expand email': 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5',
  'Back to chat card': 'M3 8h5V3m8 0v5h5M8 21v-5H3m18 0h-5v5',
  Bold: 'M6 3h7a4.5 4.5 0 0 1 0 9H6V3Zm0 9h8a4.5 4.5 0 0 1 0 9H6v-9Z',
  Italic: 'M10 3h10M4 21h10M15 3 9 21',
  'Bulleted list': 'M9 6h12M9 12h12M9 18h12M3 6h.01M3 12h.01M3 18h.01',
};
export function iconify(button: HTMLButtonElement, label: string) {
  const path = paths[label];
  if (!path) return button;
  button.setAttribute('aria-label', label);
  button.title = label;
  button.classList.add('icon-button');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [name, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(name, value);
  const shape = document.createElementNS(svg.namespaceURI, 'path');
  shape.setAttribute('d', path); svg.append(shape); button.replaceChildren(svg);
  return button;
}
