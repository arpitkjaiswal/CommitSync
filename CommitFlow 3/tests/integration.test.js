import test from 'node:test';
import assert from 'node:assert/strict';
import { environment, CONFIG, TOKEN, flush } from './helpers/integration-harness.js';
import { GH_STATE } from '../github-service.js';
import { SUBMISSIONS_KEY } from '../submissions.js';
async function prepared() {
  const e = environment(); assert.equal((await e.send('GH_CONFIGURE', { config: CONFIG })).ok, true);
  e.lc.status = 10; e.startContent(); await flush();
  assert.equal(e.local.data[SUBMISSIONS_KEY]?.records.length, 1); return e;
}
test('E2E delayed judging → duplicate tab events → concurrent sync → restart: one commit, preserved files, no leaked token', async () => {
  const e = environment(); const tab = e.startContent(); await flush();
  assert.equal(e.local.data[SUBMISSIONS_KEY], undefined);
  await tab.tick(); assert.equal(e.local.data[SUBMISSIONS_KEY], undefined);
  e.lc.status = 10; await tab.tick(); e.startContent(); await flush();
  assert.equal(e.local.data[SUBMISSIONS_KEY].records.length, 1);
  assert.equal((await e.send('GH_CONFIGURE', { config: CONFIG })).ok, true);
  const results = await Promise.all([e.send('GH_SYNC'), e.send('GH_SYNC')]);
  assert.ok(results.every(r => r.ok)); assert.equal(e.github.committed, 1);
  e.restart(); assert.equal((await e.send('GH_SYNC')).data.state, 'idle');
  assert.ok(e.github.files['README.md']); assert.equal(e.github.source['solutions/two-sum/javascript/123.js'], e.lc.code);
  assert.ok(e.github.calls.filter(r => r.method === 'PATCH').every(r => r.body.force === false));
  for (const value of [e.local.data, e.replies, e.contentMessages, e.logs, e.lcRequests]) assert.equal(JSON.stringify(value).includes(TOKEN), false);
  for (const type of ['GH_STATUS', 'GH_SYNC', 'GH_CONFIGURE', 'GH_DISCONNECT']) assert.equal((await e.send(type, {}, e.content)).ok, false);
});
test('E2E rejected submissions never reach storage or GitHub', async () => {
  const e = environment(); e.lc.status = 11; const tab = e.startContent(); await flush(); await tab.tick();
  await e.send('GH_CONFIGURE', { config: CONFIG });
  assert.equal((await e.send('GH_SYNC')).data.state, 'idle'); assert.equal(e.github.committed, 0); assert.equal(e.contentMessages.length, 0);
});
test('E2E expired LeetCode session stops polling without capture', async () => {
  const e = environment(); e.lc.http = 401; const tab = e.startContent(); await flush();
  assert.equal(tab.timers.size, 0); assert.equal(e.contentMessages.length, 0); assert.equal(e.github.committed, 0);
  assert.equal(e.logs[0][1], 'AUTH');
});
test('E2E network failure backs off, delayed judging resumes and upload retries', async () => {
  const e = environment(); e.lc.failures = 1; const tab = e.startContent(); await flush();
  assert.equal([...tab.timers.values()][0].ms, 10000);
  e.lc.status = 10; await tab.tick(); await e.send('GH_CONFIGURE', { config: CONFIG });
  e.github.faults.push({ path: '', network: true });
  assert.equal((await e.send('GH_SYNC')).ok, true); assert.deepEqual(e.waits, [500]); assert.equal(e.github.committed, 1);
});
for (const [status, code, path] of [[401,'AUTH',''], [403,'PERMISSION',''], [409,'CONFLICT','/git/refs/heads/main'], [422,'CONFLICT','/git/refs/heads/main'], [429,'RATE_LIMIT','']]) {
  test(`E2E GitHub ${status} is safe and retryable after correction`, async () => {
    const e = await prepared(); e.github.faults.push({ path, status, headers: status === 429 ? { 'retry-after': '60' } : {} });
    const failed = await e.send('GH_SYNC'); assert.equal(failed.ok, false); assert.equal(failed.code, code); assert.equal(e.github.committed, 0);
    assert.equal(JSON.stringify(failed).includes(TOKEN), false);
    if (status === 429) {
      const calls = e.github.calls.length; e.restart(); assert.equal((await e.send('GH_SYNC')).code, 'RATE_LIMIT'); assert.equal(e.github.calls.length, calls);
      e.local.data[GH_STATE].last.retryAt = Date.now()-1; // Model elapsed cooldown without sleeping.
    }
    assert.equal((await e.send('GH_SYNC')).ok, true); assert.equal(e.github.committed, 1);
    assert.ok(e.github.calls.filter(r=>r.method==='PATCH').every(r=>r.body.force===false));
  });
}
test('E2E lost successful PATCH response and lost local ledger survive worker restart without duplicate commits', async () => {
  const e = await prepared(); e.github.faults.push({ path: '/git/refs/heads/main', afterApply: true });
  assert.equal((await e.send('GH_SYNC')).data.state, 'reconciled'); assert.equal(e.github.committed, 1);
  delete e.local.data[GH_STATE]; e.restart();
  assert.equal((await e.send('GH_SYNC')).data.state, 'duplicate'); assert.equal(e.github.committed, 1);
});
test('E2E initialization race queues requests until both storage restrictions finish', async () => {
  const e = environment(); let release;
  e.session.setAccessLevel = () => new Promise(r => { release = r; }); e.restart();
  let done = false; const pending = e.send('GH_CONFIGURE', { config: CONFIG }).then(r => { done = true; return r; });
  await flush(); assert.equal(done, false); assert.equal(e.github.calls.length, 0);
  release(); assert.equal((await pending).ok, true);
});
test('E2E synchronous storage-isolation exception must fail closed', async () => {
  const e = environment(); e.session.setAccessLevel = () => { throw new Error('sync API failure'); };
  assert.doesNotThrow(() => e.restart());
  assert.equal((await e.send('GH_CONFIGURE', { config: CONFIG })).ok, false);
  assert.equal(e.github.calls.length, 0);
});

test('E2E protected-branch 403 does not update ref or force-push', async () => {
  const e = await prepared(); e.github.faults.push({ path: '/git/refs/heads/main', status: 403 });
  const result = await e.send('GH_SYNC');
  assert.equal(result.code, 'PERMISSION'); assert.equal(e.github.committed, 0);
  assert.equal(e.github.calls.filter(c => c.method === 'PATCH').length, 1);
  assert.ok(e.github.calls.filter(c => c.method === 'PATCH').every(c => c.body.force === false));
  assert.equal(JSON.stringify([e.replies, e.logs]).includes(TOKEN), false);
});
test('E2E expired LeetCode 403 stops before any GitHub operation', async () => {
  const e = environment(); e.lc.http = 403; const tab = e.startContent(); await flush();
  assert.equal(tab.timers.size, 0); assert.equal(e.contentMessages.length, 0); assert.equal(e.github.calls.length, 0);
});
