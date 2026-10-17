// Keep in step with BRAND_VERSION in Mailly's web app: the query string busts icon caches.
const BRAND_VERSION = '20261009';
const WEB_BASE = 'https://mailly.site';
const asset = (path: string) => `${WEB_BASE}${path}?v=${BRAND_VERSION}`;

/** serverInfo icons and website: MCP clients show these on the connector and consent screens. */
export const MCP_SERVER_BRANDING = {
  websiteUrl: WEB_BASE,
  icons: [
    { src: asset('/favicon.svg'), mimeType: 'image/svg+xml', sizes: ['any'] },
    { src: asset('/icon-512.png'), mimeType: 'image/png', sizes: ['512x512'] },
    { src: asset('/icon-192.png'), mimeType: 'image/png', sizes: ['192x192'] },
  ],
};
