/* Runs only in Chrome's isolated world on https://leetcode.com/*. */
(() => {
  'use strict';
  const { createClient, createTracker, problemSlug } = globalThis.CommitFlowLeetCode;
  const csrf = () => document.cookie.split('; ').find(v => v.startsWith('csrftoken='))?.slice(10) || '';
  const client = createClient(fetch.bind(globalThis), csrf);
  const tracker = createTracker({ client, emit: async record => {
    const reply = await chrome.runtime.sendMessage({ namespace: 'commitflow', type: 'LEETCODE_ACCEPTED', record });
    if (!reply?.ok) throw new Error('CommitFlow could not persist the submission.');
  } });
  let delay = 5000;
  let stopped = false;
  async function poll() {
    if (stopped) return;
    try {
      if (!document.hidden) await tracker.tick(problemSlug(location.href));
      delay = 5000;
    } catch (error) {
      // Never log source code, cookies, API bodies or credentials.
      console.warn('[CommitFlow]', error.code || 'DELIVERY', error.message);
      if (['AUTH', 'SCHEMA', 'LIMIT'].includes(error.code)) {
        stopped = true; // Fail closed. Sign in/repair adapter, then reload.
        return;
      }
      delay = error.code === 'RATE_LIMIT' ? 60000 : Math.min(delay * 2, 60000);
    }
    setTimeout(poll, delay);
  }
  // URL sampled on each tick handles same-document SPA navigation without page hooks.
  void poll();
})();
