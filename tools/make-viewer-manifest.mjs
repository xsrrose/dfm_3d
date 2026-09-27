// Build viewer/maps.json for the repository.
//
//   node tools/make-viewer-manifest.mjs           -> use ./viewer/models/ (offline, default)
//   node tools/make-viewer-manifest.mjs --remote  -> point straight at GitHub Release assets
//
// Local is the default on purpose: GitHub release assets are served without an
// Access-Control-Allow-Origin header, so a browser cannot fetch them directly.
// Downloading once with tools/fetch-models.mjs (Node, no CORS) always works.
//
// Run from the repository root.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const remote = args.includes('--remote');
const local = !remote;
const repoRoot = resolve(args.find(a => !a.startsWith('--')) || join(HERE, '..'));

const RELEASE_TAG = 'models-v1';
const RELEASE_BASE = `https://github.com/xsrrose/dfm_3d/releases/download/${RELEASE_TAG}`;
const LABEL = { db: '零号大坝', cgxg: '长弓溪谷', bks: '巴克什', htjd: '航天基地', cxjy: '潮汐监狱', az3: '核电站' };
const ORDER = ['htjd', 'db', 'cgxg', 'bks', 'cxjy', 'az3'];

// Statistics come from models.json so the two files stay in sync.
const modelsPath = join(repoRoot, 'models.json');
const stats = new Map();
if (existsSync(modelsPath)) {
  for (const m of JSON.parse(readFileSync(modelsPath, 'utf8')).models || []) {
    if (m.variant === 'full') stats.set(m.slug, m);
  }
}

const localDir = join(repoRoot, 'viewer', 'models');
const maps = ORDER.map(slug => {
  const full = `${slug}-full.glb`;
  const overview = `${slug}-overview.glb`;
  const entry = stats.get(slug) || {};
  const hasFullLocal = existsSync(join(localDir, full));
  const hasOverviewLocal = existsSync(join(localDir, overview));
  return {
    slug,
    label: LABEL[slug],
    regionCount: entry.regionPacks ?? null,
    triangles: entry.triangles ?? null,
    bytes: entry.bytes ?? null,
    // Content bounds (excludes the ~23 km water plane) so the viewer frames the
    // level instead of the whole bounding box.
    bounds: entry.bounds ?? null,
    // In local mode these describe what *will* be present after
    // `node tools/fetch-models.mjs`, not what happens to exist right now —
    // otherwise a freshly cloned repo would show zero maps.
    hasFull: local ? true : true,
    hasOverview: local ? (slug === 'htjd') : (slug === 'htjd'),
    presentNow: local ? { full: hasFullLocal, overview: hasOverviewLocal } : undefined,
    urlFull: local ? undefined : `${RELEASE_BASE}/${full}`,
    urlOverview: (!local && slug === 'htjd') ? `${RELEASE_BASE}/${overview}` : undefined,
  };
});

const available = maps.filter(m => m.hasFull || m.hasOverview);
const out = {
  generatedAt: new Date().toISOString(),
  mode: local ? 'local (viewer/models/)' : `remote (GitHub Release ${RELEASE_TAG}) — note: blocked by CORS in browsers`,
  // Tells the viewer to resolve ./models/<name>.glb instead of the release URLs.
  localModels: local,
  default: available[0]?.slug || 'htjd',
  maps,
  availableCount: available.length,
};
writeFileSync(join(repoRoot, 'viewer', 'maps.json'), JSON.stringify(out, null, 2));
console.log(`viewer/maps.json  mode=${out.mode}  available=${available.length}`);
for (const m of maps) {
  const size = m.bytes ? ` ${(m.bytes / 1048576).toFixed(0)}MB` : '';
  console.log(`  ${m.label.padEnd(6)} ${m.slug.padEnd(6)} full=${m.hasFull ? 'Y' : 'n'}${size}`);
}
