import './leetcode.js';
const { validateAccepted } = globalThis.CommitFlowLeetCode;
export class GitHubError extends Error {
  constructor(code, message, retryAt = 0) { super(message); this.code = code; this.retryAt = retryAt; }
}
const fail = (code, message) => { throw new GitHubError(code, message); };
const shaOK = x => typeof x === 'string' && /^[a-f0-9]{40}$/.test(x);
const sha = x => { if (!shaOK(x)) fail('SCHEMA', 'Unexpected GitHub object response.'); return x; };
export function validateGitHubConfig(value) {
  if (!value || typeof value !== 'object' || typeof value.owner !== 'string' || typeof value.repo !== 'string' ||
      !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(value.owner || '') ||
      !/^[A-Za-z0-9_.-]{1,100}$/.test(value.repo || '') || ['.', '..'].includes(value.repo) ||
      typeof value.branch !== 'string' || value.branch.length > 200 ||
      !/^[A-Za-z0-9_/-]+(?:\.[A-Za-z0-9_/-]+)*$/.test(value.branch) ||
      value.branch.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock')) ||
      value.branch.includes('..') || value.branch.startsWith('-') ||
      typeof value.token !== 'string' || !/^github_pat_[A-Za-z0-9_]{20,245}$/.test(value.token)) {
    fail('CONFIG', 'Enter a fine-grained PAT, repository owner/name and a valid branch.');
  }
  return { owner: value.owner, repo: value.repo, branch: value.branch, token: value.token };
}
const LANGUAGES = {
  'c++': ['cpp', 'cpp'], cpp: ['cpp', 'cpp'], java: ['java', 'java'],
  python: ['python', 'py'], python3: ['python3', 'py'], 'python 3': ['python3', 'py'],
  c: ['c', 'c'], 'c#': ['csharp', 'cs'], csharp: ['csharp', 'cs'],
  javascript: ['javascript', 'js'], typescript: ['typescript', 'ts'],
  ruby: ['ruby', 'rb'], swift: ['swift', 'swift'], go: ['go', 'go'], golang: ['go', 'go'],
  scala: ['scala', 'scala'], kotlin: ['kotlin', 'kt'], rust: ['rust', 'rs'],
  php: ['php', 'php'], dart: ['dart', 'dart'], racket: ['racket', 'rkt'],
  erlang: ['erlang', 'erl'], elixir: ['elixir', 'ex'], mysql: ['mysql', 'sql'],
  mssql: ['mssql', 'sql'], oraclesql: ['oraclesql', 'sql'], postgresql: ['postgresql', 'sql'],
  bash: ['bash', 'sh'], pandas: ['pandas', 'py']
};
export function solutionPath(value) {
  const r = validateAccepted(value);
  const key = r.language.toLowerCase();
  const language = Object.hasOwn(LANGUAGES, key) ? LANGUAGES[key] : null;
  if (!language) fail('LANGUAGE', 'Unsupported programming language; update the language map before syncing.');
  return `solutions/${r.problemSlug}/${language[0]}/${r.submissionId}.${language[1]}`;
}
export async function gitBlobSHA(content) {
  const bytes = new TextEncoder().encode(content);
  const prefix = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const input = new Uint8Array(prefix.length + bytes.length);
  input.set(prefix); input.set(bytes, prefix.length);
  const hash = await crypto.subtle.digest('SHA-1', input);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export function createGitHubAdapter(config, {
  fetchFn = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now,
  timeoutMs = 15000
} = {}) {
  const c = validateGitHubConfig(config);
  const base = `https://api.github.com/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}`;
  const refPath = `heads/${c.branch.split('/').map(encodeURIComponent).join('/')}`;
  async function request(method, path, body, retrySafe = true) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let problem;
      try {
        const res = await fetchFn(base + path, {
          method, redirect: 'error', cache: 'no-store', signal: controller.signal,
          headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${c.token}`,
            'X-GitHub-Api-Version': '2026-03-10', 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) })
        });
        let data;
        try { data = await res.json(); } catch { data = null; }
        const after = res.headers.get('retry-after');
        const remaining = res.headers.get('x-ratelimit-remaining');
        const limited = res.status === 429 || (res.status === 403 &&
          (after !== null || remaining === '0' || /rate limit|secondary rate/i.test(data?.message || '')));
        if (limited) {
          const retrySeconds = after !== null && /^\d+$/.test(after) ? Number(after) * 1000 : 0;
          const retryDate = after !== null && !/^\d+$/.test(after) ? Date.parse(after) : 0;
          const reset = remaining === '0' ? Number(res.headers.get('x-ratelimit-reset')) * 1000 : 0;
          throw new GitHubError('RATE_LIMIT', 'GitHub rate limit reached. Retry after the displayed time.',
            Math.max(now() + 60000, now() + retrySeconds, retryDate || 0, reset || 0));
        }
        if (res.status === 401) fail('AUTH', 'GitHub token is invalid or expired. Replace it and verify again.');
        if (res.status === 403) fail('PERMISSION', 'GitHub denied access. Check Contents read/write, repository approval and branch rules.');
        if (res.status === 404) fail('NOT_FOUND', 'Repository or branch not found, or token cannot access it.');
        if ([409, 422].includes(res.status)) fail('CONFLICT', 'GitHub rejected the change. Check branch changes, repository initialization and branch rules.');
        if (res.status >= 500) throw new GitHubError('NETWORK', 'GitHub is temporarily unavailable.');
        if (!res.ok) fail('API', 'GitHub rejected the request. Check repository settings.');
        if (!data || typeof data !== 'object') fail('SCHEMA', 'GitHub returned an unexpected response.');
        return data;
      } catch (error) {
        problem = error instanceof GitHubError ? error : new GitHubError('NETWORK', 'GitHub request failed or timed out.');
      } finally { clearTimeout(timer); }
      if (!retrySafe || problem.code !== 'NETWORK' || attempt === 2) throw problem;
      await sleep(500 * 2 ** attempt);
    }
  }
  async function head() {
    const data = await request('GET', `/git/ref/${refPath}`);
    if (data.ref !== `refs/heads/${c.branch}` || data.object?.type !== 'commit') fail('SCHEMA', 'Unexpected branch reference.');
    return sha(data.object.sha);
  }
  async function verify() {
    const repo = await request('GET', '');
    if (repo.archived || repo.disabled) fail('PERMISSION', 'Repository is archived or disabled.');
    if (repo.permissions?.push === false) fail('PERMISSION', 'Your GitHub account cannot push to this repository.');
    // A user push flag is not proof of the PAT's Contents permission.
    // Inspect actual branches, then verify write access by creating an unattached blob.
    const branches = await request('GET', '/branches?per_page=1');
    if (!Array.isArray(branches)) fail('SCHEMA', 'Unexpected repository branches response.');
    if (!branches.length) fail('EMPTY_REPOSITORY', 'Initialize the repository with a README on GitHub, then verify again.');
    const current = await head();
    const probe = await request('POST', '/git/blobs', { content: 'CommitFlow permission verification\n', encoding: 'utf-8' });
    sha(probe.sha);
    return { head: current, owner: c.owner, repo: c.repo, branch: c.branch };
  }
  async function rootTree(commit) {
    return sha((await request('GET', `/git/commits/${sha(commit)}`)).tree?.sha);
  }
  async function entryAt(root, path) {
    let tree = root;
    const parts = path.split('/');
    for (let i = 0; i < parts.length; i++) {
      const data = await request('GET', `/git/trees/${sha(tree)}`);
      if (!Array.isArray(data.tree) || data.truncated !== false) fail('SCHEMA', 'Cannot safely inspect the complete Git tree.');
      const entry = data.tree.find(e => e.path === parts[i]);
      if (!entry) return null;
      sha(entry.sha);
      if (i === parts.length - 1) return entry;
      if (entry.type !== 'tree' || entry.mode !== '040000') fail('PATH_CONFLICT', 'A solution directory is occupied by an existing file or link.');
      tree = entry.sha;
    }
  }
  function checkExisting(entry, expected) {
    if (!entry) return false;
    if (entry.type === 'blob' && entry.mode === '100644' && entry.sha === expected) return true;
    fail('PATH_CONFLICT', 'The solution path already contains different content. No files were overwritten.');
  }
  async function sync(value) {
    const r = validateAccepted(value);
    const path = solutionPath(r);
    const expected = await gitBlobSHA(r.sourceCode);
    const initial = (await verify()).head;
    const root = await rootTree(initial);
    if (checkExisting(await entryAt(root, path), expected)) return { state: 'duplicate', path, commit: initial };
    const blob = await request('POST', '/git/blobs', { content: r.sourceCode, encoding: 'utf-8' });
    if (sha(blob.sha) !== expected) fail('SCHEMA', 'GitHub source blob does not match the submitted code.');
    const tree = await request('POST', '/git/trees', { base_tree: root,
      tree: [{ path, mode: '100644', type: 'blob', sha: blob.sha }] });
    const commit = await request('POST', '/git/commits', {
      message: `Add ${r.problemSlug} (${r.language}) submission ${r.submissionId}`,
      tree: sha(tree.sha), parents: [initial]
    });
    const target = sha(commit.sha);
    // Detect an observed concurrent advance before trying the atomic fast-forward guard.
    if (await head() !== initial) fail('CONFLICT', 'Branch changed during sync. Retry to rebuild on its new head.');
    try {
      const updated = await request('PATCH', `/git/refs/${refPath}`, { sha: target, force: false }, false);
      if (updated.object?.sha !== target) fail('SCHEMA', 'Unexpected branch update response.');
      return { state: 'committed', path, commit: target };
    } catch (error) {
      // A lost PATCH response may hide a successful update. Re-read before retrying.
      if (['NETWORK', 'CONFLICT', 'SCHEMA'].includes(error.code)) {
        const current = await head();
        if (checkExisting(await entryAt(await rootTree(current), path), expected)) {
          return { state: 'reconciled', path, commit: current };
        }
      }
      throw error;
    }
  }
  return { verify, sync };
}
