#!/usr/bin/env node
/**
 * gen-importmap.mjs <version> — stamp the release version into index.html.
 *
 * Rewrites index.html's importmap so EVERY local ES module resolves to
 * "<path>?v=<version>", and bumps the ?v= on the style.css / main.js entry
 * tags. This makes each release fully self-cache-busting: browsers and CDN
 * edges (Cloudflare's forced 4 h browser TTL included) treat every file as a
 * brand-new URL, so a deployed version can never be mixed with a cached one.
 *
 * Run from the repo root on every release:  node scripts/gen-importmap.mjs 0.21
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

const ver = process.argv[2];
if (!ver) { console.error('usage: node scripts/gen-importmap.mjs <version>'); process.exit(1); }

const imports = {
  three: 'https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js',
  'three/addons/': 'https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/',
};
for (const dir of ['simulation', 'control', 'optimization']) {
  for (const f of readdirSync(dir).filter(n => n.endsWith('.js')).sort()) {
    imports[`./${dir}/${f}`] = `./${dir}/${f}?v=${ver}`;
  }
}

const html = readFileSync('index.html', 'utf8');
const map = JSON.stringify({ imports }, null, 4).replace(/^/gm, '  ').trimStart();
const out = html
  .replace(/<script type="importmap">[\s\S]*?<\/script>/,
           `<script type="importmap">\n  ${map}\n  </script>`)
  .replace(/simulation\/style\.css\?v=[^"]+/, `simulation/style.css?v=${ver}`)
  .replace(/simulation\/main\.js\?v=[^"]+/, `simulation/main.js?v=${ver}`);
writeFileSync('index.html', out);
console.log(`index.html stamped: ${Object.keys(imports).length - 2} modules @ v=${ver}`);
