import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createGitHubAdapter, gitBlobSHA, solutionPath, validateGitHubConfig } from '../github.js';
const config = { owner: 'octocat', repo: 'solutions', branch: 'main', token: 'github_pat_' + 'x'.repeat(30) };
const record = { submissionId: '123', problemSlug: 'two-sum', title: 'Two Sum', language: 'JavaScript', timestamp: Math.floor(Date.now()/1000), sourceCode: 'return [0, 1]; // café\n', verdict: 'Accepted', statusCode: 10 };
const H = n => n.repeat(40);
const reply = (status, data, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: new Headers(headers), json: async () => data });
function fixture(options = {}) {
  let head = H('a'); let exists = !!options.existing; let patched = false;
  const calls = []; let networkFailures = options.networkFailures || 0;
  const fetchFn = async (url, init) => {
    const path = url.replace('https://api.github.com/repos/octocat/solutions', '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, method: init.method, body, headers: init.headers });
    if (networkFailures-- > 0) throw new Error('transport leaked secret: ' + config.token);
    if (options.intercept) { const result = await options.intercept(path, init, body); if (result) return result; }
    if (path === '') return reply(200, { permissions: { push: !options.noPush }, archived: false });
    if (path === '/branches?per_page=1') return reply(200, options.empty ? [] : [{ name: 'main' }]);
    if (path === '/git/ref/heads/main') {
      if (options.missingBranch) return reply(404, {});
      if (options.advance && calls.some(c => c.path === '/git/commits' && c.method === 'POST')) head = H('8');
      return reply(200, { ref: 'refs/heads/main', object: { type: 'commit', sha: head } });
    }
    if (path === '/git/blobs') {
      if (options.readOnly) return reply(403, { message: 'Resource not accessible by personal access token' });
      return reply(201, { sha: await gitBlobSHA(body.content) });
    }
    if (path.startsWith('/git/commits/') && init.method === 'GET') return reply(200, { tree: { sha: patched ? H('f') : H('b') } });
    if (path.startsWith('/git/trees/') && init.method === 'GET') {
      const treeSHA = path.split('/').at(-1);
      let tree = [];
      if ((exists || patched) && [H('b'), H('f')].includes(treeSHA)) tree = [{ path: 'solutions', type: 'tree', mode: '040000', sha: H('c') }];
      if (treeSHA === H('c')) tree = [{ path: 'two-sum', type: 'tree', mode: '040000', sha: H('d') }];
      if (treeSHA === H('d')) tree = [{ path: 'javascript', type: 'tree', mode: '040000', sha: H('e') }];
      if (treeSHA === H('e')) tree = [{ path: '123.js', type: 'blob', mode: options.symlink ? '120000' : '100644', sha: options.different ? H('7') : await gitBlobSHA(record.sourceCode) }];
      return reply(200, { tree, truncated: !!options.truncated });
    }
    if (path === '/git/trees') return reply(201, { sha: H('f') });
    if (path === '/git/commits') return reply(201, { sha: H('9') });
    if (path === '/git/refs/heads/main' && init.method === 'PATCH') {
      if (options.patchConflict) return reply(422, { message: 'not fast forward' });
      head = H('9'); exists = true; patched = true;
      if (options.lostPatchResponse) throw new Error('connection lost after update');
      return reply(200, { object: { sha: head } });
    }
    throw new Error('Unexpected mocked route');
  };
  const delays = [];
  return { calls, delays, adapter: createGitHubAdapter(config, { fetchFn, sleep: async ms => delays.push(ms) }) };
}
test('stable path and exact UTF-8 Git blob hash', async () => {
  assert.equal(solutionPath(record), 'solutions/two-sum/javascript/123.js');
  const content = Buffer.from(record.sourceCode);
  const expected = createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
  assert.equal(await gitBlobSHA(record.sourceCode), expected);
  assert.throws(() => solutionPath({ ...record, language: '../../evil' }));
  for (const branch of ['../main', 'a..b', 'a//b', 'a.lock', '/main', 'main/', '-main']) assert.throws(() => validateGitHubConfig({ ...config, branch }));
  assert.throws(() => validateGitHubConfig({ ...config, token: 'ghp_classic' }));
});
test('successful commit preserves base tree, uses one parent and never force-pushes', async () => {
  const f = fixture(); const result = await f.adapter.sync(record);
  assert.equal(result.state, 'committed');
  const tree = f.calls.find(c => c.path === '/git/trees').body;
  assert.equal(tree.base_tree, H('b')); assert.equal(tree.tree.length, 1);
  assert.equal(tree.tree[0].path, solutionPath(record));
  assert.deepEqual(f.calls.find(c => c.path === '/git/commits').body.parents, [H('a')]);
  assert.deepEqual(f.calls.find(c => c.method === 'PATCH').body, { sha: H('9'), force: false });
  assert.ok(f.calls.every(c => c.headers.Authorization === `Bearer ${config.token}`));
});
test('existing identical file skips tree/commit/ref writes', async () => {
  const f = fixture({ existing: true }); assert.equal((await f.adapter.sync(record)).state, 'duplicate');
  assert.equal(f.calls.some(c => c.method === 'PATCH' || c.path === '/git/commits'), false);
});
test('existing different content or symlink is never overwritten', async () => {
  for (const options of [{ different: true }, { symlink: true }]) {
    const f = fixture({ existing: true, ...options }); await assert.rejects(f.adapter.sync(record), { code: 'PATH_CONFLICT' });
    assert.equal(f.calls.some(c => c.method === 'PATCH'), false);
  }
});
test('user push permission is insufficient: read-only token fails actual write probe', async () => {
  const f = fixture({ readOnly: true }); await assert.rejects(f.adapter.verify(), { code: 'PERMISSION' });
  assert.equal(f.calls.some(c => c.method === 'PATCH'), false);
});
test('empty repositories and missing branches fail safely before writes', async () => {
  for (const [options, code] of [[{ empty: true }, 'EMPTY_REPOSITORY'], [{ missingBranch: true }, 'NOT_FOUND']]) {
    const f = fixture(options); await assert.rejects(f.adapter.sync(record), { code });
    assert.equal(f.calls.some(c => c.method !== 'GET'), false);
  }
});
test('concurrent advance is detected before ref update', async () => {
  const f = fixture({ advance: true }); await assert.rejects(f.adapter.sync(record), { code: 'CONFLICT' });
  assert.equal(f.calls.some(c => c.method === 'PATCH'), false);
});
test('fast-forward rejection is reconciled without force or automatic overwrite', async () => {
  const f = fixture({ patchConflict: true }); await assert.rejects(f.adapter.sync(record), { code: 'CONFLICT' });
  assert.equal(f.calls.filter(c => c.method === 'PATCH').length, 1);
});
test('lost successful PATCH response reconciles and replay is duplicate', async () => {
  const f = fixture({ lostPatchResponse: true }); assert.equal((await f.adapter.sync(record)).state, 'reconciled');
  assert.equal((await f.adapter.sync(record)).state, 'duplicate');
  assert.equal(f.calls.filter(c => c.method === 'PATCH').length, 1);
});
test('transient read failure retries with bounded backoff', async () => {
  const f = fixture({ networkFailures: 2 }); await f.adapter.verify(); assert.deepEqual(f.delays, [500, 1000]);
  const broken = fixture({ networkFailures: 9 });
  await assert.rejects(broken.adapter.verify(), error => error.code === 'NETWORK' && !error.message.includes(config.token));
  assert.equal(broken.calls.length, 3);
});
test('rate limits return retry time; authentication and permissions do not retry', async () => {
  for (const [status, headers, code] of [[401, {}, 'AUTH'], [403, {}, 'PERMISSION'], [429, { 'retry-after': '120' }, 'RATE_LIMIT'], [403, { 'x-ratelimit-remaining': '0' }, 'RATE_LIMIT']]) {
    const f = fixture({ intercept: () => reply(status, {}, headers) });
    await assert.rejects(f.adapter.verify(), error => error.code === code && (code !== 'RATE_LIMIT' || error.retryAt >= Date.now() + 59000));
    assert.equal(f.calls.length, 1);
  }
});
test('truncated Git trees stop sync rather than assume file absence', async () => {
  const f = fixture({ truncated: true }); await assert.rejects(f.adapter.sync(record), { code: 'SCHEMA' });
  assert.equal(f.calls.some(c => c.method === 'PATCH'), false);
});
test('partial tree creation failure never changes branch and replay succeeds', async () => {
  let fail = true;
  const f = fixture({ intercept: path => path === '/git/trees' && fail ? reply(503, {}) : null });
  await assert.rejects(f.adapter.sync(record), { code: 'NETWORK' });
  assert.equal(f.calls.some(c => c.method === 'PATCH'), false);
  fail = false; assert.equal((await f.adapter.sync(record)).state, 'committed');
});
