import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubService, GH_CONFIG, GH_TOKEN, GH_STATE } from '../github-service.js';
import { GitHubError } from '../github.js';
import { SUBMISSIONS_KEY } from '../submissions.js';
const config = { owner: 'owner', repo: 'repo', branch: 'main', token: 'github_pat_' + 's'.repeat(30) };
const record = { submissionId: '1' };
function memory(initial = {}) {
  const data = structuredClone(initial);
  return { data, get: async key => ({ [key]: data[key] }), set: async value => Object.assign(data, structuredClone(value)), remove: async key => { delete data[key]; } };
}
function setup(adapter = { verify: async () => {}, sync: async () => ({ state: 'committed', path: 'solutions/a/javascript/1.js', commit: 'a'.repeat(40) }) }) {
  const local = memory({ [SUBMISSIONS_KEY]: { records: [record] } }); const session = memory();
  const args = { local, session, adapterFactory: () => adapter };
  return { local, session, service: createGitHubService(args), restart: () => createGitHubService(args) };
}
test('verified token lives only in session storage and is never returned by status', async () => {
  const f = setup(); const result = await f.service.configure(config);
  assert.equal(f.session.data[GH_TOKEN].token, config.token);
  assert.equal(JSON.stringify(f.local.data).includes(config.token), false);
  assert.equal(JSON.stringify(result).includes(config.token), false);
  assert.equal(result.tokenConfigured, true);
  assert.equal((await f.restart().status()).tokenConfigured, true);
  await f.service.disconnect(); assert.equal(f.session.data[GH_TOKEN], undefined);
  assert.equal(f.local.data[GH_CONFIG], undefined);
});
test('failed verification does not save credentials or repository', async () => {
  const f = setup({ verify: async () => { throw new GitHubError('PERMISSION', 'denied'); } });
  await assert.rejects(f.service.configure(config));
  assert.equal(f.local.data[GH_CONFIG], undefined); assert.equal(f.session.data[GH_TOKEN], undefined);
});
test('completion ledger survives worker restart and scopes deduplication to repository and branch', async () => {
  let calls = 0;
  const f = setup({ verify: async () => {}, sync: async () => { calls++; return { state: 'committed', path: 'path', commit: 'a'.repeat(40) }; } });
  await f.service.configure(config); await f.service.syncNext();
  assert.equal((await f.restart().syncNext()).state, 'idle');
  await f.service.configure({ ...config, branch: 'other' }); await f.service.syncNext();
  assert.equal(calls, 2);
});
test('rate-limit cooldown persists across restart and blocks premature retry/verification', async () => {
  let calls = 0;
  const f = setup({ verify: async () => {}, sync: async () => { calls++; throw new GitHubError('RATE_LIMIT', 'wait', Date.now() + 60000); } });
  await f.service.configure(config); await assert.rejects(f.service.syncNext(), { code: 'RATE_LIMIT' });
  await assert.rejects(f.restart().syncNext(), { code: 'RATE_LIMIT' });
  await assert.rejects(f.restart().configure(config), { code: 'RATE_LIMIT' }); assert.equal(calls, 1);
});
test('failed local completion write leaves record retryable for remote reconciliation', async () => {
  let calls = 0;
  const f = setup({ verify: async () => {}, sync: async () => ({ state: ++calls === 1 ? 'committed' : 'duplicate', path: 'path', commit: 'a'.repeat(40) }) });
  await f.service.configure(config);
  const set = f.local.set; f.local.set = async () => { throw new Error('quota'); };
  await assert.rejects(f.service.syncNext(), { code: 'STORAGE' });
  f.local.set = set;
  assert.equal((await f.restart().syncNext()).state, 'duplicate');
  assert.equal(f.local.data[GH_STATE].completed.length, 1);
});
test('browser session token loss requires verification before further syncing', async () => {
  const f = setup(); await f.service.configure(config); await f.session.remove(GH_TOKEN);
  assert.equal((await f.service.status()).tokenConfigured, false);
  await assert.rejects(f.service.syncNext(), { code: 'CONFIG' });
});

test('failed replacement token write cannot change the saved repository', async () => {
  const f = setup(); await f.service.configure(config);
  f.session.set = async () => { throw new Error('session storage failed'); };
  f.session.remove = async () => { throw new Error('session cleanup also failed'); };
  await assert.rejects(f.service.configure({ ...config, repo: 'different' }));
  assert.equal(f.local.data[GH_CONFIG].repo, config.repo);
});

test('partial target save leaves mismatched credential unusable', async () => {
  const f = setup(); await f.service.configure(config);
  const set = f.local.set;
  f.local.set = async value => { if (value[GH_CONFIG]) throw new Error('local target write failed'); return set(value); };
  await assert.rejects(f.service.configure({ ...config, repo: 'different' }));
  assert.equal((await f.service.status()).tokenConfigured, false);
  await assert.rejects(f.service.syncNext(), { code: 'CONFIG' });
});
test('stale popup target cannot sync to a newly configured repository', async () => {
  let calls = 0;
  const f = setup({ verify: async () => {}, sync: async () => { calls++; } });
  await f.service.configure(config);
  await assert.rejects(f.service.syncNext({ ...config, repo: 'stale' }), { code: 'CONFIG' });
  assert.equal(calls, 0);
});
