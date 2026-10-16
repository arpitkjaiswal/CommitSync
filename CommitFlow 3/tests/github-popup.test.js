import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../github-popup.js', import.meta.url), 'utf8');
const flush = () => new Promise(r => setImmediate(r));
test('unsaved repository edits cannot trigger a sync to the previously saved target', async () => {
  const elements = new Map(); const calls = [];
  function el(id) {
    if (!elements.has(id)) elements.set(id, { value: '', dataset: {}, handlers: {}, addEventListener(type, fn) { this.handlers[type] = fn; } });
    return elements.get(id);
  }
  vm.runInNewContext(source, { document: { querySelector: el }, chrome: { runtime: { async sendMessage(message) {
    calls.push(message); return { ok: true, data: { owner: 'owner', repo: 'old', branch: 'main', tokenConfigured: true, state: 'idle' } };
  } } } });
  await flush(); el('#github-repo').value = 'new'; el('#github-sync').handlers.click(); await flush();
  assert.equal(calls.some(c => c.type === 'GH_SYNC'), false);
  assert.match(el('#github-status').textContent, /verify/i);
});
