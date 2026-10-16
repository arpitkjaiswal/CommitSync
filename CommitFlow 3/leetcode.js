/* Shared classic script for isolated content scripts; side-effect import in worker/tests.
 * All GraphQL fields below are UNDOCUMENTED LeetCode website dependencies. */
(() => {
  'use strict';
  class IntegrationError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }
  const fail = (code, message) => { throw new IntegrationError(code, message); };
  const text = (x, max) => typeof x === 'string' && x.length > 0 && x.length <= max;
  const idOK = x => typeof x === 'string' && /^[1-9]\d{0,14}$/.test(x) && Number.isSafeInteger(Number(x));
  const slugOK = x => typeof x === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(x) && x.length <= 200;
  const timestamp = value => {
    if (!(typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value)))) fail('SCHEMA', 'Invalid submission timestamp.');
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 946684800 || n > Math.floor(Date.now() / 1000) + 300) fail('SCHEMA', 'Invalid submission timestamp.');
    return n;
  };
  function problemSlug(url) {
    try { const u = new URL(url); const m = u.pathname.match(/^\/problems\/([a-z0-9-]+)(?:\/|$)/); return u.origin === 'https://leetcode.com' && m && slugOK(m[1]) ? m[1] : null; }
    catch { return null; }
  }
  const LIST_QUERY = `query CommitFlowSubmissions($slug: String!) {
    userStatus { isSignedIn username }
    submissionList(offset: 0, limit: 20, questionSlug: $slug) {
      submissions { id timestamp statusDisplay }
    }
  }`;
  const DETAIL_QUERY = `query CommitFlowDetail($id: Int!, $slug: String!) {
    submissionDetails(submissionId: $id) {
      statusCode timestamp code
      lang { name }
      question { titleSlug }
    }
    question(titleSlug: $slug) { title titleSlug }
  }`;
  function createClient(fetchFn, csrf = () => '', timeoutMs = 15000) {
    async function query(query, variables) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const token = csrf();
        const response = await fetchFn('https://leetcode.com/graphql/', {
          method: 'POST', credentials: 'same-origin', redirect: 'error',
          headers: { 'Content-Type': 'application/json', ...(token ? { 'x-csrftoken': token } : {}) },
          body: JSON.stringify({ query, variables }), signal: controller.signal
        });
        if ([401, 403].includes(response.status)) fail('AUTH', 'Sign in to LeetCode or resolve its access challenge, then reload the page.');
        if (response.status === 429) fail('RATE_LIMIT', 'LeetCode rate limited requests; waiting before retrying.');
        if (!response.ok) fail('NETWORK', 'LeetCode request failed.');
        let body;
        try { body = await response.json(); } catch { fail('SCHEMA', 'LeetCode returned non-JSON data (possibly an access challenge).'); }
        if (body?.errors !== undefined && !Array.isArray(body.errors)) fail('SCHEMA', 'Malformed GraphQL errors.');
        if (body?.errors?.length) {
          const auth = body.errors.some(e => ['UNAUTHENTICATED', 'FORBIDDEN'].includes(e?.extensions?.code));
          fail(auth ? 'AUTH' : 'SCHEMA', auth ? 'LeetCode authentication required.' : 'LeetCode GraphQL query failed; schema may have changed.');
        }
        if (!body?.data || typeof body.data !== 'object') fail('SCHEMA', 'Missing LeetCode GraphQL data.');
        return body.data;
      } catch (error) {
        if (error instanceof IntegrationError) throw error;
        fail('NETWORK', 'LeetCode request timed out or could not connect.');
      } finally { clearTimeout(timer); }
    }
    return {
      async list(slug) {
        if (!slugOK(slug)) fail('SCHEMA', 'Invalid problem slug.');
        const data = await query(LIST_QUERY, { slug });
        if (data.userStatus?.isSignedIn === false) fail('AUTH', 'Sign in to LeetCode and reload the page.');
        if (data.userStatus?.isSignedIn !== true || !text(data.userStatus.username, 100)) fail('SCHEMA', 'Missing signed-in account information.');
        const rows = data.submissionList?.submissions;
        if (!Array.isArray(rows) || rows.length > 20) fail('SCHEMA', 'Submission list schema changed.');
        return { account: data.userStatus.username, rows: rows.map(row => {
          const id = String(row?.id ?? '');
          if (!idOK(id) || !text(row.statusDisplay, 100)) fail('SCHEMA', 'Submission row schema changed.');
          return { id, timestamp: timestamp(row.timestamp), pending: ['Pending', 'Judging', 'Started'].includes(row.statusDisplay) };
        }) };
      },
      async detail(id, slug) {
        // GraphQL Int is signed 32-bit. Fail explicitly if LeetCode outgrows it.
        if (!idOK(id) || Number(id) > 2147483647) fail('SCHEMA', 'Submission ID exceeds the undocumented GraphQL Int contract.');
        const data = await query(DETAIL_QUERY, { id: Number(id), slug });
        const d = data.submissionDetails;
        if (d === null) return { state: 'pending' }; // eventual consistency; bounded by tracker
        if (!d || !Number.isInteger(d.statusCode)) fail('SCHEMA', 'Submission detail schema changed.');
        if (d.statusCode === 0) return { state: 'pending' };
        // Known terminal non-Accepted outcomes. Never emit their source code.
        if ([11, 12, 13, 14, 15, 16, 20].includes(d.statusCode)) return { state: 'rejected' };
        if (d.statusCode !== 10) fail('SCHEMA', 'Unrecognized LeetCode verdict code.');
        if (d.code === null || d.lang === null || d.question === null || data.question === null) return { state: 'pending' };
        if (data.question?.titleSlug !== slug) fail('SCHEMA', 'Problem metadata does not match.');
        const record = validateAccepted({ submissionId: id, problemSlug: d.question?.titleSlug,
          title: data.question?.title, language: d.lang?.name, timestamp: timestamp(d.timestamp),
          sourceCode: d.code, verdict: 'Accepted', statusCode: d.statusCode });
        if (record.problemSlug !== slug) fail('SCHEMA', 'Submission problem does not match the requested problem.');
        return { state: 'accepted', record };
      }
    };
  }
  function validateAccepted(r) {
    if (!r || !idOK(r.submissionId) || !slugOK(r.problemSlug) || !text(r.title, 300) ||
        !text(r.language, 100) || !text(r.sourceCode, 200000) || r.verdict !== 'Accepted' || r.statusCode !== 10) {
      fail('SCHEMA', 'Invalid Accepted submission payload.');
    }
    return { submissionId: r.submissionId, problemSlug: r.problemSlug, title: r.title,
      language: r.language, timestamp: timestamp(r.timestamp), sourceCode: r.sourceCode,
      verdict: 'Accepted', statusCode: 10 };
  }
  function createTracker({ client, emit, now = Date.now }) {
    const started = Math.floor(now() / 1000);
    let account = null;
    let since = started;
    let busy = false;
    const done = new Set();
    const pending = new Map();
    return {
      async tick(slug) {
        if (busy || !slug) return;
        busy = true;
        try {
          const batch = await client.list(slug);
          if (account !== null && account !== batch.account) {
            done.clear(); pending.clear(); since = Math.floor(now() / 1000);
          }
          account = batch.account;
          for (const row of batch.rows) {
            if (done.has(row.id) || pending.has(row.id)) continue;
            // Only new submissions since observation began; pending older work can complete now.
            if (row.timestamp < since && !row.pending) continue;
            pending.set(row.id, { slug, attempts: 0, created: now() });
          }
          if (pending.size > 100) fail('LIMIT', 'Too many pending submissions. Reload to resume.');
          let processed = 0;
          for (const [id, entry] of pending) {
            if (processed++ >= 3) break;
            if (entry.attempts >= 30 || now() - entry.created > 15 * 60 * 1000) {
              pending.delete(id); done.add(id);
              fail('TIMEOUT', 'Submission judging/retrieval exceeded its retry window.');
            }
            entry.attempts++;
            const result = await client.detail(id, entry.slug);
            if (result.state === 'pending') continue;
            if (result.state === 'accepted') await emit(result.record);
            pending.delete(id); done.add(id);
          }
          // Session-only cache bounded; durable deduplication lives in the worker.
          while (done.size > 1000) done.delete(done.values().next().value);
        } finally { busy = false; }
      }
    };
  }
  globalThis.CommitFlowLeetCode = Object.freeze({ IntegrationError, problemSlug, createClient, createTracker, validateAccepted });
})();
