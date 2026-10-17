// Single-file Worker bundle for tests and for embedding in other Miniflare setups; `wrangler deploy` bundles on its own.
import { build } from 'esbuild';
await build({
  entryPoints: ['src/worker.ts'], outfile: 'dist/worker.js', bundle: true, format: 'esm', platform: 'neutral', target: 'es2022',
  mainFields: ['module', 'main'], conditions: ['workerd', 'worker', 'browser', 'import'], loader: { '.html': 'text' },
  external: ['cloudflare:*', 'node:*'], logLevel: 'warning',
});
