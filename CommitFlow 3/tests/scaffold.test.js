import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { GitHubError } from '../github.js';
import { createGitHubService } from '../github-service.js';
import { isLeetCodeSender, saveAccepted } from '../submissions.js';
import { createConfigStore, DEFAULT_CONFIG, STORAGE_KEY, validateConfig } from '../config.js';

function memoryStorage(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async setAccessLevel() {},
    async get(key) { return { [key]: data[key] }; },
    async set(value) { Object.assign(data, structuredClone(value)); },
    async remove(key) { delete data[key]; }
  };
}

test('missing settings use defaults; save normalizes; reset preserves unrelated data', async () => {
  const storage = memoryStorage({ other: 42 });
  const store = createConfigStore(storage);
  assert.deepEqual(await store.read(), DEFAULT_CONFIG);
  assert.deepEqual(await store.save({ displayName: ' Arpit ', theme: 'dark' }), { displayName: 'Arpit', theme: 'dark' });
  assert.equal((await createConfigStore(storage).read()).theme, 'dark');
  assert.deepEqual(await store.reset(), DEFAULT_CONFIG);
  assert.deepEqual(storage.data, { other: 42 });
});

test('invalid configurations are rejected without writes', async () => {
  const storage = memoryStorage();
  for (const config of [null, [], {}, { displayName: 5, theme: 'dark' },
    { displayName: 'x'.repeat(61), theme: 'light' },
    { displayName: '', theme: 'invalid' },
    { displayName: '', theme: 'light', token: 'unexpected' }]) {
    assert.throws(() => validateConfig(config));
    await assert.rejects(createConfigStore(storage).save(config));
  }
  assert.deepEqual(storage.data, {});
});

test('corrupt stored configuration is reported and can be reset', async () => {
  const storage = memoryStorage({ [STORAGE_KEY]: { bad: true } });
  const store = createConfigStore(storage);
  await assert.rejects(store.read());
  assert.deepEqual(storage.data[STORAGE_KEY], { bad: true });
  await store.reset();
  assert.deepEqual(await store.read(), DEFAULT_CONFIG);
});

const source = await readFile(new URL('../background.js', import.meta.url), 'utf8');
function worker(storage = memoryStorage()) {
  const listeners = [];
  const runtime = {
    id: 'test-extension',
    getURL: path => `chrome-extension://test-extension/${path}`,
    getManifest: () => ({ version: '0.1.0' }),
    onMessage: { addListener: fn => listeners.push(fn) }
  };
  // Evaluate the actual worker body; inject only its statically imported dependency.
  vm.runInNewContext(source.replace(/^import .*;\n/gm, ''), {
    chrome: { runtime, storage: { local: storage, session: memoryStorage() } }, createConfigStore, isLeetCodeSender, saveAccepted, createGitHubService, GitHubError
  });
  assert.equal(listeners.length, 1, 'listener exists before any microtask runs');
  const sender = { id: runtime.id, url: runtime.getURL('popup.html') };
  return {
    listener: listeners[0], sender,
    send(type, config, from = sender) {
      return new Promise(resolve => listeners[0]({ namespace: 'commitflow', type, config }, from, resolve));
    }
  };
}

test('worker registers synchronously and keeps async response channel open', async () => {
  const w = worker();
  let response;
  assert.equal(w.listener({ namespace: 'commitflow', type: 'PING' }, w.sender, value => { response = value; }), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(response.ok, true);
  assert.equal(response.data.status, 'ready');
  assert.equal(w.listener({ namespace: 'other' }, w.sender, () => assert.fail()), false);
});

test('worker messages persist across worker restarts and reset', async () => {
  const storage = memoryStorage();
  const w = worker(storage);
  assert.equal((await w.send('CONFIG_SET', { displayName: 'Arpit', theme: 'light' })).ok, true);
  assert.equal((await worker(storage).send('CONFIG_GET')).data.displayName, 'Arpit');
  assert.equal((await w.send('CONFIG_RESET')).data.theme, 'system');
});

test('worker rejects untrusted senders, malformed payloads and unknown requests', async () => {
  const w = worker();
  for (const sender of [{}, { ...w.sender, id: 'other' }, { ...w.sender, tab: { id: 1 } }, { ...w.sender, url: 'https://example.com/' }]) {
    assert.equal((await w.send('CONFIG_GET', undefined, sender)).ok, false);
  }
  assert.equal((await w.send('CONFIG_SET', {})).ok, false);
  assert.equal((await w.send('UNKNOWN')).ok, false);
});

test('storage failures reach caller and do not poison the queue', async () => {
  const storage = memoryStorage();
  storage.set = async () => { throw new Error('Storage unavailable'); };
  const w = worker(storage);
  const failed = await w.send('CONFIG_SET', DEFAULT_CONFIG);
  assert.equal(failed.ok, false);
  assert.match(failed.error, /Storage unavailable/);
  assert.equal((await w.send('PING')).ok, true);
});

test('concurrent set and reset are processed in order', async () => {
  const storage = memoryStorage();
  const originalSet = storage.set;
  storage.set = async value => {
    await new Promise(resolve => setImmediate(resolve));
    await originalSet(value);
  };
  const w = worker(storage);
  await Promise.all([w.send('CONFIG_SET', { displayName: 'A', theme: 'dark' }), w.send('CONFIG_RESET')]);
  assert.equal((await w.send('CONFIG_GET')).data.theme, 'system');
});

test('manifest exposes only storage and packaged scripts', async () => {
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.content_scripts[0].matches, ['https://leetcode.com/*']);
  assert.deepEqual(manifest.content_scripts[0].js, ['leetcode.js', 'content.js']);
  assert.deepEqual(manifest.permissions, ['storage']);
  assert.deepEqual(manifest.host_permissions, ['https://api.github.com/*']);
  for (const key of [ 'externally_connectable', 'web_accessible_resources']) assert.equal(manifest[key], undefined);
  assert.deepEqual(manifest.background, { service_worker: 'background.js', type: 'module' });
  assert.match(manifest.content_security_policy.extension_pages, /script-src 'self'/);
});

test('actual worker routes Accepted events, deduplicates across restart and denies content configuration access', async () => {
  const storage = memoryStorage();
  const w = worker(storage);
  const from = { id: 'test-extension', url: 'https://leetcode.com/problems/two-sum/', tab: { id: 7 }, frameId: 0 };
  const record = { submissionId: '456', problemSlug: 'two-sum', title: 'Two Sum', language: 'Python3', timestamp: Math.floor(Date.now() / 1000), sourceCode: 'return [0, 1]', statusCode: 10, verdict: 'Accepted' };
  const send = (target, value = record) => new Promise(resolve => {
    assert.equal(target.listener({ namespace: 'commitflow', type: 'LEETCODE_ACCEPTED', record: value }, from, resolve), true);
  });
  assert.equal((await send(w)).data.duplicate, false);
  assert.equal((await send(worker(storage))).data.duplicate, true);
  assert.equal((await send(w, { ...record, statusCode: 11 })).ok, false);
  for (const type of ['GH_STATUS', 'GH_CONFIGURE', 'GH_SYNC', 'GH_DISCONNECT']) assert.equal((await w.send(type, undefined, from)).ok, false);
  assert.equal((await w.send('CONFIG_GET', undefined, from)).ok, false);
  assert.equal((await w.send('CONFIG_SET', DEFAULT_CONFIG, from)).ok, false);
});


test('storage isolation failure blocks credential operations and malformed messages receive errors', async () => {
  const storage = memoryStorage();
  storage.setAccessLevel = async () => { throw new Error('denied'); };
  const w = worker(storage);
  const response = await w.send('GH_CONFIGURE', { token: 'must-not-be-stored' });
  assert.equal(response.ok, false);
  assert.deepEqual(storage.data, {});
  let invalid;
  assert.equal(w.listener({ namespace: 'commitflow' }, w.sender, r => { invalid = r; }), false);
  assert.equal(invalid.ok, false);
});
