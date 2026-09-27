// Download every model from the GitHub Release into viewer/models/ and switch
// maps.json to offline mode. Re-runnable: existing complete files are skipped
// and verified by byte size against models.json.
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, renameSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(dirname(HERE));
const RELEASE_TAG = 'models-v1';
const RELEASE_BASE = `https://github.com/xsrrose/dfm_3d/releases/download/${RELEASE_TAG}`;
const dest = join(repoRoot, 'viewer', 'models');
mkdirSync(dest, { recursive: true });

const models = JSON.parse(readFileSync(join(repoRoot, 'models.json'), 'utf8')).models || [];
console.log(`共 ${models.length} 个模型 -> viewer/models/`);

let got = 0, skipped = 0, failed = 0;
for (const m of models) {
  const name = m.file.split('/').pop();
  const file = join(dest, name);
  if (existsSync(file) && statSync(file).size === m.bytes) {
    skipped++;
    console.log(`  跳过 ${name} (已存在 ${(m.bytes / 1048576).toFixed(1)} MB)`);
    continue;
  }
  const url = `${RELEASE_BASE}/${name}`;
  process.stdout.write(`  下载 ${name} (${(m.bytes / 1048576).toFixed(1)} MB) … `);
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length !== m.bytes) throw new Error(`长度 ${buf.length} != ${m.bytes}`);
    const tmp = file + '.part';
    writeFileSync(tmp, buf);
    renameSync(tmp, file);
    got++;
    console.log('完成');
  } catch (error) {
    failed++;
    console.log(`失败: ${error.message}`);
  }
}

console.log(`\n完成 ${got}，跳过 ${skipped}，失败 ${failed}`);
if (failed === 0) {
  const { spawnSync } = await import('node:child_process');
  spawnSync(process.execPath, [join(HERE, 'make-viewer-manifest.mjs'), repoRoot], { stdio: 'inherit' });
  console.log('\n已切换为本地模式，启动：python tools/serve-viewer.py 8899');
}
