import { readdir, readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../', import.meta.url));
async function files(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await files(target)); else result.push(target);
  }
  return result;
}
let js = 0, json = 0;
for (const file of await files(root)) {
  if (/\.(?:mjs|js)$/.test(file)) {
    const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (check.status !== 0) throw new Error(check.stderr || `Syntax check failed: ${file}`);
    js++;
  }
  if (file.endsWith('.json')) { JSON.parse(await readFile(file, 'utf8')); json++; }
}
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
const html = await readFile(path.join(root, 'popup.html'), 'utf8');
const resources = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1]);
assert.ok(!/\son\w+\s*=/i.test(html), 'No inline event handlers');
for (const resource of [manifest.background.service_worker, manifest.action.default_popup,
  ...manifest.content_scripts.flatMap(c => c.js), ...resources]) {
  assert.ok(!resource.includes('://') && !resource.includes('..'), 'Packaged resources only');
  await access(path.join(root, resource));
}
console.log(`PASS: ${js} JavaScript syntax checks; ${json} JSON parses; manifest/popup local resource checks.`);
