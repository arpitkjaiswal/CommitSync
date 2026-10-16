import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../content.js', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
function boot(error, hidden = false) {
  const timers = []; const warnings = []; let ticks = 0;
  vm.runInNewContext(source, {
    CommitFlowLeetCode: { createClient: () => ({}), problemSlug: () => 'two-sum', createTracker: () => ({ async tick() { ticks++; if (error) throw error; } }) },
    document: { cookie: '', hidden }, location: { href: 'https://leetcode.com/problems/two-sum/' },
    fetch() {}, chrome: { runtime: {} }, console: { warn: (...args) => warnings.push(args) },
    setTimeout: (fn, ms) => timers.push({ fn, ms })
  });
  return { timers, warnings, get ticks() { return ticks; } };
}
test('content scheduler pauses hidden pages and retries transient/rate-limit failures', async () => {
  const hidden = boot(null, true); await flush(); assert.equal(hidden.ticks, 0); assert.equal(hidden.timers[0].ms, 5000);
  const network = boot({ code: 'NETWORK', message: 'offline' }); await flush(); assert.equal(network.timers[0].ms, 10000);
  const rate = boot({ code: 'RATE_LIMIT', message: 'wait' }); await flush(); assert.equal(rate.timers[0].ms, 60000);
});
test('content scheduler stops on authentication and schema errors instead of retry storms', async () => {
  for (const code of ['AUTH', 'SCHEMA']) {
    const run = boot({ code, message: 'reload required' }); await flush();
    assert.equal(run.timers.length, 0); assert.equal(run.warnings.length, 1);
  }
});
