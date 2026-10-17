// Bundles the MCP Apps UI (ui/) into one self-contained HTML file that src/ui.ts serves as ui:// resources.
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
const app = await build({ entryPoints: ['ui/app.ts'], outfile: 'app.js', bundle: true, write: false, platform: 'browser', target: 'es2022', format: 'iife', minify: true });
const css = await readFile('ui/app.css', 'utf8');
const template = await readFile('ui/app.html', 'utf8');
// A replacement string interprets $&, $` and $' inside bundled SDK code.
// Return the bundle from a callback so its JavaScript stays byte-for-byte intact.
await writeFile('dist/ui.html', template.replace('/* MAILLY_CSS */', () => (app.outputFiles.find((f) => f.path.endsWith('.css'))?.text ?? '') + css).replace('/* MAILLY_SCRIPT */', () => app.outputFiles.find((f) => f.path.endsWith('.js')).text.replace(/<\/script/gi, '<\\/script')));
