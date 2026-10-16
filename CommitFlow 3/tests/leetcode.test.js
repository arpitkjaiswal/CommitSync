import test from 'node:test';
import assert from 'node:assert/strict';
import '../leetcode.js';
import { saveAccepted, isLeetCodeSender, SUBMISSIONS_KEY } from '../submissions.js';
const { createClient, createTracker, problemSlug, validateAccepted } = globalThis.CommitFlowLeetCode;
const seconds = Math.floor(Date.now() / 1000);
const record = { submissionId: '123', problemSlug: 'two-sum', title: 'Two Sum', language: 'JavaScript', timestamp: seconds, sourceCode: 'return [0, 1];', statusCode: 10, verdict: 'Accepted' };
const detail = { id: 123, statusCode: 10, timestamp: String(seconds), code: record.sourceCode, lang: { name: 'JavaScript' }, question: { title: 'Two Sum', titleSlug: 'two-sum' } };
const list = rows => ({ userStatus: { isSignedIn: true, username: 'tester' }, submissionList: { submissions: rows } });
const response = (data, status = 200) => ({ ok: status === 200, status, json: async () => ({ data }) });
const clientFor = data => createClient(async () => response({ question: { title: 'Two Sum', titleSlug: 'two-sum' }, ...data }));

test('problem URL parsing restricts exact HTTPS origin and supports SPA paths', () => {
  assert.equal(problemSlug('https://leetcode.com/problems/two-sum/submissions/123/'), 'two-sum');
  for (const url of ['https://leetcode.com.evil.test/problems/a/', 'http://leetcode.com/problems/a/', 'https://leetcode.com/discuss/', 'bad']) assert.equal(problemSlug(url), null);
});
test('GraphQL requests use same-origin cookies and CSRF, and retrieve exact Accepted fields', async () => {
  let options;
  const client = createClient(async (url, opts) => {
    assert.equal(url, 'https://leetcode.com/graphql/'); options = opts;
    return response({ submissionDetails: detail, question: { title: 'Two Sum', titleSlug: 'two-sum' } });
  }, () => 'csrf-only');
  const result = await client.detail('123', 'two-sum');
  assert.deepEqual(result, { state: 'accepted', record });
  assert.equal(options.credentials, 'same-origin');
  assert.equal(options.redirect, 'error');
  assert.equal(options.headers['x-csrftoken'], 'csrf-only');
  assert.deepEqual(JSON.parse(options.body).variables, { id: 123, slug: 'two-sum' });
  assert.equal(options.headers.Authorization, undefined);
});
test('list validates account, IDs, pending flag and timestamp', async () => {
  const result = await clientFor(list([{ id: 123, timestamp: String(seconds), statusDisplay: 'Judging' }])).list('two-sum');
  assert.deepEqual(result.rows, [{ id: '123', timestamp: seconds, pending: true }]);
  for (const data of [list([{}]), list([{ id: '123', timestamp: seconds }]), {}, { userStatus: { isSignedIn: true, username: 'a' }, submissionList: null }]) {
    await assert.rejects(clientFor(data).list('two-sum'), { code: 'SCHEMA' });
  }
  await assert.rejects(clientFor({ userStatus: { isSignedIn: false } }).list('two-sum'), { code: 'AUTH' });
});
test('pending/null details wait; all known rejected verdicts emit no record', async () => {
  for (const d of [null, { ...detail, statusCode: 0 }]) assert.equal((await clientFor({ submissionDetails: d }).detail('123', 'two-sum')).state, 'pending');
  for (const statusCode of [11, 12, 13, 14, 15, 16, 20]) {
    assert.deepEqual(await clientFor({ submissionDetails: { ...detail, statusCode } }).detail('123', 'two-sum'), { state: 'rejected' });
  }
});
test('unknown verdict, wrong slug and missing Accepted metadata fail closed', async () => {
  for (const d of [{ ...detail, statusCode: 99 }, { ...detail, statusCode: '10' }, { ...detail, code: undefined }, { ...detail, lang: {} }, { ...detail, question: { title: 'Other', titleSlug: 'other' } }]) {
    await assert.rejects(clientFor({ submissionDetails: d }).detail('123', 'two-sum'), { code: 'SCHEMA' });
  }
  await assert.rejects(clientFor({}).detail('2147483648', 'two-sum'), { code: 'SCHEMA' });
  assert.throws(() => validateAccepted({ ...record, verdict: 'Wrong Answer' }));
  assert.throws(() => validateAccepted({ ...record, sourceCode: 'a'.repeat(200001) }));
});
for (const [status, code] of [[401, 'AUTH'], [403, 'AUTH'], [429, 'RATE_LIMIT'], [500, 'NETWORK']]) {
  test(`HTTP ${status} has classified error`, async () => {
    await assert.rejects(createClient(async () => response(null, status)).list('two-sum'), { code });
  });
}
test('network failure, HTML challenge and GraphQL schema/auth errors are classified', async () => {
  await assert.rejects(createClient(async () => { throw new Error('offline'); }).list('two-sum'), { code: 'NETWORK' });
  await assert.rejects(createClient(async () => ({ ok: true, json: async () => { throw new Error('HTML'); } })).list('two-sum'), { code: 'SCHEMA' });
  for (const [errors, code] of [[[{ message: 'unknown field' }], 'SCHEMA'], [[{ extensions: { code: 'UNAUTHENTICATED' } }], 'AUTH']]) {
    await assert.rejects(createClient(async () => ({ ok: true, json: async () => ({ errors }) })).list('two-sum'), { code });
  }
});
test('hung request is aborted by timeout', async () => {
  const client = createClient((url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')));
  }), () => '', 5);
  await assert.rejects(client.list('two-sum'), { code: 'NETWORK' });
});

function trackerFixture() {
  let clock = seconds * 1000;
  let account = 'tester';
  let rows = [];
  let state = 'pending';
  let calls = 0;
  const emitted = [];
  const client = {
    async list() { return { account, rows }; },
    async detail() { calls++; return { state, record }; }
  };
  const tracker = createTracker({ client, now: () => clock, emit: async r => emitted.push(r) });
  return { tracker, client, emitted, get calls() { return calls; }, setRows: r => { rows = r; }, setState: s => { state = s; }, advance: ms => { clock += ms; }, account: a => { account = a; } };
}
test('ignores historical completed submissions; waits for delayed judging; emits only once', async () => {
  const f = trackerFixture();
  f.setRows([{ id: 'old', timestamp: seconds - 10, pending: false }]);
  await f.tracker.tick('two-sum'); assert.equal(f.calls, 0);
  f.setRows([{ id: '123', timestamp: seconds, pending: true }]);
  await f.tracker.tick('two-sum'); assert.equal(f.emitted.length, 0);
  f.setState('accepted');
  await f.tracker.tick('two-sum'); await f.tracker.tick('two-sum');
  assert.deepEqual(f.emitted, [record]);
});
test('new rejected submissions never reach emit', async () => {
  const f = trackerFixture(); f.setRows([{ id: '123', timestamp: seconds, pending: false }]); f.setState('rejected');
  await f.tracker.tick('two-sum'); await f.tracker.tick('two-sum');
  assert.equal(f.emitted.length, 0); assert.equal(f.calls, 1);
});
test('failed delivery retries instead of dropping Accepted event', async () => {
  let attempts = 0;
  const tracker = createTracker({ now: () => seconds * 1000,
    client: { list: async () => ({ account: 'a', rows: [{ id: '123', timestamp: seconds, pending: false }] }), detail: async () => ({ state: 'accepted', record }) },
    emit: async () => { if (++attempts === 1) throw new Error('worker unavailable'); }
  });
  await assert.rejects(tracker.tick('two-sum')); await tracker.tick('two-sum'); await tracker.tick('two-sum');
  assert.equal(attempts, 2);
});
test('pending retrieval expires and account change discards old pending work', async () => {
  const f = trackerFixture(); f.setRows([{ id: '123', timestamp: seconds, pending: true }]);
  await f.tracker.tick('two-sum'); f.advance(16 * 60000);
  await assert.rejects(f.tracker.tick('two-sum'), { code: 'TIMEOUT' });
  f.account('other'); f.setRows([]); f.setState('accepted');
  await f.tracker.tick('two-sum'); assert.equal(f.emitted.length, 0);
});
test('overlapping polling ticks do not start concurrent requests', async () => {
  let release; let calls = 0;
  const tracker = createTracker({ client: { list: () => { calls++; return new Promise(r => { release = r; }); } }, emit: async () => {} });
  const first = tracker.tick('two-sum'); await tracker.tick('two-sum');
  assert.equal(calls, 1); release({ account: 'a', rows: [] }); await first;
});
test('worker validates exact origin, tab and frame; no popup access for content sender', () => {
  const sender = { id: 'ext', url: 'https://leetcode.com/problems/two-sum/', tab: { id: 1 }, frameId: 0 };
  assert.equal(isLeetCodeSender(sender, 'ext'), true);
  for (const bad of [{ ...sender, id: 'other' }, { ...sender, frameId: 1 }, { ...sender, url: 'https://leetcode.com.evil.test/' }, { ...sender, tab: undefined }]) assert.equal(isLeetCodeSender(bad, 'ext'), false);
});
test('persistent deduplication survives store reuse; failed writes can be retried', async () => {
  let data = {}; let fail = true;
  const storage = { get: async () => data, set: async value => { if (fail) throw new Error('quota'); data = value; } };
  await assert.rejects(saveAccepted(storage, record)); fail = false;
  assert.equal((await saveAccepted(storage, record)).duplicate, false);
  assert.equal((await saveAccepted(storage, record)).duplicate, true);
  assert.equal(data[SUBMISSIONS_KEY].records.length, 1);
  await assert.rejects(saveAccepted(storage, { ...record, statusCode: 11 }));
});
